/*
 * PostgreSQL tests for the actual Supabase schema, not a JavaScript RLS mock.
 * Run with a development-only PGlite installation:
 *   npm install --prefix /tmp/mega-supabase-test @electric-sql/pglite
 *   NODE_PATH=/tmp/mega-supabase-test/node_modules node --test tests/supabase-sql.test.cjs
 * Supabase supplies the auth/storage schemas simulated below. No network calls
 * or real accounts, company documents, credentials, or production data are used.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

const WORKSPACE = '86551e44-7504-4d30-b453-c9e04b269a43';
const OTHER_WORKSPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ADMIN = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const OUTSIDER = '33333333-3333-4333-8333-333333333333';
const SECOND_ADMIN = '44444444-4444-4444-8444-444444444444';
const WRONG_ALIAS = '55555555-5555-4555-8555-555555555555';
const UNCONFIRMED = '66666666-6666-4666-8666-666666666666';
const RECORD = '77777777-7777-4777-8777-777777777777';
const ORPHAN = '88888888-8888-4888-8888-888888888888';
const REQUEST = '99999999-9999-4999-8999-999999999999';
const FINGERPRINT = 'a'.repeat(64);
const TAG = 'b'.repeat(64);
const ADMIN_WRAP = Buffer.from('synthetic wrapped admin key, not a real secret').toString('base64');
const MEMBER_WRAP = Buffer.from('synthetic wrapped member key, not a real secret').toString('base64');
const METADATA = Buffer.from('synthetic encrypted metadata for database validation only').toString('base64');
const objectPath = (user, record, type, workspace = WORKSPACE) => `${workspace}/${user}/${record}/${type}.bin`;

const bootstrap = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create schema storage;
  create table auth.users (
    id uuid primary key, email text unique not null, email_confirmed_at timestamptz
  );
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create function auth.role() returns text language sql stable as $$
    select nullif(current_setting('request.jwt.claim.role', true), '')
  $$;
  create table storage.buckets (
    id text primary key, name text not null, public boolean default false,
    file_size_limit bigint, allowed_mime_types text[]
  );
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text not null references storage.buckets(id), name text not null,
    owner uuid, metadata jsonb, unique(bucket_id, name)
  );
  alter table storage.objects enable row level security;
  grant usage on schema public, auth, storage to anon, authenticated;
  grant select, insert, update, delete on storage.objects to anon, authenticated;
  -- Deliberately broad pre-existing policies exercise the restrictive guards.
  create policy existing_storage_read on storage.objects for select to anon, authenticated using (true);
  create policy existing_storage_insert on storage.objects for insert to anon, authenticated with check (true);
  create policy existing_storage_update on storage.objects for update to anon, authenticated using (true) with check (true);
  create policy existing_storage_delete on storage.objects for delete to anon, authenticated using (true);
`;

test('Supabase schema enforces membership, key isolation and append-only records in PostgreSQL', {
  skip: !PGlite && 'Install @electric-sql/pglite as documented at the top of this file to run SQL security tests.'
}, async (t) => {
  const db = new PGlite();
  const query = async (sql, values = []) => (await db.query(sql, values)).rows;
  const scalar = async (sql, values = []) => Object.values((await query(sql, values))[0])[0];
  async function as(role, user, work) {
    await db.exec('reset role');
    await query("select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', $2, false)", [user || '', role]);
    await db.exec(`set role ${role}`);
    try { return await work(); } finally { await db.exec('reset role'); }
  }
  async function denies(work, codes = ['42501']) {
    await assert.rejects(work, error => {
      assert.ok(codes.includes(error.code), `${error.code}: ${error.message}`);
      return true;
    });
  }
  async function upload(user, record, type, workspace = WORKSPACE) {
    return query('insert into storage.objects(bucket_id,name,owner) values ($1,$2,$3) returning name',
      ['mega-audit-documents', objectPath(user, record, type, workspace), user]);
  }
  const initialize = (fingerprint = FINGERPRINT, wrapped = ADMIN_WRAP) =>
    scalar('select public.mega_audit_initialize_key($1,$2,$3)', [WORKSPACE, fingerprint, wrapped]);
  const addMember = (username = 'compa', wrapped = MEMBER_WRAP, role = 'user') =>
    scalar('select public.mega_audit_add_member($1,$2,$3,$4)', [WORKSPACE, username, wrapped, role]);
  const record = (id = RECORD, tag = TAG, metadata = METADATA, request = REQUEST, workspace = WORKSPACE) =>
    scalar('select public.mega_audit_record($1,$2,$3,$4,$5)', [id, workspace, tag, metadata, request]);

  try {
    await db.exec(bootstrap);
    const schema = fs.readFileSync(path.join(__dirname, '../supabase/auditoria.sql'), 'utf8');
    await db.exec(schema);
    await db.exec(schema); // Installation can be repeated without changing data.
    const aliases = [
      [ADMIN, 'eddie@usuarios.megaregalonexcel.invalid', true],
      [MEMBER, 'compa@usuarios.megaregalonexcel.invalid', true],
      [OUTSIDER, 'intruso@usuarios.megaregalonexcel.invalid', true],
      [SECOND_ADMIN, 'admin2@usuarios.megaregalonexcel.invalid', true],
      [WRONG_ALIAS, 'mallory@empresa.example', true],
      [UNCONFIRMED, 'pendiente@usuarios.megaregalonexcel.invalid', false]
    ];
    for (const [id, email, confirmed] of aliases) {
      await query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,$3)', [id, email, confirmed ? new Date().toISOString() : null]);
    }
    await query('insert into public.mega_audit_workspace(id) values($1)', [OTHER_WORKSPACE]);
    await query("insert into public.mega_audit_members(workspace_id,user_id,role) values($1,$2,'admin')", [OTHER_WORKSPACE, OUTSIDER]);

    await t.test('registration alone does not grant access or let the first visitor initialize the key', async () => {
      await as('authenticated', ADMIN, async () => {
        assert.deepEqual(await query('select * from public.mega_audit_workspace'), []);
        await denies(initialize);
        await denies(() => query("insert into public.mega_audit_members values($1,$2,'admin',now())", [WORKSPACE, ADMIN]));
      });
      await query("insert into public.mega_audit_members(workspace_id,user_id,role) values($1,$2,'admin')", [WORKSPACE, ADMIN]);
    });

    await t.test('only the explicitly assigned administrator can initialize once, with safe idempotent retries', async () => {
      await as('authenticated', OUTSIDER, () => denies(initialize));
      await as('authenticated', ADMIN, async () => {
        await denies(() => initialize('not-a-fingerprint'), ['22023']);
        await denies(() => initialize(FINGERPRINT, 'invalid!?'), ['22023']);
        assert.deepEqual(await initialize(), { key_fingerprint: FINGERPRINT, wrapped_key: ADMIN_WRAP });
        assert.deepEqual(await initialize(), { key_fingerprint: FINGERPRINT, wrapped_key: ADMIN_WRAP });
        await denies(() => initialize('c'.repeat(64)), ['23505']);
        await denies(() => initialize(FINGERPRINT, MEMBER_WRAP), ['23505']);
      });
      assert.equal(await scalar('select count(*)::int from public.mega_audit_user_keys'), 1);
    });

    await t.test('admin-only enrollment requires the exact confirmed username alias and cannot overwrite access', async () => {
      await as('authenticated', OUTSIDER, () => denies(addMember));
      await as('authenticated', ADMIN, async () => {
        for (const invalid of ['', 'a', '..', 'bad name', 'name..next', 'correo@host', 'Mallory@empresa.example']) {
          await denies(() => addMember(invalid), ['22023']);
        }
        await denies(() => addMember('mallory'), ['22023']);
        await denies(() => addMember('pendiente'), ['22023']);
        await denies(() => addMember('missing'), ['22023']);
        await denies(() => addMember('compa', MEMBER_WRAP, 'owner'), ['22023']);
        const added = await addMember(' Compa ');
        assert.equal(added.user_id, MEMBER);
        assert.equal(added.username, 'compa');
        assert.equal(added.role, 'user');
        assert.deepEqual(await addMember(), added);
        await denies(() => addMember('compa', ADMIN_WRAP), ['23505']);
        await denies(() => addMember('compa', MEMBER_WRAP, 'admin'), ['23505']);
        await addMember('admin2', MEMBER_WRAP, 'admin');
      });
      await as('authenticated', MEMBER, () => denies(() => addMember('intruso')));
    });

    await t.test('each member, including administrators, can read only their own wrapped key', async () => {
      await as('authenticated', MEMBER, async () => {
        const keys = await query('select user_id,wrapped_key from public.mega_audit_user_keys');
        assert.deepEqual(keys, [{ user_id: MEMBER, wrapped_key: MEMBER_WRAP }]);
        const members = await query('select user_id,role from public.mega_audit_members');
        assert.deepEqual(members, [{ user_id: MEMBER, role: 'user' }]);
        await denies(() => query('select * from public.mega_audit_list_members($1)', [WORKSPACE]));
      });
      await as('authenticated', ADMIN, async () => {
        assert.deepEqual(await query('select user_id from public.mega_audit_user_keys'), [{ user_id: ADMIN }]);
        assert.equal((await query('select * from public.mega_audit_list_members($1)', [WORKSPACE])).length, 3);
      });
    });

    await t.test('restrictive guards defeat pre-existing broad policies without breaking other storage buckets', async () => {
      for (const table of ['workspace', 'members', 'user_keys', 'records']) {
        await db.exec(`create policy injected_broad_read on public.mega_audit_${table} for select to authenticated using(true)`);
      }
      await query("insert into storage.buckets(id,name,public) values('other-bucket','other-bucket',false)");
      await query("insert into storage.objects(bucket_id,name) values('other-bucket','public-fixture')");
      await as('authenticated', MEMBER, async () => {
        await upload(MEMBER, ORPHAN, 'pdf');
        await denies(() => upload(ADMIN, ORPHAN, 'excel'));
        await denies(() => upload(MEMBER, ORPHAN, 'excel', OTHER_WORKSPACE));
        await denies(() => query("insert into storage.objects(bucket_id,name) values('mega-audit-documents','../bad.pdf')"));
        assert.equal((await query('select user_id from public.mega_audit_user_keys')).length, 1);
        assert.equal((await query('select id from public.mega_audit_workspace')).length, 1);
      });
      await as('anon', null, async () => {
        assert.deepEqual(await query('select bucket_id,name from storage.objects'), [{ bucket_id: 'other-bucket', name: 'public-fixture' }]);
        await denies(() => upload(MEMBER, RECORD, 'pdf'));
        await denies(() => query('select * from public.mega_audit_workspace'));
        await denies(initialize);
      });
      await as('authenticated', OUTSIDER, async () => {
        assert.deepEqual(await query('select * from public.mega_audit_records where workspace_id=$1', [WORKSPACE]), []);
        assert.equal(await scalar("select count(*)::int from storage.objects where bucket_id='mega-audit-documents'"), 0);
        assert.equal(await scalar('select count(*)::int from public.mega_audit_user_keys'), 0);
      });
    });

    await t.test('only the uploader can delete unregistered objects; update is always denied', async () => {
      await as('authenticated', ADMIN, async () => {
        assert.equal((await query('delete from storage.objects where name=$1 returning name', [objectPath(MEMBER, ORPHAN, 'pdf')])).length, 0);
      });
      await as('authenticated', MEMBER, async () => {
        assert.equal((await query("update storage.objects set metadata='{}' where name=$1 returning name", [objectPath(MEMBER, ORPHAN, 'pdf')])).length, 0);
        assert.equal((await query('delete from storage.objects where name=$1 returning name', [objectPath(MEMBER, ORPHAN, 'pdf')])).length, 1);
      });
    });

    let saved;
    await t.test('recording needs both documents, validates input, and stamps server identity and time', async () => {
      await as('authenticated', MEMBER, async () => {
        await denies(() => record(RECORD, '1234'), ['22023']);
        await denies(() => record(RECORD, TAG, 'bad metadata'), ['22023']);
        await denies(record, ['22023']);
        await upload(MEMBER, RECORD, 'pdf');
        await denies(record, ['22023']);
        await upload(MEMBER, RECORD, 'excel');
        const before = Date.now();
        saved = await record();
        assert.equal(saved.created_by, MEMBER);
        assert.equal(saved.pdf_path, objectPath(MEMBER, RECORD, 'pdf'));
        assert.equal(saved.excel_path, objectPath(MEMBER, RECORD, 'excel'));
        assert.equal(saved.encrypted_metadata, METADATA);
        assert.ok(Math.abs(new Date(saved.created_at).getTime() - before) < 5000);
        assert.deepEqual(await record(), saved);
        await denies(() => record(RECORD, TAG, ADMIN_WRAP), ['23505']);
        await denies(() => record(ORPHAN), ['23505']);
      });
      assert.equal(await scalar('select count(*)::int from public.mega_audit_records'), 1);
    });

    await t.test('approved colleagues can read the shared record and documents, outsiders cannot', async () => {
      await as('authenticated', ADMIN, async () => {
        const rows = await query('select id,created_by from public.mega_audit_records');
        assert.deepEqual(rows, [{ id: RECORD, created_by: MEMBER }]);
        assert.equal(await scalar("select count(*)::int from storage.objects where bucket_id='mega-audit-documents'"), 2);
      });
      await as('authenticated', MEMBER, async () => {
        assert.deepEqual(await query('select * from public.mega_audit_authors($1)', [WORKSPACE]), [
          { user_id: ADMIN, username: 'eddie' },
          { user_id: MEMBER, username: 'compa' },
          { user_id: SECOND_ADMIN, username: 'admin2' }
        ]);
        await denies(() => query('select * from public.mega_audit_authors($1)', [OTHER_WORKSPACE]));
      });
      await as('authenticated', OUTSIDER, async () => {
        assert.equal(await scalar('select count(*)::int from public.mega_audit_records'), 0);
        assert.equal(await scalar("select count(*)::int from storage.objects where bucket_id='mega-audit-documents'"), 0);
        await denies(() => query('select * from public.mega_audit_authors($1)', [WORKSPACE]));
        await denies(() => record(ORPHAN, TAG, METADATA, ORPHAN));
      });
      await as('anon', null, () => denies(() => query('select * from public.mega_audit_authors($1)', [WORKSPACE])));
    });

    await t.test('registered records and documents remain append-only even for their creator or an admin', async () => {
      for (const user of [MEMBER, ADMIN]) {
        await as('authenticated', user, async () => {
          await denies(() => query('update public.mega_audit_records set encrypted_metadata=$1 where id=$2', [ADMIN_WRAP, RECORD]));
          await denies(() => query('delete from public.mega_audit_records where id=$1', [RECORD]));
          await denies(() => query('insert into public.mega_audit_records select * from public.mega_audit_records'));
          await denies(() => query("update public.mega_audit_members set role='admin' where user_id=$1", [MEMBER]));
          assert.equal((await query('delete from storage.objects where name=$1 returning name', [objectPath(MEMBER, RECORD, 'pdf')])).length, 0);
          assert.equal((await query("update storage.objects set metadata='{}' where name=$1 returning name", [objectPath(MEMBER, RECORD, 'pdf')])).length, 0);
          await denies(() => upload(MEMBER, RECORD, 'pdf'));
        });
      }
      assert.equal(await scalar('select count(*)::int from public.mega_audit_records'), 1);
      assert.equal(await scalar("select count(*)::int from storage.objects where bucket_id='mega-audit-documents'"), 2);
    });

    await t.test('revocation removes key access and shared reads while preserving historical records', async () => {
      await query('delete from public.mega_audit_members where workspace_id=$1 and user_id=$2', [WORKSPACE, MEMBER]);
      await as('authenticated', MEMBER, async () => {
        assert.equal(await scalar('select count(*)::int from public.mega_audit_workspace'), 0);
        assert.equal(await scalar('select count(*)::int from public.mega_audit_user_keys'), 0);
        assert.equal(await scalar('select count(*)::int from public.mega_audit_records'), 0);
        assert.equal(await scalar("select count(*)::int from storage.objects where bucket_id='mega-audit-documents'"), 0);
        await denies(() => query('select * from public.mega_audit_authors($1)', [WORKSPACE]));
        await denies(() => record(ORPHAN, TAG, METADATA, ORPHAN));
      });
      await as('authenticated', ADMIN, async () => {
        const authors = await query('select * from public.mega_audit_authors($1)', [WORKSPACE]);
        assert.ok(authors.some(author => author.user_id === MEMBER && author.username === 'compa'),
          'Revoking access must not erase the authoritative author of existing records');
      });
      assert.equal(await scalar('select count(*)::int from public.mega_audit_records'), 1);
    });
  } finally {
    await db.close();
  }
});
