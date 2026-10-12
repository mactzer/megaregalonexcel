-- Actualización aditiva, sin tablas ni copias de documentos adicionales.
-- Únicamente el administrador puede obtener una instantánea del equipo.
begin;
create or replace function public.mega_audit_backup_snapshot(p_workspace_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
  if auth.uid() is null then raise exception 'Inicia sesión como administrador.' using errcode='42501'; end if;
  perform 1 from public.mega_audit_members m
    where m.workspace_id=p_workspace_id and m.user_id=auth.uid() and m.role='admin' for share;
  if not found then raise exception 'Solo administradores pueden respaldar el equipo.' using errcode='42501'; end if;
  -- Una sola sentencia: todas las colecciones corresponden a la misma instantánea.
  select jsonb_build_object(
    'version',1, 'workspace_id',p_workspace_id, 'created_at',clock_timestamp(),
    'tables',jsonb_build_object(
      'mega_audit_workspace',(select coalesce(jsonb_agg(to_jsonb(w)),'[]'::jsonb) from public.mega_audit_workspace w where w.id=p_workspace_id),
      'mega_audit_members',(select coalesce(jsonb_agg(to_jsonb(m) order by m.user_id),'[]'::jsonb) from public.mega_audit_members m where m.workspace_id=p_workspace_id),
      'mega_audit_user_keys',(select coalesce(jsonb_agg(to_jsonb(k) order by k.user_id),'[]'::jsonb) from public.mega_audit_user_keys k where k.workspace_id=p_workspace_id),
      'mega_audit_records',(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) from public.mega_audit_records r where r.workspace_id=p_workspace_id),
      'mega_audit_operations',(select coalesce(jsonb_agg(to_jsonb(o) order by o.operation_tag),'[]'::jsonb) from public.mega_audit_operations o where o.workspace_id=p_workspace_id),
      'mega_product_prices',(select coalesce(jsonb_agg(to_jsonb(p) order by p.product_tag),'[]'::jsonb) from public.mega_product_prices p where p.workspace_id=p_workspace_id),
      'mega_product_queries',(select coalesce(jsonb_agg(to_jsonb(q) order by q.id),'[]'::jsonb) from public.mega_product_queries q where q.workspace_id=p_workspace_id)
    ),
    'authors',(select coalesce(jsonb_agg(jsonb_build_object('user_id',u.id,'username',split_part(u.email,'@',1)) order by u.id),'[]'::jsonb)
      from auth.users u where exists(select 1 from public.mega_audit_members m where m.workspace_id=p_workspace_id and m.user_id=u.id)
      or exists(select 1 from public.mega_audit_records r where r.workspace_id=p_workspace_id and (r.created_by=u.id or r.reviewed_by=u.id or to_jsonb(r)->>'import_reviewed_by'=u.id::text))
      or exists(select 1 from public.mega_product_queries q where q.workspace_id=p_workspace_id and q.created_by=u.id)
      or exists(select 1 from public.mega_product_prices p where p.workspace_id=p_workspace_id and p.updated_by=u.id)
      or exists(select 1 from public.mega_audit_operations o where o.workspace_id=p_workspace_id and o.owner_id=u.id)),
    'objects',(select coalesce(jsonb_agg(jsonb_build_object('name',o.name,'size',o.metadata->>'size','updated_at',o.updated_at) order by o.name),'[]'::jsonb)
      from storage.objects o where o.bucket_id='mega-audit-documents' and starts_with(o.name,p_workspace_id::text||'/'))
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.mega_audit_backup_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.mega_audit_backup_snapshot(uuid) to authenticated;
notify pgrst, 'reload schema';
commit;
