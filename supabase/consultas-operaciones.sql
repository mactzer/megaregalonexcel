-- Actualización aditiva: consultas compartidas, identidad de operaciones y revisión.
-- Ejecutar en el SQL Editor del proyecto EXISTENTE, con auditoria.sql instalado.
-- No elimina registros, PDF ni Excel. No clasifica automáticamente el historial.
begin;

create table if not exists public.mega_product_queries (
  id uuid primary key,
  workspace_id uuid not null references public.mega_audit_workspace(id),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  encrypted_query text not null check(length(encrypted_query) between 32 and 32768 and length(encrypted_query)%4=0 and encrypted_query ~ '^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$')
);
create index if not exists mega_product_queries_time on public.mega_product_queries(workspace_id,created_at desc,id desc);
-- Conserva también la autoría de consultas de compañeros que ya no son miembros.
create or replace function public.mega_audit_authors(p_workspace_id uuid)
returns table(user_id uuid,username text) language plpgsql security definer set search_path='' as $$
begin
  if not public.mega_audit_is_member(p_workspace_id) then raise exception 'Sin acceso al equipo.' using errcode='42501'; end if;
  return query select u.id,split_part(u.email,'@',1) from auth.users u where exists(select 1 from public.mega_audit_members m where m.workspace_id=p_workspace_id and m.user_id=u.id) or exists(select 1 from public.mega_audit_records r where r.workspace_id=p_workspace_id and r.created_by=u.id) or exists(select 1 from public.mega_product_queries q where q.workspace_id=p_workspace_id and q.created_by=u.id) order by u.id;
