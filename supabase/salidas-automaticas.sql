-- Identidad y versiones automáticas. Aplicar después de consultas-operaciones,
-- importaciones, versiones-salidas y respaldos. No clasifica documentos al instalar.
begin;
alter table public.mega_audit_records add column if not exists salida_identity_tag text check(salida_identity_tag ~ '^[0-9a-f]{64}$');
alter table public.mega_audit_records add column if not exists salida_content_tag text check(salida_content_tag ~ '^[0-9a-f]{64}$');
alter table public.mega_audit_records add column if not exists salida_version integer not null default 0 check(salida_version>=0);
alter table public.mega_audit_records add column if not exists salida_previous_id uuid references public.mega_audit_records(id);
create unique index if not exists mega_salida_one_current on public.mega_audit_records(workspace_id,salida_identity_tag) where salida_identity_tag is not null and duplicate_of is null;
create index if not exists mega_salida_version_history on public.mega_audit_records(workspace_id,salida_identity_tag,salida_version,created_at,id);
create table if not exists public.mega_salidas(
 workspace_id uuid not null references public.mega_audit_workspace(id),
 identity_tag text not null check(identity_tag ~ '^[0-9a-f]{64}$'),
 current_record_id uuid references public.mega_audit_records(id),
 current_version integer not null default 0 check(current_version>=0),
 pending_id uuid unique,pending_owner uuid references auth.users(id),
 pending_content_tag text check(pending_content_tag ~ '^[0-9a-f]{64}$'),
 pending_document_tag text check(pending_document_tag ~ '^[0-9a-f]{64}$'),
 pending_at timestamptz,
 primary key(workspace_id,identity_tag)
);
alter table public.mega_salidas enable row level security;
revoke all on public.mega_salidas from public,anon,authenticated;
grant select on public.mega_salidas to authenticated;
drop policy if exists member_read on public.mega_salidas;
create policy member_read on public.mega_salidas for select to authenticated using(public.mega_audit_is_member(workspace_id));
drop policy if exists member_guard on public.mega_salidas;
create policy member_guard on public.mega_salidas as restrictive for select to authenticated using(public.mega_audit_is_member(workspace_id));
drop policy if exists anonymous_guard on public.mega_salidas;
create policy anonymous_guard on public.mega_salidas as restrictive for select to anon using(false);
drop policy if exists write_guard on public.mega_salidas;
drop policy if exists insert_guard on public.mega_salidas;
create policy insert_guard on public.mega_salidas as restrictive for insert to authenticated,anon with check(false);
drop policy if exists update_guard on public.mega_salidas;
create policy update_guard on public.mega_salidas as restrictive for update to authenticated,anon using(false) with check(false);
drop policy if exists delete_guard on public.mega_salidas;
create policy delete_guard on public.mega_salidas as restrictive for delete to authenticated,anon using(false);

