-- Instalación del historial cifrado. Ejecuta este archivo en Supabase SQL Editor.
-- La cuenta administradora se asigna después, con el segundo bloque de LEEME.md.
-- Este script no crea usuarios de Auth ni concede acceso a quienes se registran.

begin;

create table if not exists public.mega_audit_workspace (
  id uuid primary key,
  label text not null default 'Auditoría de salidas',
  key_fingerprint text check (key_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

create table if not exists public.mega_audit_members (
  workspace_id uuid not null references public.mega_audit_workspace(id),
  user_id uuid not null references auth.users(id),
  role text not null default 'user' check (role in ('admin', 'user')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

-- Cada usuario recibe la clave del equipo envuelta con una clave derivada de
-- su contraseña en el navegador. Supabase no recibe la contraseña original.
create table if not exists public.mega_audit_user_keys (
  workspace_id uuid not null,
  user_id uuid not null,
  wrapped_key text not null check (
    length(wrapped_key) between 32 and 16384 and wrapped_key ~ '^[A-Za-z0-9+/]+={0,2}$'
  ),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id),
  foreign key (workspace_id, user_id) references public.mega_audit_members(workspace_id, user_id)
    on delete cascade
);

create table if not exists public.mega_audit_records (
  id uuid primary key,
  workspace_id uuid not null references public.mega_audit_workspace(id),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  salida_tag text not null check (salida_tag ~ '^[0-9a-f]{64}$'),
  encrypted_metadata text not null check (
    length(encrypted_metadata) between 32 and 262144
    and encrypted_metadata ~ '^[A-Za-z0-9+/]+={0,2}$'
  ),
  pdf_path text not null unique,
  excel_path text not null unique,
  idempotency_key uuid not null,
  unique (workspace_id, created_by, idempotency_key),
  check (pdf_path = workspace_id::text || '/' || created_by::text || '/' || id::text || '/pdf.bin'),
  check (excel_path = workspace_id::text || '/' || created_by::text || '/' || id::text || '/excel.bin')
);

create index if not exists mega_audit_records_workspace_time
  on public.mega_audit_records(workspace_id, created_at desc, id desc);
create index if not exists mega_audit_records_workspace_salida
  on public.mega_audit_records(workspace_id, salida_tag, created_at desc);

insert into public.mega_audit_workspace(id)
values ('86551e44-7504-4d30-b453-c9e04b269a43')
on conflict (id) do nothing;

alter table public.mega_audit_workspace enable row level security;
alter table public.mega_audit_members enable row level security;
alter table public.mega_audit_user_keys enable row level security;
alter table public.mega_audit_records enable row level security;

revoke all on public.mega_audit_workspace, public.mega_audit_members,
  public.mega_audit_user_keys, public.mega_audit_records from public, anon, authenticated;
grant select on public.mega_audit_workspace, public.mega_audit_members,
  public.mega_audit_user_keys, public.mega_audit_records to authenticated;

-- Las funciones internas evitan la recursión de RLS en la tabla de miembros.
create or replace function public.mega_audit_is_member(p_workspace_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.mega_audit_members m
    where m.workspace_id = p_workspace_id and m.user_id = auth.uid()
  );
$$;

create or replace function public.mega_audit_is_admin(p_workspace_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.mega_audit_members m
    where m.workspace_id = p_workspace_id and m.user_id = auth.uid() and m.role = 'admin'
  );
$$;

revoke all on function public.mega_audit_is_member(uuid),
  public.mega_audit_is_admin(uuid) from public, anon, authenticated;
grant execute on function public.mega_audit_is_member(uuid),
  public.mega_audit_is_admin(uuid) to authenticated;

drop policy if exists mega_audit_workspace_read on public.mega_audit_workspace;
create policy mega_audit_workspace_read on public.mega_audit_workspace
  for select to authenticated using (public.mega_audit_is_member(id));
drop policy if exists mega_audit_workspace_read_guard on public.mega_audit_workspace;
create policy mega_audit_workspace_read_guard on public.mega_audit_workspace
  as restrictive for select to authenticated using (public.mega_audit_is_member(id));

drop policy if exists mega_audit_members_read on public.mega_audit_members;
create policy mega_audit_members_read on public.mega_audit_members
  for select to authenticated
  using (user_id = auth.uid() or public.mega_audit_is_admin(workspace_id));
drop policy if exists mega_audit_members_read_guard on public.mega_audit_members;
create policy mega_audit_members_read_guard on public.mega_audit_members
  as restrictive for select to authenticated
  using (user_id = auth.uid() or public.mega_audit_is_admin(workspace_id));

drop policy if exists mega_audit_user_keys_read on public.mega_audit_user_keys;
create policy mega_audit_user_keys_read on public.mega_audit_user_keys
  for select to authenticated
  using (user_id = auth.uid() and public.mega_audit_is_member(workspace_id));
drop policy if exists mega_audit_user_keys_read_guard on public.mega_audit_user_keys;
create policy mega_audit_user_keys_read_guard on public.mega_audit_user_keys
  as restrictive for select to authenticated
  using (user_id = auth.uid() and public.mega_audit_is_member(workspace_id));

drop policy if exists mega_audit_records_read on public.mega_audit_records;
create policy mega_audit_records_read on public.mega_audit_records
  for select to authenticated using (public.mega_audit_is_member(workspace_id));
drop policy if exists mega_audit_records_read_guard on public.mega_audit_records;
create policy mega_audit_records_read_guard on public.mega_audit_records
  as restrictive for select to authenticated using (public.mega_audit_is_member(workspace_id));

-- La identidad y la fecha oficiales provienen de Auth y del servidor.
create or replace function public.mega_audit_stamp_record()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Debes iniciar sesión.' using errcode = '42501';
  end if;
  new.created_by := auth.uid();
  new.created_at := now();
  return new;
end;
$$;
revoke all on function public.mega_audit_stamp_record() from public, anon, authenticated;
drop trigger if exists mega_audit_record_stamp on public.mega_audit_records;
create trigger mega_audit_record_stamp before insert on public.mega_audit_records
  for each row execute function public.mega_audit_stamp_record();

-- Verifica rutas canónicas: espacio / usuario / UUID del registro / documento.
create or replace function public.mega_audit_object_access(p_name text, p_write boolean default false)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare
  v_parts text[];
  v_uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_workspace_id uuid;
  v_record_id uuid;
begin
  if auth.uid() is null or p_name is null then return false; end if;
  v_parts := string_to_array(p_name, '/');
  if coalesce(array_length(v_parts, 1), 0) <> 4 then return false; end if;
  if v_parts[1] !~ v_uuid_pattern or v_parts[2] !~ v_uuid_pattern
    or v_parts[3] !~ v_uuid_pattern or v_parts[4] not in ('pdf.bin', 'excel.bin') then
    return false;
  end if;
  v_workspace_id := v_parts[1]::uuid;
  v_record_id := v_parts[3]::uuid;
  if not public.mega_audit_is_member(v_workspace_id) then return false; end if;
  if p_write then
    if v_parts[2]::uuid <> auth.uid() then return false; end if;
    -- El mismo bloqueo que usa el registro evita borrar un archivo mientras
    -- se confirma su salida. VOLATILE permite ver el registro tras esperar.
    perform 1 from public.mega_audit_members m
      where m.workspace_id = v_workspace_id and m.user_id = auth.uid() for update;
    if not found then return false; end if;
    -- Un documento registrado no se reemplaza ni se borra desde la aplicación.
    if exists (select 1 from public.mega_audit_records r
      where r.id = v_record_id and r.workspace_id = v_workspace_id) then return false; end if;
  end if;
  return true;
end;
$$;
revoke all on function public.mega_audit_object_access(text, boolean) from public, anon, authenticated;
-- Anon siempre obtiene false. Permitir ejecutar evita errores en otras políticas
-- de Storage: no concede lectura de documentos ni de tablas.
grant execute on function public.mega_audit_object_access(text, boolean) to anon, authenticated;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('mega-audit-documents', 'mega-audit-documents', false, 27262976,
  array['application/octet-stream'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists mega_audit_docs_read on storage.objects;
create policy mega_audit_docs_read on storage.objects
  for select to authenticated
  using (bucket_id = 'mega-audit-documents' and public.mega_audit_object_access(name, false));
drop policy if exists mega_audit_docs_insert on storage.objects;
create policy mega_audit_docs_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'mega-audit-documents' and public.mega_audit_object_access(name, true));
drop policy if exists mega_audit_docs_delete_orphan on storage.objects;
create policy mega_audit_docs_delete_orphan on storage.objects
  for delete to authenticated
  using (bucket_id = 'mega-audit-documents' and public.mega_audit_object_access(name, true));

-- Guardas restrictivas: políticas amplias de otros buckets no abren este bucket.
drop policy if exists mega_audit_docs_read_guard on storage.objects;
create policy mega_audit_docs_read_guard on storage.objects
  as restrictive for select to anon, authenticated
  using (bucket_id <> 'mega-audit-documents' or public.mega_audit_object_access(name, false));
drop policy if exists mega_audit_docs_insert_guard on storage.objects;
create policy mega_audit_docs_insert_guard on storage.objects
  as restrictive for insert to anon, authenticated
  with check (bucket_id <> 'mega-audit-documents' or public.mega_audit_object_access(name, true));
drop policy if exists mega_audit_docs_delete_guard on storage.objects;
create policy mega_audit_docs_delete_guard on storage.objects
  as restrictive for delete to anon, authenticated
  using (bucket_id <> 'mega-audit-documents' or public.mega_audit_object_access(name, true));
drop policy if exists mega_audit_docs_update_guard on storage.objects;
create policy mega_audit_docs_update_guard on storage.objects
  as restrictive for update to anon, authenticated
  using (bucket_id <> 'mega-audit-documents')
  with check (bucket_id <> 'mega-audit-documents');

create or replace function public.mega_audit_initialize_key(
  p_workspace_id uuid, p_key_fingerprint text, p_wrapped_key text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_current text;
  v_wrapped text;
begin
  if not public.mega_audit_is_admin(p_workspace_id) then
    raise exception 'Solo un administrador puede configurar la clave.' using errcode = '42501';
  end if;
  if p_key_fingerprint is null or p_key_fingerprint !~ '^[0-9a-f]{64}$'
    or p_wrapped_key is null or length(p_wrapped_key) not between 32 and 16384
    or p_wrapped_key !~ '^[A-Za-z0-9+/]+={0,2}$' then
    raise exception 'Huella o clave envuelta inválida.' using errcode = '22023';
  end if;
  select key_fingerprint into v_current from public.mega_audit_workspace
    where id = p_workspace_id for update;
  if not public.mega_audit_is_admin(p_workspace_id) then
    raise exception 'Tu cuenta ya no administra este historial.' using errcode = '42501';
  end if;
  if v_current is not null then
    select wrapped_key into v_wrapped from public.mega_audit_user_keys
      where workspace_id = p_workspace_id and user_id = auth.uid();
    if v_current <> p_key_fingerprint or v_wrapped is distinct from p_wrapped_key then
      raise exception 'Este historial ya tiene una clave de cifrado configurada.' using errcode = '23505';
    end if;
    return jsonb_build_object('key_fingerprint', v_current, 'wrapped_key', v_wrapped);
  end if;
  update public.mega_audit_workspace set key_fingerprint = p_key_fingerprint where id = p_workspace_id;
  insert into public.mega_audit_user_keys(workspace_id, user_id, wrapped_key)
    values (p_workspace_id, auth.uid(), p_wrapped_key);
  return jsonb_build_object('key_fingerprint', p_key_fingerprint, 'wrapped_key', p_wrapped_key);
end;
$$;

create or replace function public.mega_audit_list_members(p_workspace_id uuid)
returns table(user_id uuid, username text, role text, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  if not public.mega_audit_is_admin(p_workspace_id) then
    raise exception 'Solo un administrador puede ver las cuentas.' using errcode = '42501';
  end if;
  return query select m.user_id, split_part(u.email, '@', 1), m.role, m.created_at
    from public.mega_audit_members m join auth.users u on u.id = m.user_id
    where m.workspace_id = p_workspace_id order by m.created_at, m.user_id;
end;
$$;

-- La autoría se muestra a partir de created_by, no de un nombre que el cliente
-- podría escribir en sus metadatos cifrados. También conserva autores retirados.
create or replace function public.mega_audit_authors(p_workspace_id uuid)
returns table(user_id uuid, username text)
language plpgsql security definer set search_path = '' as $$
begin
  if not public.mega_audit_is_member(p_workspace_id) then
    raise exception 'Tu cuenta no tiene acceso a este historial.' using errcode = '42501';
  end if;
  return query select u.id, split_part(u.email, '@', 1)
    from auth.users u where exists (
      select 1 from public.mega_audit_members m
      where m.workspace_id = p_workspace_id and m.user_id = u.id
    ) or exists (
      select 1 from public.mega_audit_records r
      where r.workspace_id = p_workspace_id and r.created_by = u.id
    ) order by u.id;
end;
$$;

create or replace function public.mega_audit_add_member(
  p_workspace_id uuid, p_username text, p_wrapped_key text, p_role text default 'user'
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid;
  v_username text := lower(trim(p_username));
  v_existing_wrapped text;
  v_member public.mega_audit_members%rowtype;
begin
  if not public.mega_audit_is_admin(p_workspace_id) then
    raise exception 'Solo un administrador puede dar acceso.' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('admin', 'user') or v_username is null
    or v_username !~ '^[a-z0-9][a-z0-9_.-]{1,30}[a-z0-9]$' or v_username like '%..%'
    or p_wrapped_key is null or length(p_wrapped_key) not between 32 and 16384
    or p_wrapped_key !~ '^[A-Za-z0-9+/]+={0,2}$' then
    raise exception 'Usuario, permisos o clave envuelta inválidos.' using errcode = '22023';
  end if;
  perform 1 from public.mega_audit_workspace where id = p_workspace_id for update;
  if not public.mega_audit_is_admin(p_workspace_id) then
    raise exception 'Tu cuenta ya no administra este historial.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.mega_audit_workspace w
    where w.id = p_workspace_id and w.key_fingerprint is not null) then
    raise exception 'Primero configura la clave del historial.' using errcode = '22023';
  end if;
  select u.id into v_user_id from auth.users u
    where u.email = v_username || '@usuarios.megaregalonexcel.invalid'
      and u.email_confirmed_at is not null;
  if v_user_id is null then
    raise exception 'Primero hay que crear la cuenta desde la página.' using errcode = '22023';
  end if;
  select * into v_member from public.mega_audit_members m
    where m.workspace_id = p_workspace_id and m.user_id = v_user_id;
  if found then
    select wrapped_key into v_existing_wrapped from public.mega_audit_user_keys k
      where k.workspace_id = p_workspace_id and k.user_id = v_user_id;
    if v_member.role <> p_role or v_existing_wrapped is distinct from p_wrapped_key then
      raise exception 'Ese usuario ya tiene acceso. No se reemplaza su clave ni sus permisos.' using errcode = '23505';
    end if;
    return jsonb_build_object('user_id', v_user_id, 'username', v_username,
      'role', v_member.role, 'created_at', v_member.created_at);
  end if;
  insert into public.mega_audit_members(workspace_id, user_id, role)
    values (p_workspace_id, v_user_id, p_role)
    returning * into v_member;
  insert into public.mega_audit_user_keys(workspace_id, user_id, wrapped_key)
    values (p_workspace_id, v_user_id, p_wrapped_key);
  return jsonb_build_object('user_id', v_member.user_id, 'username', v_username,
    'role', v_member.role, 'created_at', v_member.created_at);
end;
$$;

-- Registra únicamente documentos ya subidos a las dos rutas privadas esperadas.
-- Repetir la misma operación devuelve el mismo registro; no duplica la salida.
create or replace function public.mega_audit_record(
  p_id uuid,
  p_workspace_id uuid,
  p_salida_tag text,
  p_encrypted_metadata text,
  p_idempotency_key uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := auth.uid();
  v_pdf_path text;
  v_excel_path text;
  v_row public.mega_audit_records%rowtype;
begin
  if v_user_id is null or not public.mega_audit_is_member(p_workspace_id) then
    raise exception 'Tu cuenta no tiene acceso a este historial.' using errcode = '42501';
  end if;
  if p_id is null or p_idempotency_key is null or p_salida_tag is null
    or p_salida_tag !~ '^[0-9a-f]{64}$' or p_encrypted_metadata is null
    or length(p_encrypted_metadata) not between 32 and 262144
    or p_encrypted_metadata !~ '^[A-Za-z0-9+/]+={0,2}$' then
    raise exception 'Datos de registro inválidos.' using errcode = '22023';
  end if;
  -- Serializa reintentos por usuario y espacio antes de consultar el resultado.
  perform 1 from public.mega_audit_members m
    where m.workspace_id = p_workspace_id and m.user_id = v_user_id for update;
  if not found then
    raise exception 'Tu cuenta ya no tiene acceso a este historial.' using errcode = '42501';
  end if;
  select * into v_row from public.mega_audit_records r
    where r.workspace_id = p_workspace_id and r.created_by = v_user_id
      and r.idempotency_key = p_idempotency_key;
  if found then
    if v_row.id <> p_id or v_row.salida_tag <> p_salida_tag
      or v_row.encrypted_metadata <> p_encrypted_metadata then
      raise exception 'El identificador de reintento pertenece a otra operación.' using errcode = '23505';
    end if;
    return to_jsonb(v_row);
  end if;
  if not exists (select 1 from public.mega_audit_workspace w
    where w.id = p_workspace_id and w.key_fingerprint is not null) then
    raise exception 'El administrador todavía no configuró la clave de cifrado.' using errcode = '22023';
  end if;
  v_pdf_path := p_workspace_id::text || '/' || v_user_id::text || '/' || p_id::text || '/pdf.bin';
  v_excel_path := p_workspace_id::text || '/' || v_user_id::text || '/' || p_id::text || '/excel.bin';
  if not exists (select 1 from storage.objects o
      where o.bucket_id = 'mega-audit-documents' and o.name = v_pdf_path)
    or not exists (select 1 from storage.objects o
      where o.bucket_id = 'mega-audit-documents' and o.name = v_excel_path) then
    raise exception 'Falta guardar el PDF o el Excel cifrado.' using errcode = '22023';
  end if;
  insert into public.mega_audit_records(id, workspace_id, created_by, salida_tag,
    encrypted_metadata, pdf_path, excel_path, idempotency_key)
    values (p_id, p_workspace_id, v_user_id, p_salida_tag, p_encrypted_metadata,
      v_pdf_path, v_excel_path, p_idempotency_key)
    returning * into v_row;
  return to_jsonb(v_row);
end;
$$;

revoke all on function public.mega_audit_initialize_key(uuid, text, text),
  public.mega_audit_list_members(uuid), public.mega_audit_add_member(uuid, text, text, text),
  public.mega_audit_authors(uuid), public.mega_audit_record(uuid, uuid, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.mega_audit_initialize_key(uuid, text, text),
  public.mega_audit_list_members(uuid), public.mega_audit_add_member(uuid, text, text, text),
  public.mega_audit_authors(uuid), public.mega_audit_record(uuid, uuid, text, text, uuid) to authenticated;

commit;
