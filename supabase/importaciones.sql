-- Lecturas de otros PDF: conserva originales y añade solamente metadatos pequeños.
begin;
alter table public.mega_audit_records add column if not exists document_kind text not null default 'salida' check(document_kind in ('salida','factura','pedido','otro'));
alter table public.mega_audit_records add column if not exists import_reviewed_by uuid references auth.users(id);
alter table public.mega_audit_records add column if not exists import_reviewed_at timestamptz;
alter table public.mega_audit_records add column if not exists import_revision integer not null default 0;
alter table public.mega_audit_records add column if not exists import_request_id uuid;

create or replace view public.mega_audit_catalog_records with(security_invoker=true) as
  select id,workspace_id,created_at,encrypted_metadata,md5(encrypted_metadata) as metadata_revision,duplicate_of,document_kind,import_reviewed_by,import_reviewed_at,import_revision
  from public.mega_audit_records;
revoke all on public.mega_audit_catalog_records from public,anon,authenticated;
grant select on public.mega_audit_catalog_records to authenticated;

create or replace function public.mega_audit_record_import(p_id uuid,p_workspace_id uuid,p_salida_tag text,p_encrypted_metadata text,p_idempotency_key uuid,p_operation_tag text,p_document_tag text,p_kind text,p_confirmed boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid();v_saved public.mega_audit_records%rowtype;
begin
  if v_user is null or not public.mega_audit_is_member(p_workspace_id) then raise exception 'Sin acceso al equipo.' using errcode='42501';end if;
  if p_kind is null or p_kind not in ('salida','factura','pedido','otro') or p_confirmed is null then raise exception 'Tipo de documento inválido.' using errcode='22023';end if;
  perform 1 from public.mega_audit_workspace where id=p_workspace_id for update;
  perform 1 from public.mega_audit_members where workspace_id=p_workspace_id and user_id=v_user for update;
  if not found or (p_confirmed and not public.mega_audit_is_admin(p_workspace_id)) then raise exception 'Solo un administrador puede confirmar la lectura y los precios.' using errcode='42501';end if;
  perform public.mega_audit_record_v2(p_id,p_workspace_id,p_salida_tag,p_encrypted_metadata,p_idempotency_key,p_operation_tag,p_document_tag);
  select * into v_saved from public.mega_audit_records where id=p_id and workspace_id=p_workspace_id for update;
  if v_saved.import_revision>0 then
    if v_saved.import_request_id<>p_id or v_saved.encrypted_metadata<>p_encrypted_metadata or v_saved.document_kind<>p_kind or (v_saved.import_reviewed_by is not null)<>p_confirmed then raise exception 'La lectura ya cambió. Ábrela desde el Archivo.' using errcode='40001';end if;
    return to_jsonb(v_saved);
  end if;
  update public.mega_audit_records set document_kind=p_kind,import_revision=1,import_request_id=p_id,
    import_reviewed_by=case when p_confirmed then v_user else null end,import_reviewed_at=case when p_confirmed then clock_timestamp() else null end
    where id=p_id returning * into v_saved;
  return to_jsonb(v_saved);
end;$$;

create or replace function public.mega_audit_import_update(p_workspace_id uuid,p_id uuid,p_expected_metadata text,p_encrypted_metadata text,p_salida_tag text,p_kind text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid();v_row public.mega_audit_records%rowtype;
begin
  if v_user is null or not public.mega_audit_is_admin(p_workspace_id) then raise exception 'Solo administradores pueden confirmar o corregir lecturas.' using errcode='42501';end if;
  if p_request_id is null or p_kind is null or p_kind not in ('salida','factura','pedido','otro') or p_encrypted_metadata is null or length(p_encrypted_metadata) not between 32 and 262144 or p_encrypted_metadata !~ '^[A-Za-z0-9+/]+={0,2}$' or p_salida_tag is null or p_salida_tag !~ '^[0-9a-f]{64}$' then raise exception 'Lectura inválida.' using errcode='22023';end if;
  perform 1 from public.mega_audit_workspace where id=p_workspace_id for update;
  perform 1 from public.mega_audit_members where workspace_id=p_workspace_id and user_id=v_user and role='admin' for update;
  if not found then raise exception 'Permisos revocados.' using errcode='42501';end if;
  select * into v_row from public.mega_audit_records where workspace_id=p_workspace_id and id=p_id for update;
  if not found then raise exception 'No existe el documento.' using errcode='22023';end if;
  if v_row.import_request_id=p_request_id then
    if v_row.encrypted_metadata<>p_encrypted_metadata or v_row.import_reviewed_by is distinct from v_user or v_row.document_kind<>p_kind or v_row.salida_tag<>p_salida_tag then raise exception 'Reintento de otra lectura.' using errcode='23505';end if;
    return to_jsonb(v_row);
  end if;
  if v_row.encrypted_metadata is distinct from p_expected_metadata then raise exception 'Otro administrador corrigió esta lectura. Ábrela nuevamente.' using errcode='40001';end if;
  update public.mega_audit_records set encrypted_metadata=p_encrypted_metadata,salida_tag=p_salida_tag,document_kind=p_kind,import_revision=import_revision+1,
    import_request_id=p_request_id,import_reviewed_by=v_user,import_reviewed_at=clock_timestamp() where id=p_id returning * into v_row;
  return to_jsonb(v_row);
end;$$;
revoke all on function public.mega_audit_record_import(uuid,uuid,text,text,uuid,text,text,text,boolean),public.mega_audit_import_update(uuid,uuid,text,text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.mega_audit_record_import(uuid,uuid,text,text,uuid,text,text,text,boolean),public.mega_audit_import_update(uuid,uuid,text,text,text,text,uuid) to authenticated;
notify pgrst,'reload schema';
commit;
