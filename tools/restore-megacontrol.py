#!/usr/bin/env python3
"""Restore a verified MegaControl backup. Read-only unless --apply is provided."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.request

PROJECT = 'aixsnmsmgyejcbtuilwt'
WORKSPACE = '86551e44-7504-4d30-b453-c9e04b269a43'
TABLES = ('mega_audit_workspace', 'mega_audit_members', 'mega_audit_user_keys',
          'mega_audit_records', 'mega_audit_operations', 'mega_product_prices', 'mega_product_queries')
UUID = r'[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def validate(folder):
    snapshot = json.loads((folder / 'datos-recuperados.json').read_text(encoding='utf-8'))['snapshot']
    inventory = json.loads((folder / 'inventario.json').read_text(encoding='utf-8'))
    if snapshot.get('version') != 1 or snapshot.get('workspace_id') != WORKSPACE or inventory.get('workspace') != WORKSPACE:
        raise ValueError('Esta herramienta solo restaura el equipo original de MegaControl.')
    rows = snapshot['tables']
    if set(rows) != set(TABLES) or len(rows['mega_audit_workspace']) != 1:
        raise ValueError('Las tablas del respaldo están incompletas.')
    for table, items in rows.items():
        for row in items:
            if row.get('id' if table == 'mega_audit_workspace' else 'workspace_id') != WORKSPACE:
                raise ValueError('El respaldo incluye otro equipo.')
    if not re.fullmatch('[a-f0-9]{64}', rows['mega_audit_workspace'][0]['key_fingerprint']):
        raise ValueError('Huella de recuperación inválida.')
    authors = {a['user_id'] for a in snapshot['authors']}
    for row in rows['mega_audit_members'] + rows['mega_audit_user_keys']:
        authors.add(row['user_id'])
    for table, field in [('mega_audit_records', 'created_by'), ('mega_product_prices', 'updated_by'),
                         ('mega_product_queries', 'created_by'), ('mega_audit_operations', 'owner_id')]:
        authors.update(row[field] for row in rows[table])
    authors.update(row['reviewed_by'] for row in rows['mega_audit_records'] if row.get('reviewed_by'))
    authors.update(row['import_reviewed_by'] for row in rows['mega_audit_records'] if row.get('import_reviewed_by'))
    if any(not re.fullmatch(UUID, a) for a in authors):
        raise ValueError('Identidad de autor inválida.')
    files = {}
    for item in inventory['files']:
        name = item['name']
        if not re.fullmatch(WORKSPACE + '/' + UUID + '/' + UUID + r'/(pdf|excel)\.bin', name) or name in files:
            raise ValueError('Ruta de documento inválida o duplicada.')
        local = folder / 'storage' / 'mega-audit-documents' / name
        data = local.read_bytes()
        if len(data) != item['size'] or not 29 <= len(data) <= 25 * 1024 * 1024 + 64 or hashlib.sha256(data).hexdigest() != item['sha256']:
            raise ValueError('Documento incompleto o alterado: ' + name)
        files[name] = (local, item['sha256'])
    if set(files) != {o['name'] for o in snapshot['objects']}:
        raise ValueError('Faltan documentos del inventario.')
    for row in rows['mega_audit_records']:
        for kind in ('pdf', 'excel'):
            expected = f"{WORKSPACE}/{row['created_by']}/{row['id']}/{kind}.bin"
            if row[kind + '_path'] != expected or expected not in files:
                raise ValueError('Falta un documento de la salida.')
    return snapshot, authors, files


def request(url, token, body=None, method=None, binary=False):
    headers = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/octet-stream' if binary else 'application/json'}
    if url.startswith(f'https://{PROJECT}.supabase.co/'):
        headers['apikey'] = token
    elif not url.startswith(f'https://api.supabase.com/v1/projects/{PROJECT}/'):
        raise ValueError('Destino ajeno a MegaControl.')
    if binary:
        headers['x-upsert'] = 'false'
    payload = body if binary else None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=payload, headers=headers, method=method)
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            raise ValueError('El servicio intentó redirigir la solicitud. No se enviaron credenciales a otro destino.')
    with urllib.request.build_opener(NoRedirect()).open(req, timeout=60) as response:
        result = response.read()
        return result if binary else json.loads(result) if result else None


def restore_sql(snapshot, restore_access=False):
    fingerprint = snapshot['tables']['mega_audit_workspace'][0]['key_fingerprint']
    if not re.fullmatch('[a-f0-9]{64}', fingerprint):
        raise ValueError('Huella de recuperación inválida.')
    lines = ['begin;', "set local lock_timeout='10s';", 'set local standard_conforming_strings=on;', 'do $mega_restore$',
             'declare v_fingerprint text := ' + literal(fingerprint) + '; v_workspace uuid := ' + literal(WORKSPACE) + '::uuid;',
             'begin', 'perform 1 from public.mega_audit_workspace where id=v_workspace for update;',
             "if exists(select 1 from public.mega_audit_workspace where id=v_workspace and key_fingerprint is not null and key_fingerprint<>v_fingerprint) then raise exception 'La clave del equipo no coincide.'; end if;",
             'end $mega_restore$;',
             'alter table public.mega_audit_records disable trigger mega_audit_record_stamp;',
             'alter table public.mega_audit_records disable trigger mega_audit_operation_guard;']
    for table in TABLES:
        if not restore_access and table in ('mega_audit_members', 'mega_audit_user_keys'):
            continue
        source_rows = snapshot['tables'][table]
        if table == 'mega_audit_records':
            source_rows = [dict(row, document_kind=row.get('document_kind') or 'salida', import_revision=row.get('import_revision') or 0) for row in source_rows]
        rows = literal(json.dumps(source_rows, ensure_ascii=True, separators=(',', ':')))
        lines.append(f'insert into public.{table} select * from jsonb_populate_recordset(null::public.{table},{rows}::jsonb) on conflict do nothing;')
    lines.append('update public.mega_audit_workspace set key_fingerprint=' + literal(fingerprint) + ' where id=' + literal(WORKSPACE) + '::uuid and key_fingerprint is null;')
    lines.extend(['alter table public.mega_audit_records enable trigger mega_audit_record_stamp;',
                  'alter table public.mega_audit_records enable trigger mega_audit_operation_guard;', 'commit;'])
    return '\n'.join(lines)


def run(argv=None):
    parser = argparse.ArgumentParser(description='Verifica o restaura faltantes de MegaControl sin borrar ni sobrescribir datos existentes.')
    parser.add_argument('folder', type=Path, help='Carpeta MegaControl-recuperado-... de recuperar.html')
    parser.add_argument('--apply', action='store_true', help='Subir archivos e insertar datos faltantes en el proyecto original')
    parser.add_argument('--restore-access', action='store_true', help='Además recuperar membresías y claves envueltas faltantes; puede volver a aprobar usuarios revocados')
    args = parser.parse_args(argv)
    snapshot, authors, files = validate(args.folder)
    token = os.environ.get('MEGACONTROL_SUPABASE_ACCESS_TOKEN')
    if not token:
        raise ValueError('Falta MEGACONTROL_SUPABASE_ACCESS_TOKEN en el entorno; no pegues la credencial en el código.')
    management = f'https://api.supabase.com/v1/projects/{PROJECT}'

    def sql(query, read_only=True):
        return request(management + '/database/query', token, {'query': query, 'read_only': read_only})

    existing = sql('select key_fingerprint from public.mega_audit_workspace where id=' + literal(WORKSPACE) + '::uuid')
    if existing and existing[0]['key_fingerprint'] not in (None, snapshot['tables']['mega_audit_workspace'][0]['key_fingerprint']):
        raise ValueError('La base activa utiliza otra clave. No se ha modificado.')
    known = sql('select id::text from auth.users where id in (' + ','.join(literal(a) + '::uuid' for a in sorted(authors)) + ')') if authors else []
    if {r['id'] for r in known} != authors:
        raise ValueError('Faltan cuentas de Supabase Auth. Recupera primero esas identidades; el respaldo no contiene sus contraseñas.')
    print(f"Respaldo válido: {len(snapshot['tables']['mega_audit_records'])} registros y {len(files)} documentos. Proyecto MegaControl verificado.")
    if not args.apply:
        print('Simulación completa. No se ha escrito nada. Para restaurar faltantes usa --apply.')
        return
    keys = request(management + '/api-keys', token)
    service = next((k['api_key'] for k in keys if k.get('name') == 'service_role'), None)
    if not service:
        raise ValueError('No se obtuvo la clave de servicio del proyecto original.')
    storage = f'https://{PROJECT}.supabase.co/storage/v1/object/'
    uploaded = 0
    for name, (local, digest) in files.items():
        remote_path = 'mega-audit-documents/' + name
        try:
            remote = request(storage + 'authenticated/' + remote_path, service, binary=True)
        except urllib.error.HTTPError as error:
            if error.code != 404:
                raise
            data = local.read_bytes()
            request(storage + remote_path, service, data, method='POST', binary=True)
            remote = request(storage + 'authenticated/' + remote_path, service, binary=True)
            uploaded += 1
        if hashlib.sha256(remote).hexdigest() != digest:
            raise ValueError('Existe otro documento en la misma ruta. No se reemplazó: ' + name)
    sql(restore_sql(snapshot, args.restore_access), read_only=False)
    print(f'Restauración terminada: {uploaded} archivos faltantes subidos. Los datos existentes se conservaron.')


if __name__ == '__main__':
    try:
        run()
    except Exception as error:
        message = f'El servicio rechazó la operación (HTTP {error.code}).' if isinstance(error, urllib.error.HTTPError) else str(error)
        print('Restauración detenida: ' + message, file=sys.stderr)
        sys.exit(1)
