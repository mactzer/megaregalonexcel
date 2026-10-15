import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

spec = importlib.util.spec_from_file_location('mega_restore', Path(__file__).resolve().parents[1] / 'tools/restore-megacontrol.py')
restore = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restore)
W = restore.WORKSPACE
A = '11111111-1111-4111-8111-111111111111'
R = '33333333-3333-4333-8333-333333333333'


class BackupRestoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)
        self.tables = {t: [] for t in restore.TABLES}
        self.tables['mega_audit_workspace'] = [{'id': W, 'key_fingerprint': 'a' * 64}]
        self.tables['mega_audit_members'] = [{'workspace_id': W, 'user_id': A, 'role': 'admin'}]
        self.tables['mega_audit_user_keys'] = [{'workspace_id': W, 'user_id': A, 'wrapped_key': 'Fictitious wrapped key'}]
        row = {'id': R, 'workspace_id': W, 'created_by': A}
        files = []
        for kind in ('pdf', 'excel'):
            name = f'{W}/{A}/{R}/{kind}.bin'
            row[kind + '_path'] = name
            data = b'Fictitious encrypted document for restore tests ' + kind.encode()
            local = self.folder / 'storage/mega-audit-documents' / name
            local.parent.mkdir(parents=True, exist_ok=True)
            local.write_bytes(data)
            files.append({'name': name, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
        self.tables['mega_audit_records'] = [row]
        self.snapshot = {'version': 1, 'workspace_id': W, 'tables': self.tables, 'authors': [{'user_id': A, 'username': 'ficticio'}], 'objects': files}
        (self.folder / 'datos-recuperados.json').write_text(json.dumps({'snapshot': self.snapshot}))
        (self.folder / 'inventario.json').write_text(json.dumps({'workspace': W, 'files': files}))
        self.calls = []

    def tearDown(self):
        self.temp.cleanup()

    def test_price_history_is_restored_without_replacing_current_prices(self):
        self.tables['mega_product_price_history'] = [{'workspace_id': W, 'product_tag': 'b' * 64, 'version': 1, 'updated_by': A, 'updated_at': '2026-10-14T12:00:00Z', 'encrypted_price': 'Fictitious encrypted historical price'}]
        (self.folder / 'datos-recuperados.json').write_text(json.dumps({'snapshot': self.snapshot}))
        snapshot, authors, files = restore.validate(self.folder)
        self.assertIn(A, authors)
        sql = restore.restore_sql(snapshot)
        self.assertIn('insert into public.mega_product_price_history', sql)
        self.assertNotIn('update public.mega_product_prices', sql)
        self.assertIn('on conflict do nothing', sql)

    def api(self, url, token, body=None, method=None, binary=False):
        self.calls.append((url, body, method))
        self.assertTrue(url.startswith('https://api.supabase.com/v1/projects/' + restore.PROJECT + '/') or url.startswith('https://' + restore.PROJECT + '.supabase.co/'))
        if url.endswith('/database/query'):
            if 'select key_fingerprint' in body['query']:
                return [{'key_fingerprint': 'a' * 64}]
            if 'select id::text' in body['query']:
                return [{'id': A}]
            return []
        if url.endswith('/api-keys'):
            return [{'name': 'service_role', 'api_key': 'fictitious-service-token'}]
        name = url.split('/mega-audit-documents/', 1)[1]
        return (self.folder / 'storage/mega-audit-documents' / name).read_bytes()

    def run_restore(self, *args):
        with patch.dict('os.environ', {'MEGACONTROL_SUPABASE_ACCESS_TOKEN': 'fictitious-test-token'}), patch.object(restore, 'request', self.api), contextlib.redirect_stdout(io.StringIO()):
            restore.run([str(self.folder), *args])

    def test_default_is_read_only_and_never_requests_a_service_key(self):
        self.run_restore()
        self.assertEqual(len(self.calls), 2)
        self.assertTrue(all(call[1]['read_only'] for call in self.calls))

    def test_restore_never_overwrites_cloud_files_and_preserves_access_by_default(self):
        self.run_restore('--apply')
        self.assertFalse(any(method == 'POST' for _, _, method in self.calls))
        sql = self.calls[-1][1]
        self.assertFalse(sql['read_only'])
        self.assertNotIn('insert into public.mega_audit_members', sql['query'])
        self.assertNotIn('insert into public.mega_audit_user_keys', sql['query'])
        self.assertNotIn('delete from', sql['query'].lower())

    def test_changed_cloud_file_stops_before_restoring_database(self):
        api = self.api
        def changed(*args, **kwargs):
            result = api(*args, **kwargs)
            return b'different bytes' if kwargs.get('binary') else result
        with patch.dict('os.environ', {'MEGACONTROL_SUPABASE_ACCESS_TOKEN': 'fictitious'}), patch.object(restore, 'request', changed), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(ValueError, 'No se reemplazó'):
                restore.run([str(self.folder), '--apply'])
        self.assertFalse(any(body and body.get('read_only') is False for _, body, _ in self.calls if isinstance(body, dict)))

    def test_corrupt_file_and_foreign_workspace_fail_before_network(self):
        path = self.folder / 'storage/mega-audit-documents' / self.snapshot['objects'][0]['name']
        path.write_bytes(b'corrupt')
        with self.assertRaisesRegex(ValueError, 'alterado'):
            self.run_restore('--apply')
        self.assertEqual(self.calls, [])
        self.snapshot['workspace_id'] = R
        (self.folder / 'datos-recuperados.json').write_text(json.dumps({'snapshot': self.snapshot}))
        with self.assertRaisesRegex(ValueError, 'original'):
            self.run_restore()

    def test_chat_image_inventory_and_missing_message_restore_keep_bucket_and_sequences_separate(self):
        image_id = '33333333-3333-4333-8333-333333333399'
        name = f'{W}/{A}/{image_id}/image.bin'
        data = b'Fictional encrypted chat image for restore validation'
        local = self.folder / 'storage/mega-chat-images' / name
        local.parent.mkdir(parents=True, exist_ok=True)
        local.write_bytes(data)
        item = {'name': name, 'bucket': 'mega-chat-images', 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
        self.snapshot['objects'].append(item)
        self.tables['mega_chat_messages'] = [{'id': image_id, 'seq': 7, 'workspace_id': W, 'created_by': A, 'kind': 'image', 'encrypted_body': 'Fictional cipher', 'parent_id': None, 'case_id': None}]
        self.tables['mega_chat_files'] = [{'id': image_id, 'workspace_id': W, 'uploaded_by': A, 'path': name, 'size': len(data), 'attached': True}]
        (self.folder / 'datos-recuperados.json').write_text(json.dumps({'snapshot': self.snapshot}))
        (self.folder / 'inventario.json').write_text(json.dumps({'workspace': W, 'files': self.snapshot['objects']}))
        snapshot, authors, files = restore.validate(self.folder)
        self.assertIn(name, files)
        self.assertIn(A, authors)
        query = restore.restore_sql(snapshot)
        self.assertIn('insert into public.mega_chat_messages(id,workspace_id,created_by,created_at,kind,encrypted_body,parent_id,case_id)', query)
        self.assertIn('order by seq on conflict do nothing', query)
        self.assertIn('insert into public.mega_chat_files', query)
        self.assertNotIn('update public.mega_chat_messages', query)

    def test_explicit_access_recovery_includes_only_missing_memberships(self):
        self.run_restore('--apply', '--restore-access')
        sql = self.calls[-1][1]['query']
        self.assertIn('insert into public.mega_audit_members', sql)
        self.assertIn('on conflict do nothing', sql)
        self.assertNotIn('update public.mega_audit_members', sql)


if __name__ == '__main__':
    unittest.main()