end; $$;
alter table public.mega_product_queries enable row level security;
revoke all on public.mega_product_queries from public,anon,authenticated;
grant select on public.mega_product_queries to authenticated;
create or replace function public.mega_product_query_add(p_workspace_id uuid,p_id uuid,p_encrypted_query text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid(); v_row public.mega_product_queries%rowtype;
begin
  if v_user is null or not public.mega_audit_is_member(p_workspace_id) then raise exception 'Sin acceso al equipo.' using errcode='42501'; end if;
  if p_id is null or p_encrypted_query is null or length(p_encrypted_query) not between 32 and 32768 or length(p_encrypted_query)%4<>0 or p_encrypted_query !~ '^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' then raise exception 'Consulta inválida.' using errcode='22023'; end if;
  perform 1 from public.mega_audit_members m where m.workspace_id=p_workspace_id and m.user_id=v_user for update;
  if not found then raise exception 'Acceso revocado.' using errcode='42501'; end if;
  insert into public.mega_product_queries(id,workspace_id,created_by,encrypted_query) values(p_id,p_workspace_id,v_user,p_encrypted_query) on conflict(id) do nothing;
  select * into v_row from public.mega_product_queries q where q.id=p_id;
  if v_row.workspace_id<>p_workspace_id or v_row.created_by<>v_user or v_row.encrypted_query<>p_encrypted_query then raise exception 'Identificador de otra consulta.' using errcode='23505'; end if;
  return to_jsonb(v_row);
end; $$;

alter table public.mega_audit_records add column if not exists document_tag text check(document_tag ~ '^[0-9a-f]{64}$');
alter table public.mega_audit_records add column if not exists operation_kind text not null default 'legacy' check(operation_kind in ('legacy','primary','separate'));
alter table public.mega_audit_records add column if not exists duplicate_of uuid references public.mega_audit_records(id);
alter table public.mega_audit_records add column if not exists reviewed_by uuid references auth.users(id);
alter table public.mega_audit_records add column if not exists reviewed_at timestamptz;
alter table public.mega_audit_records add column if not exists encrypted_review text;
create index if not exists mega_audit_record_documents on public.mega_audit_records(workspace_id,document_tag);
create index if not exists mega_audit_record_links on public.mega_audit_records(workspace_id,duplicate_of);
create table if not exists public.mega_audit_operations (
  workspace_id uuid not null references public.mega_audit_workspace(id),
  operation_tag text not null check(operation_tag ~ '^[0-9a-f]{64}$'),
  document_tag text not null check(document_tag ~ '^[0-9a-f]{64}$'),
  request_id uuid not null unique,
  owner_id uuid not null references auth.users(id),
  reserved_at timestamptz not null default clock_timestamp(),
  record_id uuid references public.mega_audit_records(id),
  primary key(workspace_id,operation_tag)
);
alter table public.mega_audit_operations enable row level security;
revoke all on public.mega_audit_operations from public,anon,authenticated;
grant select on public.mega_audit_operations to authenticated;
create or replace function public.mega_audit_require_operation()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if not exists(select 1 from public.mega_audit_operations o where o.workspace_id=new.workspace_id and o.request_id=new.id and o.owner_id=auth.uid() and o.record_id is null) then raise exception 'Reserva la operación con la versión actual de la aplicación.' using errcode='42501'; end if;
  return new;
end; $$;
revoke all on function public.mega_audit_require_operation() from public,anon,authenticated;
drop trigger if exists mega_audit_operation_guard on public.mega_audit_records;
create trigger mega_audit_operation_guard before insert on public.mega_audit_records for each row execute function public.mega_audit_require_operation();

-- La reserva serializa la misma operación entre usuarios y dispositivos.
-- Tras un cierre inesperado, una reserva sin confirmar puede retomarse en 2 min.
create or replace function public.mega_audit_operation_claim(p_workspace_id uuid,p_operation_tag text,p_document_tag text,p_request_id uuid,p_existing_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid(); v_op public.mega_audit_operations%rowtype; v_record public.mega_audit_records%rowtype;
begin
  if v_user is null or not public.mega_audit_is_member(p_workspace_id) then raise exception 'Sin acceso al equipo.' using errcode='42501'; end if;
  if p_request_id is null or p_operation_tag is null or p_operation_tag !~ '^[0-9a-f]{64}$' or p_document_tag is null or p_document_tag !~ '^[0-9a-f]{64}$' then raise exception 'Operación inválida.' using errcode='22023'; end if;
  perform 1 from public.mega_audit_workspace w where w.id=p_workspace_id for update;
  perform 1 from public.mega_audit_members m where m.workspace_id=p_workspace_id and m.user_id=v_user for update;
  if not found then raise exception 'Acceso revocado.' using errcode='42501'; end if;
  select * into v_op from public.mega_audit_operations o where o.workspace_id=p_workspace_id and o.operation_tag=p_operation_tag for update;
  if found then
    if v_op.document_tag<>p_document_tag then raise exception 'Identidad de otro documento.' using errcode='23505'; end if;
    if v_op.record_id is not null then
      select * into v_record from public.mega_audit_records r where r.id=v_op.record_id and r.workspace_id=p_workspace_id;
      if v_record.duplicate_of is not null then select * into v_record from public.mega_audit_records r where r.id=v_record.duplicate_of and r.workspace_id=p_workspace_id; end if;
      return jsonb_build_object('record',to_jsonb(v_record));
    end if;
    if v_op.request_id<>p_request_id or v_op.owner_id<>v_user then
      if v_op.reserved_at>clock_timestamp()-interval '2 minutes' then raise exception 'Otro intento está guardando esta operación. Reintenta en dos minutos; no se creó otra salida.' using errcode='40001'; end if;
      update public.mega_audit_operations o set request_id=p_request_id,owner_id=v_user,reserved_at=clock_timestamp() where o.workspace_id=p_workspace_id and o.operation_tag=p_operation_tag returning * into v_op;
    end if;
  else
    insert into public.mega_audit_operations(workspace_id,operation_tag,document_tag,request_id,owner_id) values(p_workspace_id,p_operation_tag,p_document_tag,p_request_id,v_user) returning * into v_op;
  end if;
  if p_existing_id is not null then
    if p_operation_tag<>p_document_tag then raise exception 'Un movimiento nuevo no reutiliza otro registro.' using errcode='22023'; end if;
    select * into v_record from public.mega_audit_records r where r.id=p_existing_id and r.workspace_id=p_workspace_id and r.duplicate_of is null and r.operation_kind<>'separate';
    if not found or (v_record.document_tag is not null and v_record.document_tag<>p_document_tag) then raise exception 'Origen no válido.' using errcode='22023'; end if;
    update public.mega_audit_operations o set record_id=v_record.id where o.workspace_id=p_workspace_id and o.operation_tag=p_operation_tag;
    return jsonb_build_object('record',to_jsonb(v_record));
  end if;
  return jsonb_build_object('id',v_op.request_id,'owner_id',v_op.owner_id);
end; $$;

create or replace function public.mega_audit_record_v2(p_id uuid,p_workspace_id uuid,p_salida_tag text,p_encrypted_metadata text,p_idempotency_key uuid,p_operation_tag text,p_document_tag text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid(); v_op public.mega_audit_operations%rowtype; v_saved jsonb;
begin
  if v_user is null or not public.mega_audit_is_member(p_workspace_id) then raise exception 'Sin acceso al equipo.' using errcode='42501'; end if;
  if p_id is null or p_idempotency_key is null or p_operation_tag is null or p_operation_tag !~ '^[0-9a-f]{64}$' or p_document_tag is null or p_document_tag !~ '^[0-9a-f]{64}$' then raise exception 'Identidad de operación inválida.' using errcode='22023'; end if;
  perform 1 from public.mega_audit_workspace w where w.id=p_workspace_id for update;
  perform 1 from public.mega_audit_members m where m.workspace_id=p_workspace_id and m.user_id=v_user for update;
  if not found then raise exception 'Acceso revocado.' using errcode='42501'; end if;
  select * into v_op from public.mega_audit_operations o where o.workspace_id=p_workspace_id and o.operation_tag=p_operation_tag for update;
  if not found or v_op.owner_id<>v_user or v_op.request_id<>p_id or v_op.document_tag<>p_document_tag or p_idempotency_key<>p_id or (v_op.record_id is not null and v_op.record_id<>p_id) then raise exception 'La reserva cambió. Consulta la operación antes de guardar.' using errcode='40001'; end if;
  v_saved:=public.mega_audit_record(p_id,p_workspace_id,p_salida_tag,p_encrypted_metadata,p_idempotency_key);
  update public.mega_audit_records r set document_tag=p_document_tag,operation_kind=case when p_operation_tag=p_document_tag then 'primary' else 'separate' end where r.id=p_id;
  update public.mega_audit_operations o set record_id=p_id where o.workspace_id=p_workspace_id and o.operation_tag=p_operation_tag;
  return v_saved || jsonb_build_object('document_tag',p_document_tag,'operation_kind',case when p_operation_tag=p_document_tag then 'primary' else 'separate' end);
end; $$;

-- Decisión administrativa explícita. Los registros y sus archivos se conservan.
create or replace function public.mega_audit_review_duplicate(p_workspace_id uuid,p_record_id uuid,p_canonical_id uuid,p_document_tag text,p_encrypted_review text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid(); v_record public.mega_audit_records%rowtype; v_canonical public.mega_audit_records%rowtype;
begin
  if v_user is null or not public.mega_audit_is_admin(p_workspace_id) then raise exception 'Solo administradores pueden clasificar duplicados.' using errcode='42501'; end if;
  if p_record_id is null or p_record_id=p_canonical_id or p_document_tag is null or p_document_tag !~ '^[0-9a-f]{64}$' or p_encrypted_review is null or length(p_encrypted_review) not between 32 and 32768 or p_encrypted_review !~ '^[A-Za-z0-9+/]+={0,2}$' then raise exception 'Revisión inválida.' using errcode='22023'; end if;
  perform 1 from public.mega_audit_workspace w where w.id=p_workspace_id for update;
  perform 1 from public.mega_audit_members m where m.workspace_id=p_workspace_id and m.user_id=v_user and m.role='admin' for update;
  if not found then raise exception 'Permiso revocado.' using errcode='42501'; end if;
  select * into v_record from public.mega_audit_records r where r.id=p_record_id and r.workspace_id=p_workspace_id for update;
  if not found or v_record.duplicate_of is not null or v_record.operation_kind='separate' or (v_record.document_tag is not null and v_record.document_tag<>p_document_tag) then raise exception 'El registro cambió. Revisa otra vez.' using errcode='40001'; end if;
  if p_canonical_id is not null then
    select * into v_canonical from public.mega_audit_records r where r.id=p_canonical_id and r.workspace_id=p_workspace_id for update;
    if not found or v_canonical.duplicate_of is not null or v_canonical.operation_kind='separate' or (v_canonical.document_tag is not null and v_canonical.document_tag<>p_document_tag) then raise exception 'Origen incompatible.' using errcode='22023'; end if;
    if exists(select 1 from public.mega_audit_records r where r.duplicate_of=p_record_id) then raise exception 'Este registro ya conserva documentos vinculados. Revisa su grupo completo.' using errcode='22023'; end if;
    update public.mega_audit_records r set document_tag=p_document_tag where r.id=p_canonical_id;
    update public.mega_audit_operations o set record_id=p_canonical_id where o.workspace_id=p_workspace_id and o.record_id=p_record_id;
  end if;
  update public.mega_audit_records r set document_tag=p_document_tag,duplicate_of=p_canonical_id,operation_kind=case when p_canonical_id is null then 'separate' else operation_kind end,reviewed_by=v_user,reviewed_at=clock_timestamp(),encrypted_review=p_encrypted_review where r.id=p_record_id returning * into v_record;
  return to_jsonb(v_record);
end; $$;

do $$ declare v_table text; begin
  foreach v_table in array array['mega_product_queries','mega_audit_operations'] loop
    execute format('drop policy if exists member_read on public.%I',v_table);
    execute format('create policy member_read on public.%I for select to authenticated using(public.mega_audit_is_member(workspace_id))',v_table);
    execute format('drop policy if exists member_guard on public.%I',v_table);
    execute format('create policy member_guard on public.%I as restrictive for select to authenticated using(public.mega_audit_is_member(workspace_id))',v_table);
    execute format('drop policy if exists anon_guard on public.%I',v_table);
    execute format('create policy anon_guard on public.%I as restrictive for select to anon using(false)',v_table);
    execute format('drop policy if exists insert_guard on public.%I',v_table);
    execute format('create policy insert_guard on public.%I as restrictive for insert to anon,authenticated with check(false)',v_table);
    execute format('drop policy if exists update_guard on public.%I',v_table);
    execute format('create policy update_guard on public.%I as restrictive for update to anon,authenticated using(false) with check(false)',v_table);
    execute format('drop policy if exists delete_guard on public.%I',v_table);
    execute format('create policy delete_guard on public.%I as restrictive for delete to anon,authenticated using(false)',v_table);
  end loop;
end; $$;
-- Impide que una pestaña antigua omita la nueva identidad persistente.
revoke execute on function public.mega_audit_record(uuid,uuid,text,text,uuid) from public,anon,authenticated;
revoke all on function public.mega_product_query_add(uuid,uuid,text),public.mega_audit_operation_claim(uuid,text,text,uuid,uuid),public.mega_audit_record_v2(uuid,uuid,text,text,uuid,text,text),public.mega_audit_review_duplicate(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.mega_product_query_add(uuid,uuid,text),public.mega_audit_operation_claim(uuid,text,text,uuid,uuid),public.mega_audit_record_v2(uuid,uuid,text,text,uuid,text,text),public.mega_audit_review_duplicate(uuid,uuid,uuid,text,text) to authenticated;
-- Realtime usa las mismas políticas de lectura. Si la publicación no existe,
-- el cliente sigue sincronizando mediante consultas periódicas autorizadas.
do $$ declare v_table text; begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    foreach v_table in array array['mega_product_queries','mega_audit_records'] loop
      if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=v_table) then execute format('alter publication supabase_realtime add table public.%I',v_table); end if;
    end loop;
  end if;
end; $$;
notify pgrst,'reload schema';
commit;
