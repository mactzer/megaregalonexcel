"""Integration checks for the shared intranet audit, using only temporary data."""

import base64
import datetime
import http.cookiejar
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import uuid
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from intranet.server import create_app, make_server


def sample_workbook():
    """A small genuine OOXML package, without any real company information."""
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", '''<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>''')
        archive.writestr("_rels/.rels", '''<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>''')
        archive.writestr("xl/workbook.xml", '''<?xml version="1.0"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Datos" sheetId="1" r:id="rId1"/></sheets>
</workbook>''')
        archive.writestr("xl/_rels/workbook.xml.rels", '''<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>''')
        archive.writestr("xl/worksheets/sheet1.xml", '''<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>Unidades</t></is></c></row>
<row r="2"><c r="A2"><v>3</v></c></row>
</sheetData></worksheet>''')
    return output.getvalue()


PDF_BYTES = b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n"
XLSX_BYTES = sample_workbook()


class IntranetAuditTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="audit-tests-")
        self.root = Path(self.temporary.name)
        self.data = self.root / "private"
        self.static = self.root / "public"
        self.static.mkdir()
        (self.static / "index.html").write_text(
            '<!DOCTYPE html><html lang="es"><body><p>Prueba local</p></body></html>',
            encoding="utf-8")
        (self.static / "vendor").mkdir()
        (self.static / "vendor" / "example.js").write_text("void 0;", encoding="utf-8")
        self.app = create_app(self.data, static_dir=self.static, admin={
            "username": "admin", "display_name": "Administrador de prueba",
            "password": "Prueba-local-123!",
        })
        self.server = make_server(self.app, host="127.0.0.1", port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        self.client = self.new_client()
        self.csrf = None

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.temporary.cleanup()

    @staticmethod
    def new_client():
        return urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def request(self, path, method="GET", payload=None, *, client=None,
                csrf=True, headers=None):
        request_headers = dict(headers or {})
        data = None
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            request_headers.setdefault("Content-Type", "application/json")
        if csrf and self.csrf:
            request_headers.setdefault("X-CSRF-Token", self.csrf)
        request = urllib.request.Request(self.base + path, data=data,
                                         headers=request_headers, method=method)
        try:
            response = (client or self.client).open(request, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            body = response.read()
            content_type = response.headers.get("Content-Type", "")
            parsed = json.loads(body) if "application/json" in content_type else body
            return response.status, parsed, response.headers

    def login(self, username="admin", password="Prueba-local-123!", client=None):
        status, body, _ = self.request("/api/login", "POST", {
            "username": username, "password": password}, client=client, csrf=False)
        self.assertEqual(status, 200, body)
        if client is None:
            self.csrf = body["csrf_token"]
        return body

    def payload(self, salida="001234"):
        return {
            "salida_numero": salida,
            "row_count": 2,
            "total_units": 3,
            "pdf_name": "Documento de prueba.pdf",
            "pdf_base64": base64.b64encode(PDF_BYTES).decode("ascii"),
            "excel_base64": base64.b64encode(XLSX_BYTES).decode("ascii"),
        }

    def create_record(self, payload=None, key=None):
        return self.request("/api/audits", "POST", payload or self.payload(),
                            headers={"Idempotency-Key": key or str(uuid.uuid4())})

    def create_user(self, username="companero", role="user"):
        status, body, _ = self.request("/api/users", "POST", {
            "username": username, "display_name": "Compañero de prueba",
            "password": "Clave-companero-123!", "role": role,
        })
        self.assertIn(status, (200, 201), body)
        return body.get("user", body)

    def test_anonymous_cannot_read_history_or_documents(self):
        status, body, _ = self.request("/api/status")
        self.assertEqual(status, 200)
        self.assertEqual(body["mode"], "intranet")
        self.assertFalse(body["authenticated"])
        self.assertIsNone(body["user"])
        self.assertFalse(body.get("csrf_token"))
        unknown_record = str(uuid.uuid4())
        for path in ("/api/audits", "/api/users", f"/api/audits/{unknown_record}/pdf",
                     f"/api/audits/{unknown_record}/excel"):
            with self.subTest(path=path):
                status, _, _ = self.request(path)
                self.assertEqual(status, 401)

    def test_login_invalid_password_and_logout(self):
        status, _, _ = self.request("/api/login", "POST", {
            "username": "admin", "password": "incorrecta"}, csrf=False)
        self.assertEqual(status, 401)
        login = self.login()
        self.assertTrue(login["csrf_token"])
        status, body, _ = self.request("/api/status")
        self.assertEqual(status, 200)
        self.assertTrue(body["authenticated"])
        self.assertEqual(body["user"]["username"], "admin")
        self.assertEqual(body["csrf_token"], login["csrf_token"])
        status, _, _ = self.request("/api/logout", "POST", {})
        self.assertIn(status, (200, 204))
        status, _, _ = self.request("/api/audits")
        self.assertEqual(status, 401)

    def test_documents_preserve_exact_bytes_and_zero_prefixed_number(self):
        self.login()
        status, body, _ = self.create_record()
        self.assertIn(status, (200, 201), body)
        record = body["record"]
        self.assertEqual(record["salida_numero"], "001234")
        for kind, expected in (("pdf", PDF_BYTES), ("excel", XLSX_BYTES)):
            self.assertEqual(self.request(
                f"/api/audits/{record['id']}/{kind}", client=self.new_client())[0], 401)
            status, data, headers = self.request(f"/api/audits/{record['id']}/{kind}")
            self.assertEqual(status, 200)
            self.assertEqual(data, expected)
            self.assertIn("attachment", headers["Content-Disposition"])
            if kind == "excel":
                self.assertIn("Salida", headers["Content-Disposition"])
                self.assertIn("001234.xlsx", headers["Content-Disposition"])

    def test_identity_and_timestamp_are_server_values(self):
        self.login()
        payload = self.payload()
        payload.update({"username": "persona-inventada", "user_id": "inventado",
                        "created_at": "2000-01-01T00:00:00Z"})
        status, body, _ = self.create_record(payload)
        # A server may reject caller-supplied identity or ignore it; it must not use it.
        if status == 400:
            status, body, _ = self.create_record()
        self.assertIn(status, (200, 201), body)
        record = body["record"]
        self.assertEqual(record["username"], "admin")
        self.assertEqual(record["user_display_name"], "Administrador de prueba")
        created = datetime.datetime.fromisoformat(record["created_at"].replace("Z", "+00:00"))
        self.assertIsNotNone(created.tzinfo)
        delta = abs((datetime.datetime.now(datetime.timezone.utc) - created).total_seconds())
        self.assertLess(delta, 30)

    def test_search_and_pagination_share_history(self):
        self.login()
        self.create_record(self.payload("1234"))
        self.create_record(self.payload("912345"))
        self.create_record(self.payload("7777"))
        status, body, _ = self.request("/api/audits?q=1234&page=1")
        self.assertEqual(status, 200)
        self.assertEqual(body["total"], 2)
        self.assertEqual({item["salida_numero"] for item in body["records"]}, {"1234", "912345"})
        status, body, _ = self.request("/api/audits?q=sin-coincidencias&page=1")
        self.assertEqual(status, 200)
        self.assertEqual(body["total"], 0)
        self.assertEqual(body["records"], [])

    def test_csrf_and_cross_origin_mutations_rejected(self):
        self.login()
        for headers, csrf in (({}, False), ({"X-CSRF-Token": "incorrecto"}, False),
                              ({"Origin": "https://otro-sitio.example"}, True)):
            with self.subTest(headers=headers):
                status, _, _ = self.request("/api/audits", "POST", self.payload(),
                                            headers=headers, csrf=csrf)
                self.assertEqual(status, 403)
        status, body, _ = self.request("/api/audits")
        self.assertEqual(status, 200)
        self.assertEqual(body["total"], 0)

    def test_public_or_dns_host_cannot_obtain_session_data(self):
        self.login()
        for host in (f"sitio-ajeno.example:{self.server.server_port}",
                     f"8.8.8.8:{self.server.server_port}",
                     f"0.0.0.0:{self.server.server_port}", "127.0.0.1:1"):
            with self.subTest(host=host):
                status, body, _ = self.request("/api/status", headers={"Host": host})
                self.assertEqual(status, 403)
                self.assertNotIn("user", body)
                self.assertNotIn("csrf_token", body)

    def test_idempotent_retry_creates_one_record(self):
        self.login()
        key = str(uuid.uuid4())
        status, first, _ = self.create_record(key=key)
        self.assertIn(status, (200, 201), first)
        status, second, _ = self.create_record(key=key)
        self.assertIn(status, (200, 201), second)
        self.assertEqual(first["record"]["id"], second["record"]["id"])
        status, body, _ = self.create_record(self.payload("4321"), key=key)
        self.assertEqual(status, 409, body)
        changed_document = self.payload()
        changed_document["pdf_base64"] = base64.b64encode(
            b"%PDF-1.4\nUn documento de prueba diferente\n%%EOF\n").decode("ascii")
        status, body, _ = self.create_record(changed_document, key=key)
        self.assertEqual(status, 409, body)
        status, body, _ = self.request("/api/audits")
        self.assertEqual(body["total"], 1)

    def test_invalid_document_payloads_leave_no_partial_history(self):
        self.login()
        unsafe_workbook = io.BytesIO()
        with zipfile.ZipFile(unsafe_workbook, "w") as archive:
            archive.writestr("[Content_Types].xml", "<Types/>")
            archive.writestr("xl/workbook.xml", "<workbook/>")
            archive.writestr("../private.txt", "archivo fuera del paquete")
        variations = (
            {"pdf_base64": "no es base64!"},
            {"pdf_base64": base64.b64encode(b"texto cualquiera").decode()},
            {"excel_base64": base64.b64encode(b"no es un excel").decode()},
            {"excel_base64": base64.b64encode(unsafe_workbook.getvalue()).decode()},
            {"salida_numero": "../123"},
            {"row_count": -1},
            {"total_units": -1},
            {"total_units": float("nan")},
            {"total_units": float("inf")},
        )
        for variation in variations:
            with self.subTest(variation=variation):
                payload = self.payload()
                payload.update(variation)
                status, body, _ = self.create_record(payload)
                self.assertEqual(status, 400, body)
        status, body, _ = self.request("/api/audits")
        self.assertEqual(body["total"], 0)

    def test_regular_user_can_share_records_but_cannot_manage_users(self):
        self.login()
        self.create_user()
        self.request("/api/logout", "POST", {})
        self.login("companero", "Clave-companero-123!")
        status, body, _ = self.create_record(self.payload("999"))
        self.assertIn(status, (200, 201), body)
        self.assertEqual(body["record"]["username"], "companero")
        self.assertEqual(self.request("/api/users")[0], 403)
        self.assertEqual(self.request("/api/users", "POST", {
            "username": "intruso", "display_name": "Intruso", "password": "Otra-clave-123!", "role": "admin",
        })[0], 403)
        self.request("/api/logout", "POST", {})
        self.login()
        status, body, _ = self.request("/api/audits?q=999")
        self.assertEqual(status, 200)
        self.assertEqual(body["total"], 1)
        self.assertEqual(body["records"][0]["username"], "companero")

    def test_disabling_account_invalidates_existing_session(self):
        self.login()
        user = self.create_user()
        other_client = self.new_client()
        self.login("companero", "Clave-companero-123!", client=other_client)
        status, body, _ = self.request(f"/api/users/{user['id']}", "PATCH", {"active": False})
        self.assertEqual(status, 200, body)
        self.assertEqual(self.request("/api/audits", client=other_client)[0], 401)
        status, _, _ = self.request("/api/login", "POST", {
            "username": "companero", "password": "Clave-companero-123!"}, client=other_client, csrf=False)
        self.assertEqual(status, 401)

    def test_only_active_administrator_cannot_be_disabled(self):
        login = self.login()
        admin_id = login["user"]["id"]
        status, body, _ = self.request(f"/api/users/{admin_id}", "PATCH", {"active": False})
        self.assertIn(status, (400, 409), body)
        self.assertEqual(self.request("/api/users")[0], 200)

    def test_private_storage_is_not_a_static_download(self):
        self.login()
        status, body, _ = self.create_record()
        self.assertIn(status, (200, 201), body)
        for path in ("/audit.sqlite3", "/audit.db", "/private/audit.db", "/../private/audit.db",
                     "/%2e%2e/private/audit.db", "/.git/config", "/intranet/server.py"):
            with self.subTest(path=path):
                status, _, _ = self.request(path)
                self.assertIn(status, (400, 403, 404))
        status, contents, _ = self.request("/")
        self.assertEqual(status, 200)
        self.assertIn(b"Prueba local", contents)
        self.assertIn(b'data-audit-required="true"', contents)

    def test_records_survive_reopening_database(self):
        self.login()
        status, body, _ = self.create_record()
        self.assertIn(status, (200, 201), body)
        record_id = body["record"]["id"]
        # Reconstruct the application over the same storage, as at next start.
        reopened = create_app(self.data, static_dir=self.static)
        restarted = make_server(reopened, host="127.0.0.1", port=0)
        thread = threading.Thread(target=restarted.serve_forever, daemon=True)
        thread.start()
        original_base, original_client = self.base, self.client
        self.base = f"http://127.0.0.1:{restarted.server_port}"
        self.client = self.new_client()
        try:
            self.login()
            status, body, _ = self.request("/api/audits")
            self.assertEqual(status, 200)
            self.assertEqual(body["total"], 1)
            self.assertEqual(body["records"][0]["id"], record_id)
            self.assertEqual(self.request(f"/api/audits/{record_id}/pdf")[1], PDF_BYTES)
        finally:
            restarted.shutdown()
            restarted.server_close()
            thread.join(timeout=5)
            self.base, self.client = original_base, original_client

    def test_backup_includes_database_and_original_documents(self):
        self.login()
        status, body, _ = self.create_record()
        self.assertIn(status, (200, 201), body)
        destination = self.root / "respaldo.sqlite3"
        self.app.backup(destination)
        self.assertTrue(destination.is_file())
        with sqlite3.connect(destination) as backup:
            self.assertEqual(backup.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            rows = backup.execute("SELECT pdf_bytes, excel_bytes FROM audits").fetchall()
            self.assertEqual(rows, [(PDF_BYTES, XLSX_BYTES)])


if __name__ == "__main__":
    unittest.main()
