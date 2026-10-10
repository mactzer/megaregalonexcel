-- Ejecuta solamente este archivo en un proyecto con la auditoría ya instalada.
-- Conserva cuentas, precios existentes y los PDF/Excel originales.
begin;
create table if not exists public.mega_product_prices (
  workspace_id uuid not null references public.mega_audit_workspace(id),
  product_tag text not null check(product_tag ~ '^[0-9a-f]{64}$'),
  encrypted_price text not null check(length(encrypted_price) between 32 and 16384 and length(encrypted_price)%4=0 and encrypted_price ~ '^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'),
  version bigint not null default 1 check(version >= 1),
  updated_by uuid not null references auth.users(id),
  updated_at timestamptz not null default now(),
  primary key(workspace_id,product_tag)
);
alter table public.mega_product_prices enable row level security;
revoke all on public.mega_product_prices from public,anon,authenticated;
grant select on public.mega_product_prices to authenticated;
drop policy if exists mega_product_prices_read on public.mega_product_prices;
create policy mega_product_prices_read on public.mega_product_prices for select to authenticated using(public.mega_audit_is_member(workspace_id));
drop policy if exists mega_product_prices_member_guard on public.mega_product_prices;
create policy mega_product_prices_member_guard on public.mega_product_prices as restrictive for select to authenticated using(public.mega_audit_is_member(workspace_id));
drop policy if exists mega_product_prices_anon_guard on public.mega_product_prices;
create policy mega_product_prices_anon_guard on public.mega_product_prices as restrictive for select to anon using(false);
drop policy if exists mega_product_prices_insert_guard on public.mega_product_prices;
create policy mega_product_prices_insert_guard on public.mega_product_prices as restrictive for insert to anon,authenticated with check(false);
drop policy if exists mega_product_prices_update_guard on public.mega_product_prices;
create policy mega_product_prices_update_guard on public.mega_product_prices as restrictive for update to anon,authenticated using(false) with check(false);
drop policy if exists mega_product_prices_delete_guard on public.mega_product_prices;
create policy mega_product_prices_delete_guard on public.mega_product_prices as restrictive for delete to anon,authenticated using(false);
create or replace function public.mega_product_price_set(p_workspace_id uuid,p_product_tag text,p_encrypted_price text,p_expected_version bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid(); v_row public.mega_product_prices%rowtype;
begin
  if v_user is null or not public.mega_audit_is_admin(p_workspace_id) then raise exception 'Solo administradores pueden editar precios.' using errcode='42501'; end if;
  if p_product_tag is null or p_product_tag !~ '^[0-9a-f]{64}$' or p_encrypted_price is null or length(p_encrypted_price) not between 32 and 16384 or length(p_encrypted_price)%4<>0 or p_encrypted_price !~ '^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' or p_expected_version is null or p_expected_version<0 then raise exception 'Precio o versión inválidos.' using errcode='22023'; end if;
  -- Serializa también inserciones iniciales y revalida el rol después de esperar.
  perform 1 from public.mega_audit_workspace w where w.id=p_workspace_id for update;
  perform 1 from public.mega_audit_members m where m.workspace_id=p_workspace_id and m.user_id=v_user and m.role='admin' for update;
  if not found then raise exception 'Tu cuenta ya no administra el equipo.' using errcode='42501'; end if;
  select * into v_row from public.mega_product_prices p where p.workspace_id=p_workspace_id and p.product_tag=p_product_tag for update;
  if found then
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
notify pgrst, 'reload schema';
commit;
