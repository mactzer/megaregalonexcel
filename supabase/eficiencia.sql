-- MegaControl: historial cifrado de precios e índice derivado reutilizable.
-- No altera ni duplica PDF/Excel. Ejecutar después de salidas-automaticas.sql.
begin;
create table if not exists public.mega_product_price_history (
  workspace_id uuid not null references public.mega_audit_workspace(id),
  product_tag text not null check(product_tag ~ '^[0-9a-f]{64}$'),
  version bigint not null check(version > 0),
  encrypted_price text not null check(length(encrypted_price) between 32 and 16384 and length(encrypted_price)%4=0 and encrypted_price ~ '^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'),
  updated_by uuid not null references auth.users(id),
  updated_at timestamptz not null,
  primary key(workspace_id,product_tag,version)
);
alter table public.mega_product_price_history enable row level security;
revoke all on public.mega_product_price_history from public,anon,authenticated;
grant select on public.mega_product_price_history to authenticated;
drop policy if exists price_history_read on public.mega_product_price_history;
create policy price_history_read on public.mega_product_price_history for select to authenticated using(public.mega_audit_is_member(workspace_id));
drop policy if exists price_history_guard on public.mega_product_price_history;
create policy price_history_guard on public.mega_product_price_history as restrictive for all to authenticated using(public.mega_audit_is_member(workspace_id)) with check(false);
drop policy if exists price_history_anon_guard on public.mega_product_price_history;
create policy price_history_anon_guard on public.mega_product_price_history as restrictive for all to anon using(false) with check(false);
drop policy if exists price_history_write_guard on public.mega_product_price_history;
create policy price_history_write_guard on public.mega_product_price_history as restrictive for update to anon,authenticated using(false) with check(false);
drop policy if exists price_history_delete_guard on public.mega_product_price_history;
create policy price_history_delete_guard on public.mega_product_price_history as restrictive for delete to anon,authenticated using(false);
create or replace function public.mega_product_price_history_stamp()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into public.mega_product_price_history(workspace_id,product_tag,version,encrypted_price,updated_by,updated_at)
    values(new.workspace_id,new.product_tag,new.version,new.encrypted_price,new.updated_by,new.updated_at) on conflict do nothing;
  return new;
end;
$$;
revoke all on function public.mega_product_price_history_stamp() from public,anon,authenticated;
drop trigger if exists mega_product_price_history_stamp on public.mega_product_prices;
create trigger mega_product_price_history_stamp after insert or update on public.mega_product_prices for each row execute function public.mega_product_price_history_stamp();
insert into public.mega_product_price_history select workspace_id,product_tag,version,encrypted_price,updated_by,updated_at from public.mega_product_prices on conflict do nothing;