create or replace function public.mega_salida_seed(p_workspace_id uuid,p_identity_tag text,p_entries jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid();v_group public.mega_salidas%rowtype;v_row public.mega_audit_records%rowtype;
 v_entry jsonb;v_rep record;v_principal uuid;v_primary_content text;v_roots integer;v_version integer:=0;v_previous uuid;v_ids uuid[];
begin
 if v_user is null or not public.mega_audit_is_member(p_workspace_id) then raise exception 'Sin acceso al equipo.' using errcode='42501';end if;
 if p_identity_tag is null or p_identity_tag !~ '^[0-9a-f]{64}$' or p_entries is null or jsonb_typeof(p_entries)<>'array' or jsonb_array_length(p_entries)>500 or length(p_entries::text)>2097152 then raise exception 'Identidad de salida inválida.' using errcode='22023';end if;
 perform 1 from public.mega_audit_workspace where id=p_workspace_id for update;
 perform 1 from public.mega_audit_members where workspace_id=p_workspace_id and user_id=v_user for update;
 if not found then raise exception 'Acceso revocado.' using errcode='42501';end if;
 insert into public.mega_salidas(workspace_id,identity_tag) values(p_workspace_id,p_identity_tag) on conflict do nothing;
 select * into v_group from public.mega_salidas where workspace_id=p_workspace_id and identity_tag=p_identity_tag for update;
 if v_group.current_record_id is not null then return jsonb_build_object('current_record_id',v_group.current_record_id,'version',v_group.current_version);end if;
 if v_group.pending_id is not null then raise exception 'Otro usuario está registrando esta salida.' using errcode='40001';end if;
 if jsonb_array_length(p_entries)=0 then return jsonb_build_object('version',0);end if;
 select array_agg((e->>'id')::uuid) into v_ids from jsonb_array_elements(p_entries) e;
 if cardinality(v_ids)<>(select count(distinct x) from unnest(v_ids) x) then raise exception 'Registros repetidos en la comparación.' using errcode='22023';end if;
 for v_entry in select value from jsonb_array_elements(p_entries) loop
  if (v_entry->>'document_tag') is null or (v_entry->>'document_tag') !~ '^[0-9a-f]{64}$' or (v_entry->>'content_tag') is null or (v_entry->>'content_tag') !~ '^[0-9a-f]{64}$' then raise exception 'Falta la comparación verificada del documento.' using errcode='22023';end if;
  select * into v_row from public.mega_audit_records where workspace_id=p_workspace_id and id=(v_entry->>'id')::uuid for update;
  if not found or v_row.document_kind<>'salida' or v_row.operation_kind='separate'
    or v_row.encrypted_metadata is distinct from v_entry->>'encrypted_metadata'
    or v_row.salida_tag is distinct from v_entry->>'salida_tag'
    or (v_row.document_tag is not null and v_row.document_tag<>v_entry->>'document_tag')
    or (v_row.salida_identity_tag is not null and v_row.salida_identity_tag<>p_identity_tag)
    or (v_row.duplicate_of is not null and not(v_row.duplicate_of=any(v_ids)))
  then raise exception 'El archivo cambió o pertenece a otra operación. Se conserva sin consolidar.' using errcode='40001';end if;
 end loop;
 select count(*) into v_roots from public.mega_audit_records where id=any(v_ids) and duplicate_of is null;
 -- Respeta una clasificación anterior que ya dejó un único principal.
 if v_roots=1 then
  select id into v_principal from public.mega_audit_records where id=any(v_ids) and duplicate_of is null;
  select e->>'content_tag' into v_primary_content from jsonb_array_elements(p_entries) e where (e->>'id')::uuid=v_principal;
 else
  -- Una reimpresión de contenido antiguo no sustituye una corrección posterior.
  select x.id,x.content into v_principal,v_primary_content from (
   select distinct on(e->>'content_tag') r.id,r.created_at,e->>'content_tag' content
   from jsonb_array_elements(p_entries) e join public.mega_audit_records r on r.id=(e->>'id')::uuid
   order by e->>'content_tag',r.created_at,r.id
  ) x order by x.created_at desc,x.id desc limit 1;
 end if;
 update public.mega_audit_records set duplicate_of=v_principal where id=any(v_ids) and id<>v_principal;
 update public.mega_audit_records set duplicate_of=null where id=v_principal;
 for v_rep in
  select x.* from (
   select distinct on(e->>'content_tag') r.id,r.created_at,e->>'content_tag' content
   from jsonb_array_elements(p_entries) e join public.mega_audit_records r on r.id=(e->>'id')::uuid
   order by e->>'content_tag',r.created_at,r.id
  ) x order by (x.content=v_primary_content),x.created_at,x.id
 loop
  v_version:=v_version+1;
  for v_entry in select value from jsonb_array_elements(p_entries) where value->>'content_tag'=v_rep.content loop
   update public.mega_audit_records set salida_identity_tag=p_identity_tag,salida_content_tag=v_rep.content,
    salida_version=v_version,salida_previous_id=v_previous,document_tag=v_entry->>'document_tag'
    where id=(v_entry->>'id')::uuid;
  end loop;
  v_previous:=case when v_rep.content=v_primary_content then v_principal else v_rep.id end;
 end loop;
 update public.mega_salidas set current_record_id=v_principal,current_version=v_version where workspace_id=p_workspace_id and identity_tag=p_identity_tag;
 return jsonb_build_object('current_record_id',v_principal,'version',v_version);
end;$$;

create or replace function public.mega_salida_prepare(p_workspace_id uuid,p_identity_tag text,p_content_tag text,p_document_tag text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid();v_group public.mega_salidas%rowtype;v_match public.mega_audit_records%rowtype;v_current public.mega_audit_records%rowtype;v_op public.mega_audit_operations%rowtype;
begin
 if v_user is null or not public.mega_audit_is_member(p_workspace_id) then raise exception 'Sin acceso al equipo.' using errcode='42501';end if;
 if p_request_id is null or p_identity_tag is null or p_identity_tag !~ '^[0-9a-f]{64}$' or p_content_tag is null or p_content_tag !~ '^[0-9a-f]{64}$' or p_document_tag is null or p_document_tag !~ '^[0-9a-f]{64}$' then raise exception 'Salida inválida.' using errcode='22023';end if;
 perform 1 from public.mega_audit_workspace where id=p_workspace_id for update;
 perform 1 from public.mega_audit_members where workspace_id=p_workspace_id and user_id=v_user for update;
 if not found then raise exception 'Acceso revocado.' using errcode='42501';end if;
 insert into public.mega_salidas(workspace_id,identity_tag) values(p_workspace_id,p_identity_tag) on conflict do nothing;
 select * into v_group from public.mega_salidas where workspace_id=p_workspace_id and identity_tag=p_identity_tag for update;
 select * into v_match from public.mega_audit_records where workspace_id=p_workspace_id and salida_identity_tag=p_identity_tag and salida_content_tag=p_content_tag order by (id=v_group.current_record_id) desc,created_at,id limit 1;
 if found then
  select * into v_current from public.mega_audit_records where id=v_group.current_record_id and workspace_id=p_workspace_id;
  return jsonb_build_object('action','existing','record',to_jsonb(v_current),'matched_record',to_jsonb(v_match));
 end if;
 if v_group.pending_id is not null then
  if v_group.pending_id=p_request_id and v_group.pending_owner=v_user then
   if v_group.pending_content_tag<>p_content_tag or v_group.pending_document_tag<>p_document_tag then raise exception 'Reintento de otra versión.' using errcode='23505';end if;
  elsif v_group.pending_at>clock_timestamp()-interval '2 minutes' then
   raise exception 'Otro usuario está registrando esta salida. Esperando su confirmación.' using errcode='40001';
  end if;
 end if;
 select * into v_op from public.mega_audit_operations where workspace_id=p_workspace_id and operation_tag=p_content_tag for update;
 if found and v_op.record_id is not null then raise exception 'La identidad requiere recuperar su historial antes de registrar.' using errcode='40001';end if;
 insert into public.mega_audit_operations(workspace_id,operation_tag,document_tag,request_id,owner_id)
  values(p_workspace_id,p_content_tag,p_document_tag,p_request_id,v_user)
  on conflict(workspace_id,operation_tag) do update set document_tag=excluded.document_tag,request_id=excluded.request_id,owner_id=excluded.owner_id,reserved_at=clock_timestamp();
 update public.mega_salidas set pending_id=p_request_id,pending_owner=v_user,pending_content_tag=p_content_tag,pending_document_tag=p_document_tag,pending_at=clock_timestamp()
  where workspace_id=p_workspace_id and identity_tag=p_identity_tag;
 return jsonb_build_object('action',case when v_group.current_version=0 then 'new' else 'updated' end,'id',p_request_id,'owner_id',v_user,'version',v_group.current_version+1);
end;$$;

create or replace function public.mega_salida_commit(p_workspace_id uuid,p_identity_tag text,p_content_tag text,p_document_tag text,p_id uuid,p_salida_tag text,p_encrypted_metadata text,p_approved_import boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid();v_group public.mega_salidas%rowtype;v_row public.mega_audit_records%rowtype;
begin
 if v_user is null or not public.mega_audit_is_member(p_workspace_id) then raise exception 'Sin acceso al equipo.' using errcode='42501';end if;
 if p_id is null or p_identity_tag is null or p_identity_tag !~ '^[0-9a-f]{64}$' or p_content_tag is null or p_content_tag !~ '^[0-9a-f]{64}$' or p_document_tag is null or p_document_tag !~ '^[0-9a-f]{64}$' or p_salida_tag is null or p_salida_tag !~ '^[0-9a-f]{64}$' or p_encrypted_metadata is null or length(p_encrypted_metadata) not between 32 and 262144 or p_encrypted_metadata !~ '^[A-Za-z0-9+/]+={0,2}$' or p_approved_import is null then raise exception 'Versión inválida.' using errcode='22023';end if;
 if p_approved_import and not public.mega_audit_is_admin(p_workspace_id) then raise exception 'Solo un administrador puede aprobar la lectura importada.' using errcode='42501';end if;
 perform 1 from public.mega_audit_workspace where id=p_workspace_id for update;
 perform 1 from public.mega_audit_members where workspace_id=p_workspace_id and user_id=v_user for update;
 if not found then raise exception 'Acceso revocado.' using errcode='42501';end if;
 select * into v_group from public.mega_salidas where workspace_id=p_workspace_id and identity_tag=p_identity_tag for update;
 if not found then raise exception 'Reserva la salida antes de registrar.' using errcode='40001';end if;
 select * into v_row from public.mega_audit_records where workspace_id=p_workspace_id and id=p_id;
 if found then
  if v_row.created_by is distinct from v_user or v_row.salida_identity_tag is distinct from p_identity_tag or v_row.salida_content_tag is distinct from p_content_tag or v_row.document_tag is distinct from p_document_tag or v_row.encrypted_metadata is distinct from p_encrypted_metadata or v_row.salida_tag is distinct from p_salida_tag then raise exception 'Reintento de otro registro.' using errcode='23505';end if;
  return to_jsonb(v_row);
 end if;
 if v_group.pending_id is distinct from p_id or v_group.pending_owner is distinct from v_user or v_group.pending_content_tag is distinct from p_content_tag or v_group.pending_document_tag is distinct from p_document_tag then raise exception 'La reserva cambió. Reintenta el registro.' using errcode='40001';end if;
 -- Reutiliza las comprobaciones de archivos, cifrado, autor y tiempo oficiales.
 perform public.mega_audit_record(p_id,p_workspace_id,p_salida_tag,p_encrypted_metadata,p_id);
 if v_group.current_record_id is not null then
  update public.mega_audit_records set duplicate_of=p_id where workspace_id=p_workspace_id and (salida_identity_tag=p_identity_tag or duplicate_of=v_group.current_record_id) and id<>p_id;
 end if;
 update public.mega_audit_records set salida_identity_tag=p_identity_tag,salida_content_tag=p_content_tag,salida_version=v_group.current_version+1,
  salida_previous_id=v_group.current_record_id,document_tag=p_document_tag,operation_kind='primary',
  import_revision=case when p_approved_import then 1 else import_revision end,
  import_request_id=case when p_approved_import then p_id else import_request_id end,
  import_reviewed_by=case when p_approved_import then v_user else import_reviewed_by end,
  import_reviewed_at=case when p_approved_import then clock_timestamp() else import_reviewed_at end
  where id=p_id returning * into v_row;
 update public.mega_audit_operations set record_id=p_id where workspace_id=p_workspace_id and operation_tag=p_content_tag and request_id=p_id and owner_id=v_user;
 update public.mega_salidas set current_record_id=p_id,current_version=v_group.current_version+1,pending_id=null,pending_owner=null,pending_content_tag=null,pending_document_tag=null,pending_at=null where workspace_id=p_workspace_id and identity_tag=p_identity_tag;
 return to_jsonb(v_row);
end;$$;

-- Las pestañas anteriores no pueden saltarse la identidad automática de una
-- salida normal. Se conservan las importaciones y los movimientos explícitos.
create or replace function public.mega_audit_require_operation()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_op public.mega_audit_operations%rowtype;
begin
 select * into v_op from public.mega_audit_operations o where o.workspace_id=new.workspace_id and o.request_id=new.id and o.owner_id=auth.uid() and o.record_id is null;
 if not found then raise exception 'Reserva la operación con la versión actual de la aplicación.' using errcode='42501';end if;
 if v_op.operation_tag=v_op.document_tag and coalesce(current_setting('megacontrol.import_rpc',true),'')<>'1'
  and not exists(select 1 from public.mega_salidas s where s.workspace_id=new.workspace_id and s.pending_id=new.id and s.pending_owner=auth.uid())
 then raise exception 'Actualiza MegaControl para registrar con versiones automáticas.' using errcode='42501';end if;
 return new;
end;$$;
do $$ declare v_definition text;begin
 select pg_get_functiondef('public.mega_audit_record_import(uuid,uuid,text,text,uuid,text,text,text,boolean)'::regprocedure) into v_definition;
 if position('megacontrol.import_rpc' in v_definition)=0 then
  v_definition:=replace(v_definition,'perform public.mega_audit_record_v2(p_id,p_workspace_id,p_salida_tag,p_encrypted_metadata,p_idempotency_key,p_operation_tag,p_document_tag);',
   'if p_kind=''salida'' and p_confirmed and p_operation_tag=p_document_tag then raise exception ''Actualiza MegaControl para registrar salidas importadas con versiones automáticas.'' using errcode=''42501''; end if; perform set_config(''megacontrol.import_rpc'',''1'',true); perform public.mega_audit_record_v2(p_id,p_workspace_id,p_salida_tag,p_encrypted_metadata,p_idempotency_key,p_operation_tag,p_document_tag); perform set_config(''megacontrol.import_rpc'','''',true);');
  execute v_definition;
 end if;
end;$$;
-- Las herramientas de revisión anteriores no pueden cambiar un principal ya
-- administrado por el registro transaccional de identidades.
do $$ declare v_signature text;v_definition text;begin
 foreach v_signature in array array['public.mega_audit_review_duplicate(uuid,uuid,uuid,text,text)','public.mega_audit_review_version(uuid,uuid,uuid,text,text,text,text,text)'] loop
  select pg_get_functiondef(v_signature::regprocedure) into v_definition;
  if position('La salida tiene versiones automáticas' in v_definition)=0 then
   v_definition:=replace(v_definition,'select * into v_record from public.mega_audit_records r where r.id=p_record_id and r.workspace_id=p_workspace_id for update;',
    'select * into v_record from public.mega_audit_records r where r.id=p_record_id and r.workspace_id=p_workspace_id for update; if v_record.salida_identity_tag is not null then raise exception ''La salida tiene versiones automáticas. Registra el documento actualizado desde Nueva salida.'' using errcode=''42501''; end if;');
   v_definition:=replace(v_definition,'select * into v_canonical from public.mega_audit_records r where r.id=p_canonical_id and r.workspace_id=p_workspace_id for update;',
    'select * into v_canonical from public.mega_audit_records r where r.id=p_canonical_id and r.workspace_id=p_workspace_id for update; if v_canonical.salida_identity_tag is not null then raise exception ''La salida tiene versiones automáticas. Registra el documento actualizado desde Nueva salida.'' using errcode=''42501''; end if;');
   execute v_definition;
  end if;
 end loop;
end;$$;
-- Corregir una lectura de salida ya versionada requiere una versión nueva;
-- la función de aprobación de otras facturas conserva su comportamiento.
do $$ declare v_definition text;begin
 select pg_get_functiondef('public.mega_audit_import_update(uuid,uuid,text,text,text,text,uuid)'::regprocedure) into v_definition;
 if position('La salida tiene versiones automáticas' in v_definition)=0 then
  v_definition:=replace(v_definition,'select * into v_row from public.mega_audit_records where workspace_id=p_workspace_id and id=p_id for update;',
   'select * into v_row from public.mega_audit_records where workspace_id=p_workspace_id and id=p_id for update; if v_row.salida_identity_tag is not null then raise exception ''La salida tiene versiones automáticas. Guarda la corrección como otra versión.'' using errcode=''42501''; end if;');
  execute v_definition;
 end if;
end;$$;
revoke all on function public.mega_salida_seed(uuid,text,jsonb),public.mega_salida_prepare(uuid,text,text,text,uuid),public.mega_salida_commit(uuid,text,text,text,uuid,text,text,boolean) from public,anon,authenticated;
grant execute on function public.mega_salida_seed(uuid,text,jsonb),public.mega_salida_prepare(uuid,text,text,text,uuid),public.mega_salida_commit(uuid,text,text,text,uuid,text,text,boolean) to authenticated;

-- El respaldo incluye el pequeño registro de identidades en la misma instantánea.
create or replace function public.mega_audit_backup_snapshot(p_workspace_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_result jsonb;
begin
 if auth.uid() is null then raise exception 'Inicia sesión como administrador.' using errcode='42501';end if;
 perform 1 from public.mega_audit_members where workspace_id=p_workspace_id and user_id=auth.uid() and role='admin' for share;
 if not found then raise exception 'Solo administradores pueden respaldar el equipo.' using errcode='42501';end if;
 select jsonb_build_object('version',1,'workspace_id',p_workspace_id,'created_at',clock_timestamp(),
 'tables',jsonb_build_object(
  'mega_audit_workspace',(select coalesce(jsonb_agg(to_jsonb(w)),'[]'::jsonb) from public.mega_audit_workspace w where w.id=p_workspace_id),
  'mega_audit_members',(select coalesce(jsonb_agg(to_jsonb(m)),'[]'::jsonb) from public.mega_audit_members m where m.workspace_id=p_workspace_id),
  'mega_audit_user_keys',(select coalesce(jsonb_agg(to_jsonb(k)),'[]'::jsonb) from public.mega_audit_user_keys k where k.workspace_id=p_workspace_id),
  'mega_audit_records',(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) from public.mega_audit_records r where r.workspace_id=p_workspace_id),
  'mega_audit_operations',(select coalesce(jsonb_agg(to_jsonb(o) order by o.operation_tag),'[]'::jsonb) from public.mega_audit_operations o where o.workspace_id=p_workspace_id),
  'mega_salidas',(select coalesce(jsonb_agg(to_jsonb(s) order by s.identity_tag),'[]'::jsonb) from public.mega_salidas s where s.workspace_id=p_workspace_id),
  'mega_product_prices',(select coalesce(jsonb_agg(to_jsonb(p)),'[]'::jsonb) from public.mega_product_prices p where p.workspace_id=p_workspace_id),
  'mega_product_queries',(select coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) from public.mega_product_queries q where q.workspace_id=p_workspace_id)),
 'authors',(select coalesce(jsonb_agg(jsonb_build_object('user_id',u.id,'username',split_part(u.email,'@',1))),'[]'::jsonb) from auth.users u
  where exists(select 1 from public.mega_audit_members m where m.workspace_id=p_workspace_id and m.user_id=u.id)
  or exists(select 1 from public.mega_audit_records r where r.workspace_id=p_workspace_id and (r.created_by=u.id or r.reviewed_by=u.id or r.import_reviewed_by=u.id))
  or exists(select 1 from public.mega_audit_operations o where o.workspace_id=p_workspace_id and o.owner_id=u.id)
  or exists(select 1 from public.mega_product_queries q where q.workspace_id=p_workspace_id and q.created_by=u.id)
  or exists(select 1 from public.mega_product_prices p where p.workspace_id=p_workspace_id and p.updated_by=u.id)
  or exists(select 1 from public.mega_salidas s where s.workspace_id=p_workspace_id and s.pending_owner=u.id)),
 'objects',(select coalesce(jsonb_agg(jsonb_build_object('name',o.name,'size',o.metadata->>'size','updated_at',o.updated_at) order by o.name),'[]'::jsonb) from storage.objects o where o.bucket_id='mega-audit-documents' and starts_with(o.name,p_workspace_id::text||'/'))
 ) into v_result;
 return v_result;
end;$$;
revoke all on function public.mega_audit_backup_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.mega_audit_backup_snapshot(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
