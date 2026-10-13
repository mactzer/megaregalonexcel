-- Versiones corregidas de una salida. Requiere consultas-operaciones.sql e
-- importaciones.sql. No modifica documentos ni clasifica registros al instalar.
begin;

create or replace function public.mega_audit_review_version(
  p_workspace_id uuid,p_record_id uuid,p_canonical_id uuid,
  p_record_document_tag text,p_canonical_document_tag text,
  p_expected_metadata text,p_expected_canonical_metadata text,p_encrypted_review text
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid(); v_record public.mega_audit_records%rowtype; v_canonical public.mega_audit_records%rowtype;
begin
  if v_user is null or not public.mega_audit_is_admin(p_workspace_id) then raise exception 'Solo administradores pueden elegir una versión de salida.' using errcode='42501'; end if;
  if p_record_id is null or p_canonical_id is null or p_record_id=p_canonical_id
    or p_record_document_tag is null or p_record_document_tag !~ '^[0-9a-f]{64}$'
    or p_canonical_document_tag is null or p_canonical_document_tag !~ '^[0-9a-f]{64}$'
    or p_expected_metadata is null or p_expected_canonical_metadata is null
    or p_encrypted_review is null or length(p_encrypted_review) not between 32 and 32768
    or p_encrypted_review !~ '^[A-Za-z0-9+/]+={0,2}$'
  then raise exception 'Revisión de versión inválida.' using errcode='22023'; end if;
  perform 1 from public.mega_audit_workspace w where w.id=p_workspace_id for update;
  perform 1 from public.mega_audit_members m where m.workspace_id=p_workspace_id and m.user_id=v_user and m.role='admin' for update;
  if not found then raise exception 'Permiso revocado.' using errcode='42501'; end if;
  select * into v_record from public.mega_audit_records r where r.id=p_record_id and r.workspace_id=p_workspace_id for update;
  if not found or v_record.document_kind<>'salida' or v_record.operation_kind='separate'
    or v_record.encrypted_metadata<>p_expected_metadata
    or (v_record.document_tag is not null and v_record.document_tag<>p_record_document_tag)
  then raise exception 'La versión anterior cambió. Revisa otra vez.' using errcode='40001'; end if;
  select * into v_canonical from public.mega_audit_records r where r.id=p_canonical_id and r.workspace_id=p_workspace_id for update;
  if not found or v_canonical.document_kind<>'salida' or v_canonical.operation_kind='separate'
    or v_canonical.duplicate_of is not null or v_canonical.salida_tag<>v_record.salida_tag
    or v_canonical.encrypted_metadata<>p_expected_canonical_metadata
    or (v_canonical.document_tag is not null and v_canonical.document_tag<>p_canonical_document_tag)
  then raise exception 'La versión principal cambió o pertenece a otra salida.' using errcode='40001'; end if;
  if v_record.duplicate_of is not null then
    if v_record.duplicate_of=p_canonical_id and v_record.reviewed_by=v_user and v_record.encrypted_review=p_encrypted_review then return to_jsonb(v_record); end if;
    raise exception 'La versión ya fue clasificada. Actualiza la revisión.' using errcode='40001';
  end if;
  if exists(select 1 from public.mega_audit_records r where r.duplicate_of=p_record_id
    and (r.workspace_id<>p_workspace_id or r.salida_tag<>v_record.salida_tag or r.document_kind<>'salida'))
  then raise exception 'Los registros vinculados corresponden a otra salida. Revisa el grupo completo.' using errcode='22023'; end if;
  update public.mega_audit_records r set document_tag=p_canonical_document_tag where r.id=p_canonical_id;
  -- Una tercera corrección conserva todas las versiones bajo el nuevo principal.
  update public.mega_audit_records r set duplicate_of=p_canonical_id where r.workspace_id=p_workspace_id and r.duplicate_of=p_record_id;
  update public.mega_audit_records r set document_tag=p_record_document_tag,duplicate_of=p_canonical_id,
    reviewed_by=v_user,reviewed_at=clock_timestamp(),encrypted_review=p_encrypted_review
    where r.id=p_record_id returning * into v_record;
  -- Las reservas siguen apuntando al PDF que realmente se guardó. Una versión
  -- distinta no puede sustituir esos bytes al reintentar una descarga antigua.
  return to_jsonb(v_record);
end; $$;

-- Al volver a subir un PDF anterior, reutiliza sus archivos; solo redirige una
-- copia idéntica al principal. Una corrección puede tener otros bytes y costos.
create or replace function public.mega_audit_operation_claim(p_workspace_id uuid,p_operation_tag text,p_document_tag text,p_request_id uuid,p_existing_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid(); v_op public.mega_audit_operations%rowtype; v_record public.mega_audit_records%rowtype; v_canonical public.mega_audit_records%rowtype;
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
      if v_record.duplicate_of is not null then
        select * into v_canonical from public.mega_audit_records r where r.id=v_record.duplicate_of and r.workspace_id=p_workspace_id;
        if v_canonical.document_tag=p_document_tag then v_record:=v_canonical; end if;
      end if;
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
    select * into v_record from public.mega_audit_records r where r.id=p_existing_id and r.workspace_id=p_workspace_id and r.operation_kind<>'separate';
    if not found or (v_record.document_tag is not null and v_record.document_tag<>p_document_tag) then raise exception 'Origen no válido.' using errcode='22023'; end if;
    update public.mega_audit_operations o set record_id=v_record.id where o.workspace_id=p_workspace_id and o.operation_tag=p_operation_tag;
    return jsonb_build_object('record',to_jsonb(v_record));
  end if;
  return jsonb_build_object('id',v_op.request_id,'owner_id',v_op.owner_id);
end; $$;

revoke all on function public.mega_audit_review_version(uuid,uuid,uuid,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.mega_audit_review_version(uuid,uuid,uuid,text,text,text,text,text) to authenticated;
revoke all on function public.mega_audit_operation_claim(uuid,text,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.mega_audit_operation_claim(uuid,text,text,uuid,uuid) to authenticated;
notify pgrst,'reload schema';
commit;