-- Mantiene compatible la RPC anterior e identifica reintentos del mismo cifrado.
create or replace function public.mega_product_price_set(p_workspace_id uuid,p_product_tag text,p_encrypted_price text,p_expected_version bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid(); v_row public.mega_product_prices%rowtype;
begin
  if v_user is null or not public.mega_audit_is_admin(p_workspace_id) then raise exception 'Solo administradores pueden editar precios.' using errcode='42501'; end if;
  if p_product_tag is null or p_product_tag !~ '^[0-9a-f]{64}$' or p_encrypted_price is null or length(p_encrypted_price) not between 32 and 16384 or length(p_encrypted_price)%4<>0 or p_encrypted_price !~ '^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' or p_expected_version is null or p_expected_version<0 then raise exception 'Precio o versión inválidos.' using errcode='22023'; end if;
  perform 1 from public.mega_audit_workspace w where w.id=p_workspace_id for update;
  perform 1 from public.mega_audit_members m where m.workspace_id=p_workspace_id and m.user_id=v_user and m.role='admin' for update;
  if not found then raise exception 'Tu cuenta ya no administra el equipo.' using errcode='42501'; end if;
  select * into v_row from public.mega_product_prices p where p.workspace_id=p_workspace_id and p.product_tag=p_product_tag for update;
  if found then
    if v_row.version=p_expected_version+1 and v_row.encrypted_price=p_encrypted_price and v_row.updated_by=v_user then return to_jsonb(v_row); end if;
    if v_row.version<>p_expected_version then raise exception 'Otro administrador cambió el precio. Consulta nuevamente.' using errcode='40001'; end if;
    update public.mega_product_prices p set encrypted_price=p_encrypted_price,version=p.version+1,updated_by=v_user,updated_at=clock_timestamp() where p.workspace_id=p_workspace_id and p.product_tag=p_product_tag returning * into v_row;
  else
    if p_expected_version<>0 then raise exception 'El precio cambió. Consulta nuevamente.' using errcode='40001'; end if;
    insert into public.mega_product_prices(workspace_id,product_tag,encrypted_price,version,updated_by,updated_at) values(p_workspace_id,p_product_tag,p_encrypted_price,1,v_user,clock_timestamp()) returning * into v_row;
  end if;
  return to_jsonb(v_row);
end;
$$;
revoke all on function public.mega_product_price_set(uuid,text,text,bigint) from public,anon,authenticated;
grant execute on function public.mega_product_price_set(uuid,text,text,bigint) to authenticated;

create table if not exists public.mega_product_catalog (
  workspace_id uuid not null references public.mega_audit_workspace(id),
  record_id uuid not null references public.mega_audit_records(id) on delete cascade,
  metadata_revision text not null check(metadata_revision ~ '^[0-9a-f]{32}$'),
  encrypted_catalog text not null check(length(encrypted_catalog) between 32 and 2097152 and length(encrypted_catalog)%4=0 and encrypted_catalog ~ '^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'),
  updated_by uuid not null references auth.users(id),
  updated_at timestamptz not null default now(),
  primary key(workspace_id,record_id)
);
alter table public.mega_product_catalog enable row level security;
revoke all on public.mega_product_catalog from public,anon,authenticated;
grant select on public.mega_product_catalog to authenticated;
drop policy if exists catalog_read on public.mega_product_catalog;
create policy catalog_read on public.mega_product_catalog for select to authenticated using(public.mega_audit_is_member(workspace_id));
drop policy if exists catalog_guard on public.mega_product_catalog;
create policy catalog_guard on public.mega_product_catalog as restrictive for all to authenticated using(public.mega_audit_is_member(workspace_id)) with check(false);
drop policy if exists catalog_anon_guard on public.mega_product_catalog;
create policy catalog_anon_guard on public.mega_product_catalog as restrictive for all to anon using(false) with check(false);
drop policy if exists catalog_write_guard on public.mega_product_catalog;
create policy catalog_write_guard on public.mega_product_catalog as restrictive for update to anon,authenticated using(false) with check(false);
drop policy if exists catalog_delete_guard on public.mega_product_catalog;
create policy catalog_delete_guard on public.mega_product_catalog as restrictive for delete to anon,authenticated using(false);
create or replace function public.mega_product_catalog_put(p_workspace_id uuid,p_record_id uuid,p_metadata_revision text,p_encrypted_catalog text)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid(); v_record public.mega_audit_records%rowtype;
begin
  if v_user is null or not public.mega_audit_is_member(p_workspace_id) then raise exception 'Acceso no autorizado.' using errcode='42501'; end if;
  perform 1 from public.mega_audit_members m where m.workspace_id=p_workspace_id and m.user_id=v_user for share;
  if not found then raise exception 'Tu cuenta ya no tiene acceso.' using errcode='42501'; end if;
  select * into v_record from public.mega_audit_records r where r.id=p_record_id and r.workspace_id=p_workspace_id for share;
  if not found or (v_record.created_by<>v_user and not public.mega_audit_is_admin(p_workspace_id)) then raise exception 'Solo el autor o un administrador prepara el índice compartido.' using errcode='42501'; end if;
  if md5(v_record.encrypted_metadata)<>p_metadata_revision or p_metadata_revision is null then raise exception 'El documento cambió; vuelve a preparar su índice.' using errcode='40001'; end if;
  if v_record.document_kind<>'salida' and v_record.import_reviewed_by is null then raise exception 'Documento pendiente de revisión.' using errcode='42501'; end if;
  if p_encrypted_catalog is null or length(p_encrypted_catalog) not between 32 and 2097152 or length(p_encrypted_catalog)%4<>0 or p_encrypted_catalog !~ '^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' then raise exception 'Índice inválido.' using errcode='22023'; end if;
  insert into public.mega_product_catalog(workspace_id,record_id,metadata_revision,encrypted_catalog,updated_by)
    values(p_workspace_id,p_record_id,p_metadata_revision,p_encrypted_catalog,v_user)
    on conflict(workspace_id,record_id) do update set metadata_revision=excluded.metadata_revision,encrypted_catalog=excluded.encrypted_catalog,updated_by=excluded.updated_by,updated_at=clock_timestamp()
    where mega_product_catalog.metadata_revision<>excluded.metadata_revision or mega_product_catalog.encrypted_catalog<>excluded.encrypted_catalog;
  return true;
end;
$$;
revoke all on function public.mega_product_catalog_put(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.mega_product_catalog_put(uuid,uuid,text,text) to authenticated;

-- Añade el historial a los respaldos; el índice derivado se puede reconstruir.
do $$ begin
  if to_regprocedure('public.mega_audit_backup_snapshot_before_efficiency(uuid)') is null then
    alter function public.mega_audit_backup_snapshot(uuid) rename to mega_audit_backup_snapshot_before_efficiency;
  end if;
end $$;
create or replace function public.mega_audit_backup_snapshot(p_workspace_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_snapshot jsonb;
begin
  v_snapshot:=public.mega_audit_backup_snapshot_before_efficiency(p_workspace_id);
  v_snapshot:=jsonb_set(v_snapshot,'{tables,mega_product_price_history}',coalesce((select jsonb_agg(to_jsonb(h) order by h.product_tag,h.version) from public.mega_product_price_history h where h.workspace_id=p_workspace_id and exists(select 1 from jsonb_array_elements(v_snapshot->'tables'->'mega_product_prices') p where p->>'product_tag'=h.product_tag and (p->>'version')::bigint>=h.version)),'[]'::jsonb));
  return jsonb_set(v_snapshot,'{authors}',coalesce((select jsonb_agg(jsonb_build_object('user_id',u.id,'username',split_part(u.email,'@',1)) order by u.id) from auth.users u where exists(select 1 from jsonb_array_elements(v_snapshot->'authors') a where a->>'user_id'=u.id::text) or exists(select 1 from jsonb_array_elements(v_snapshot->'tables'->'mega_product_price_history') h where h->>'updated_by'=u.id::text)),'[]'::jsonb));
end;
$$;
revoke all on function public.mega_audit_backup_snapshot_before_efficiency(uuid) from public,anon,authenticated;
revoke all on function public.mega_audit_backup_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.mega_audit_backup_snapshot(uuid) to authenticated;
do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='mega_product_prices') then
    alter publication supabase_realtime add table public.mega_product_prices;
  end if;
end $$;
notify pgrst,'reload schema';
commit;
