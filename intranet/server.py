#!/usr/bin/env python3
"""Serve the converter and its shared audit entirely on an internal computer.

The database contains passwords, sessions, original PDFs and generated workbooks.
Keep its directory private and back it up to a company-approved destination. This
is an application history, not a tamper-proof archive against the computer owner.
HTTP keeps storage local but does not encrypt traffic; configure the optional TLS
certificate for an internal HTTPS deployment. No cloud service is contacted.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import datetime as dt
import getpass
import hashlib
import hmac
import io
import ipaddress
import json
import math
import mimetypes
import os
from pathlib import Path
import re
import secrets
import socket
import sqlite3
import ssl
import sys
import tempfile
import threading
import time
from http import HTTPStatus
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlsplit
import uuid
import xml.etree.ElementTree as ET
import zipfile


PASSWORD_ITERATIONS = 600_000
SESSION_SECONDS = 8 * 60 * 60
FILE_LIMIT = 25 * 1024 * 1024
JSON_LIMIT = 2 * ((FILE_LIMIT + 2) // 3 * 4) + 64 * 1024
PAGE_SIZE = 25
COOKIE_NAME = "mega_audit_session"
USERNAME_PATTERN = re.compile(r"[a-zA-Z0-9_.-]{3,64}\Z")
SALIDA_PATTERN = re.compile(r"[0-9]{1,60}\Z")
STATIC_PATHS = {
    "/": "index.html",
    "/index.html": "index.html",
    "/audit.html": "audit.html",
    "/audit.js": "audit.js",
    "/audit.css": "audit.css",
    "/excel-table.js": "excel-table.js",
    "/vendor/pdf.min.js": "vendor/pdf.min.js",
    "/vendor/pdf.worker.min.js": "vendor/pdf.worker.min.js",
    "/vendor/xlsx.full.min.js": "vendor/xlsx.full.min.js",
    "/.nojekyll": ".nojekyll",
}
CSP = (
    "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; "
    "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
    "font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; "
    "base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'"
)


class APIError(Exception):
    def __init__(self, status: int, message: str, **extra: object):
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra


class AuditConnection(sqlite3.Connection):
    """Commit or roll back and close each short-lived database connection."""

    def __exit__(self, exc_type, exc_value, traceback):
        try:
            return super().__exit__(exc_type, exc_value, traceback)
        finally:
            self.close()


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def password_hash(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS)
    return f"pbkdf2_sha256${PASSWORD_ITERATIONS}${salt.hex()}${digest.hex()}"


def password_matches(password: str, encoded: str) -> bool:
    try:
        algorithm, iterations, salt, expected = encoded.split("$")
        if algorithm != "pbkdf2_sha256":
            return False
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), int(iterations))
        return hmac.compare_digest(actual, bytes.fromhex(expected))
    except (TypeError, ValueError, OverflowError):
        return False


def user_dict(row: sqlite3.Row) -> dict:
    return {"id": row["id"], "username": row["username"], "display_name": row["display_name"], "role": row["role"]}


def record_dict(row: sqlite3.Row) -> dict:
    return {key: row[key] for key in (
        "id", "salida_numero", "created_at", "user_display_name", "username",
        "pdf_name", "excel_name", "row_count", "total_units",
    )}


class AuditApplication:
    """Storage and configuration shared by the HTTP handler threads."""

    def __init__(self, data_dir: str | Path, static_dir: str | Path | None = None, admin: dict | None = None):
        self.data_dir = Path(data_dir).expanduser().resolve()
        self.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.database_path = self.data_dir / "auditoria.sqlite3"
        self.static_dir = Path(static_dir or Path(__file__).resolve().parents[1]).resolve()
        self._throttle_lock = threading.Lock()
        self._login_attempts: dict[tuple[str, str], list[float]] = {}
        self._upload_slots = threading.BoundedSemaphore(2)
        self._dummy_hash = password_hash(secrets.token_urlsafe(24))
        self._initialize()
        if admin is not None and not self.has_users():
            self.create_user(admin["username"], admin["display_name"], admin["password"], "admin")

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=30, factory=AuditConnection)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 30000")
        return connection

    def _initialize(self) -> None:
        with self.connect() as connection:
            version = connection.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, 1):
                raise RuntimeError("La base de datos pertenece a una versión no compatible.")
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY,
                    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
                    display_name TEXT NOT NULL,
                    password_hash TEXT NOT NULL,
                    role TEXT NOT NULL CHECK (role IN ('user', 'admin')),
                    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id),
                    csrf_token TEXT NOT NULL,
                    expires_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS audits (
                    id TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id),
                    idempotency_key TEXT NOT NULL,
                    salida_numero TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    user_display_name TEXT NOT NULL,
                    username TEXT NOT NULL,
                    pdf_name TEXT NOT NULL,
                    excel_name TEXT NOT NULL,
                    row_count INTEGER NOT NULL,
                    total_units REAL NOT NULL,
                    pdf_bytes BLOB NOT NULL,
                    excel_bytes BLOB NOT NULL,
                    UNIQUE (user_id, idempotency_key)
                );
                CREATE INDEX IF NOT EXISTS audits_created ON audits(created_at DESC, id DESC);
                CREATE INDEX IF NOT EXISTS audits_salida ON audits(salida_numero);
                CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
                PRAGMA user_version = 1;
            """)
        if os.name != "nt":
            os.chmod(self.data_dir, 0o700)
            os.chmod(self.database_path, 0o600)

    def has_users(self) -> bool:
        with self.connect() as connection:
            return connection.execute("SELECT 1 FROM users LIMIT 1").fetchone() is not None

    def create_user(self, username: str, display_name: str, password: str, role: str = "user") -> dict:
        if not isinstance(username, str) or not USERNAME_PATTERN.fullmatch(username.strip()):
            raise APIError(400, "El usuario debe tener de 3 a 64 letras, números, puntos, guiones o guiones bajos.")
        if not isinstance(display_name, str) or not 1 <= len(display_name.strip()) <= 120 or any(ord(c) < 32 for c in display_name):
            raise APIError(400, "Indica un nombre de 1 a 120 caracteres.")
        if not isinstance(password, str) or not 10 <= len(password) <= 1024:
            raise APIError(400, "La contraseña debe tener entre 10 y 1024 caracteres.")
        if role not in ("user", "admin"):
            raise APIError(400, "El rol debe ser user o admin.")
        encoded = password_hash(password)
        try:
            with self.connect() as connection:
                cursor = connection.execute(
                    "INSERT INTO users(username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)",
                    (username.strip().lower(), display_name.strip(), encoded, role, utc_now()),
                )
                row = connection.execute("SELECT * FROM users WHERE id = ?", (cursor.lastrowid,)).fetchone()
                return user_dict(row) | {"active": True}
        except sqlite3.IntegrityError as error:
            raise APIError(409, "Ese usuario ya existe.") from error

    def login(self, username: str, password: str, ip: str) -> tuple[dict, str, str]:
        if not isinstance(username, str) or not isinstance(password, str) or len(username) > 64 or len(password) > 1024:
            raise APIError(400, "Indica un usuario y una contraseña válidos.")
        normalized = username.strip().lower()
        now = time.time()
        throttle_key = (ip, normalized)
        with self._throttle_lock:
            attempts = [moment for moment in self._login_attempts.get(throttle_key, []) if moment > now - 900]
            ip_attempts = [moment for moment in self._login_attempts.get((ip, ""), []) if moment > now - 900]
            if len(attempts) >= 5 or len(ip_attempts) >= 30:
                raise APIError(429, "Demasiados intentos. Espera 15 minutos antes de volver a intentar.", retry_after=900)
            self._login_attempts[throttle_key] = attempts + [now]
            self._login_attempts[(ip, "")] = ip_attempts + [now]
            if len(self._login_attempts) > 5000:
                self._login_attempts = {key: value for key, value in self._login_attempts.items() if value and value[-1] > now - 900}
        with self.connect() as connection:
            row = connection.execute("SELECT * FROM users WHERE username = ?", (normalized,)).fetchone()
            valid = password_matches(password, row["password_hash"] if row else self._dummy_hash)
            if not valid or row is None or not row["active"]:
                raise APIError(401, "Usuario o contraseña incorrectos.")
            token = secrets.token_urlsafe(32)
            csrf_token = secrets.token_urlsafe(32)
            connection.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
            connection.execute(
                "INSERT INTO sessions(token_hash, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)",
                (hashlib.sha256(token.encode()).hexdigest(), row["id"], csrf_token, now + SESSION_SECONDS),
            )
        with self._throttle_lock:
            self._login_attempts.pop(throttle_key, None)
            # Successful attempts do not exhaust the shared-IP failure allowance.
            global_attempts = self._login_attempts.get((ip, ""), [])
            if now in global_attempts:
                global_attempts.remove(now)
        return user_dict(row), token, csrf_token

    def session(self, token: str | None) -> dict | None:
        if not token or len(token) > 128:
            return None
        token_digest = hashlib.sha256(token.encode()).hexdigest()
        with self.connect() as connection:
            row = connection.execute(
                "SELECT users.*, sessions.csrf_token FROM sessions JOIN users ON users.id = sessions.user_id "
                "WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.active = 1",
                (token_digest, time.time()),
            ).fetchone()
        return {"user": user_dict(row), "csrf_token": row["csrf_token"], "token_hash": token_digest} if row else None

    def set_user_active(self, user_id: int, active: bool) -> dict:
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
            if row is None:
                raise APIError(404, "Usuario no encontrado.")
            if not active and row["active"] and row["role"] == "admin":
                admins = connection.execute("SELECT COUNT(*) FROM users WHERE active = 1 AND role = 'admin'").fetchone()[0]
                if admins <= 1:
                    raise APIError(409, "Debe permanecer al menos un administrador activo.")
            connection.execute("UPDATE users SET active = ? WHERE id = ?", (int(active), user_id))
            if not active:
                connection.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
            return user_dict(row) | {"active": active}

    def backup(self, destination: str | Path) -> Path:
        destination = Path(destination).expanduser().resolve()
        if destination == self.database_path:
            raise ValueError("El respaldo debe guardarse en un archivo distinto de la base de datos.")
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        descriptor, temporary_name = tempfile.mkstemp(prefix=".auditoria-respaldo-", suffix=".sqlite3", dir=destination.parent)
        os.close(descriptor)
        temporary = Path(temporary_name)
        try:
            with self.connect() as source, sqlite3.connect(temporary, factory=AuditConnection) as target:
                source.backup(target)
            os.replace(temporary, destination)
        finally:
            temporary.unlink(missing_ok=True)
        return destination


def create_app(data_dir: str | Path, static_dir: str | Path | None = None, admin: dict | None = None) -> AuditApplication:
    return AuditApplication(data_dir, static_dir, admin)


def _json_constant(_: str) -> None:
    raise ValueError("Los números JSON deben ser finitos.")


def _unique_json_pairs(pairs: list[tuple[str, object]]) -> dict:
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Un campo JSON está repetido.")
        value[key] = item
    return value


def _decode_file(value: object, label: str) -> bytes:
    if not isinstance(value, str) or not value or len(value) > ((FILE_LIMIT + 2) // 3) * 4:
        raise APIError(413, f"El archivo {label} debe tener como máximo 25 MB.")
    try:
        content = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error) as error:
        raise APIError(400, f"El archivo {label} no tiene una codificación válida.") from error
    if not content or len(content) > FILE_LIMIT:
        raise APIError(413, f"El archivo {label} debe tener como máximo 25 MB.")
    return content


def _validate_excel(content: bytes) -> None:
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            entries = archive.infolist()
            if len(entries) > 2000 or sum(entry.file_size for entry in entries) > 256 * 1024 * 1024:
                raise ValueError("Libro demasiado grande.")
            if any(entry.flag_bits & 1 or entry.filename.startswith(("/", "\\")) or ".." in entry.filename.replace("\\", "/").split("/") for entry in entries):
                raise ValueError("Estructura de libro inválida.")
            required = ("[Content_Types].xml", "xl/workbook.xml")
            for name in required:
                info = archive.getinfo(name)
                if info.file_size > 2 * 1024 * 1024:
                    raise ValueError("Metadatos de libro demasiado grandes.")
            content_types = ET.fromstring(archive.read(required[0]))
            workbook = ET.fromstring(archive.read(required[1]))
            if content_types.tag.rsplit("}", 1)[-1] != "Types" or workbook.tag.rsplit("}", 1)[-1] != "workbook":
                raise ValueError("El archivo no es un libro Excel.")
    except (zipfile.BadZipFile, KeyError, ValueError, RuntimeError, ET.ParseError, OSError) as error:
        raise APIError(400, "El documento Excel debe ser un archivo .xlsx válido.") from error


def _pdf_name(value: object) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 255:
        raise APIError(400, "Indica el nombre del PDF original.")
    name = value.replace("\\", "/").rsplit("/", 1)[-1].strip()
    if not name or any(ord(character) < 32 or ord(character) == 127 for character in name):
        raise APIError(400, "El nombre del PDF no es válido.")
    return name


class AuditRequestHandler(BaseHTTPRequestHandler):
    server_version = "AuditoriaInterna/1"
    protocol_version = "HTTP/1.1"

    @property
    def app(self) -> AuditApplication:
        return self.server.app

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(30)

    def log_message(self, format: str, *args: object) -> None:
        # Do not write search terms, document names or audit data to access logs.
        pass

    def _security_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")

    def _send(self, status: int, content: bytes, mime_type: str, **headers: str) -> None:
        self.send_response(status)
        self._security_headers()
        self.send_header("Content-Type", mime_type)
        self.send_header("Content-Length", str(len(content)))
        for key, value in headers.items():
            self.send_header(key.replace("_", "-"), value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(content)

    def _json(self, status: int, payload: dict, **headers: str) -> None:
        self._send(status, json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8"), "application/json; charset=utf-8", **headers)

    def send_error(self, code: int, message: str | None = None, explain: str | None = None) -> None:
        self._json(code, {"error": message or HTTPStatus(code).phrase})

    def _request_authority(self) -> tuple[str, int]:
        values = self.headers.get_all("Host", [])
        if len(values) != 1:
            raise APIError(403, "Usa la dirección IP interna de este equipo.")
        try:
            authority = urlsplit("//" + values[0])
            hostname = authority.hostname
            if not hostname or authority.username or authority.password or authority.path or authority.query or authority.fragment:
                raise ValueError("Host inválido.")
            port = authority.port or (443 if self.server.is_tls else 80)
            if port != self.server.server_port:
                raise ValueError("Puerto inválido.")
            if hostname.lower() != "localhost":
                address = ipaddress.ip_address(hostname)
                if address.is_unspecified or not (address.is_private or address.is_loopback or address.is_link_local):
                    raise ValueError("La dirección debe ser interna.")
            return hostname.lower(), port
        except ValueError as error:
            raise APIError(403, "Usa la dirección IP interna de este equipo y el puerto configurado.") from error

    def _origin(self, authority: tuple[str, int]) -> None:
        values = self.headers.get_all("Origin", [])
        if not values:
            return
        if len(values) != 1:
            raise APIError(403, "Origen no permitido.")
        try:
            origin = urlsplit(values[0])
            port = origin.port or (443 if origin.scheme == "https" else 80)
            if origin.scheme != ("https" if self.server.is_tls else "http") or (origin.hostname, port) != authority or origin.path or origin.query or origin.fragment or origin.username or origin.password:
                raise ValueError("Origen no permitido.")
        except ValueError as error:
            raise APIError(403, "Origen no permitido.") from error

    def _current_session(self) -> dict | None:
        try:
            cookie = SimpleCookie()
            cookie.load(self.headers.get("Cookie", ""))
            token = cookie[COOKIE_NAME].value if COOKIE_NAME in cookie else None
            return self.app.session(token)
        except CookieError:
            return None

    def _require_session(self) -> dict:
        session = self._current_session()
        if not session:
            raise APIError(401, "Inicia sesión para usar la auditoría compartida.")
        return session

    def _csrf(self, session: dict) -> None:
        values = self.headers.get_all("X-CSRF-Token", [])
        if len(values) != 1 or not hmac.compare_digest(values[0].encode("utf-8"), session["csrf_token"].encode("utf-8")):
            raise APIError(403, "La sesión cambió. Inicia sesión de nuevo.")

    def _body(self, limit: int = 64 * 1024) -> dict:
        if self.headers.get("Transfer-Encoding"):
            self.close_connection = True
            raise APIError(400, "Indica el tamaño de la solicitud.")
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) != 1 or not re.fullmatch(r"[0-9]+", lengths[0]):
            self.close_connection = True
            raise APIError(411, "Indica el tamaño de la solicitud.")
        size = int(lengths[0])
        if not 0 < size <= limit:
            self.close_connection = True
            raise APIError(413, "La solicitud supera el tamaño permitido.")
        if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
            self.close_connection = True
            raise APIError(415, "La solicitud debe usar application/json.")
        try:
            raw = self.rfile.read(size)
            if len(raw) != size:
                raise ValueError("Solicitud incompleta.")
            value = json.loads(raw.decode("utf-8"), parse_constant=_json_constant, object_pairs_hook=_unique_json_pairs)
        except (UnicodeError, ValueError, RecursionError) as error:
            raise APIError(400, "La solicitud JSON no es válida.") from error
        if not isinstance(value, dict):
            raise APIError(400, "La solicitud debe ser un objeto JSON.")
        return value

    def _cookie(self, token: str, logout: bool = False) -> str:
        value = f"{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={0 if logout else SESSION_SECONDS}"
        return value + ("; Secure" if self.server.is_tls else "")

    def _download(self, audit_id: str, kind: str) -> None:
        self._require_session()
        field = "pdf" if kind == "pdf" else "excel"
        with self.app.connect() as connection:
            row = connection.execute(f"SELECT {field}_name AS name, {field}_bytes AS content FROM audits WHERE id = ?", (audit_id,)).fetchone()
        if row is None:
            raise APIError(404, "Salida no encontrada.")
        name = row["name"]
        ascii_name = re.sub(r'[^a-zA-Z0-9_. ()-]', "_", name)
        disposition = f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{quote(name, safe="")}'
        content_type = "application/pdf" if field == "pdf" else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        self._send(200, row["content"], content_type, Content_Disposition=disposition)

    def _list_audits(self, query: str) -> None:
        self._require_session()
        parameters = parse_qs(query, max_num_fields=20)
        search = parameters.get("q", [""])[0].strip()
        page_value = parameters.get("page", ["1"])[0]
        if len(search) > 100 or not re.fullmatch(r"[0-9]{1,7}", page_value) or not 1 <= int(page_value) <= 1_000_000:
            raise APIError(400, "La búsqueda o la página no son válidas.")
        page = int(page_value)
        where, values = "", []
        if search:
            escaped = search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            where = " WHERE salida_numero LIKE ? ESCAPE '\\' OR user_display_name LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\'"
            values = [f"%{escaped}%"] * 3
        with self.app.connect() as connection:
            count = connection.execute("SELECT COUNT(*) FROM audits" + where, values).fetchone()[0]
            rows = connection.execute(
                "SELECT id, salida_numero, created_at, user_display_name, username, pdf_name, excel_name, row_count, total_units FROM audits" + where + " ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
                values + [PAGE_SIZE, (page - 1) * PAGE_SIZE],
            ).fetchall()
        self._json(200, {"records": [record_dict(row) for row in rows], "total": count, "page": page, "page_size": PAGE_SIZE})

    def _store_audit(self, session: dict) -> None:
        if not self.app._upload_slots.acquire(blocking=False):
            self.close_connection = True
            raise APIError(503, "Hay otros documentos guardándose. Intenta de nuevo en unos segundos.")
        try:
            data = self._body(JSON_LIMIT)
            number = data.get("salida_numero")
            if not isinstance(number, str) or not SALIDA_PATTERN.fullmatch(number):
                raise APIError(400, "La salida debe contener únicamente de 1 a 60 dígitos.")
            row_count = data.get("row_count")
            units = data.get("total_units")
            if isinstance(row_count, bool) or not isinstance(row_count, int) or not 0 <= row_count <= 10_000_000:
                raise APIError(400, "La cantidad de filas no es válida.")
            if isinstance(units, bool) or not isinstance(units, (int, float)) or not 0 <= units <= 1_000_000_000_000 or not math.isfinite(units):
                raise APIError(400, "El total de unidades no es válido.")
            pdf_name = _pdf_name(data.get("pdf_name"))
            pdf_content = _decode_file(data.get("pdf_base64"), "PDF")
            if not pdf_content.startswith(b"%PDF-"):
                raise APIError(400, "El documento original debe ser un PDF válido.")
            excel_content = _decode_file(data.get("excel_base64"), "Excel")
            _validate_excel(excel_content)
            keys = self.headers.get_all("Idempotency-Key", [])
            if len(keys) > 1:
                raise APIError(400, "La clave de registro no es válida.")
            try:
                idempotency_key = str(uuid.UUID(keys[0])) if keys else str(uuid.uuid4())
            except ValueError as error:
                raise APIError(400, "La clave de registro no es válida.") from error
            actor = session["user"]
            with self.app.connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                # Recheck account/session under the same write lock as insertion.
                valid_session = connection.execute(
                    "SELECT 1 FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.active = 1",
                    (session["token_hash"], time.time()),
                ).fetchone()
                if valid_session is None:
                    raise APIError(401, "La sesión venció. Inicia sesión de nuevo antes de guardar.")
                previous = connection.execute("SELECT * FROM audits WHERE user_id = ? AND idempotency_key = ?", (actor["id"], idempotency_key)).fetchone()
                if previous:
                    unchanged = (
                        previous["salida_numero"] == number
                        and previous["row_count"] == row_count
                        and previous["total_units"] == float(units)
                        and previous["pdf_name"] == pdf_name
                        and previous["pdf_bytes"] == pdf_content
                        and previous["excel_bytes"] == excel_content
                    )
                    if not unchanged:
                        raise APIError(409, "Esa clave ya corresponde a otro documento. Genera una nueva salida antes de volver a guardar.")
                    record, status = record_dict(previous), 200
                else:
                    audit_id = str(uuid.uuid4())
                    connection.execute(
                        "INSERT INTO audits(id, user_id, idempotency_key, salida_numero, created_at, user_display_name, username, pdf_name, excel_name, row_count, total_units, pdf_bytes, excel_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (audit_id, actor["id"], idempotency_key, number, utc_now(), actor["display_name"], actor["username"], pdf_name, f"Salida {number}.xlsx", row_count, float(units), pdf_content, excel_content),
                    )
                    record = record_dict(connection.execute("SELECT * FROM audits WHERE id = ?", (audit_id,)).fetchone())
                    status = 201
            self._json(status, {"record": record})
        finally:
            self.app._upload_slots.release()

    def _dispatch(self) -> None:
        authority = self._request_authority()
        parsed = urlsplit(self.path)
        if parsed.scheme or parsed.netloc:
            raise APIError(400, "La dirección de solicitud no es válida.")
        path = unquote(parsed.path)
        mutation = self.command in ("POST", "PATCH", "PUT", "DELETE")
        if mutation:
            self._origin(authority)
        if self.command in ("GET", "HEAD"):
            if path == "/api/status":
                session = self._current_session()
                status = {"mode": "intranet", "authenticated": bool(session), "user": session["user"] if session else None}
                if session:
                    status["csrf_token"] = session["csrf_token"]
                self._json(200, status)
            elif path == "/api/audits":
                self._list_audits(parsed.query)
            elif match := re.fullmatch(r"/api/audits/([0-9a-fA-F-]{36})/(pdf|excel)", path):
                self._download(match[1], match[2])
            elif path == "/api/users":
                session = self._require_session()
                if session["user"]["role"] != "admin":
                    raise APIError(403, "Solo un administrador puede administrar usuarios.")
                with self.app.connect() as connection:
                    rows = connection.execute("SELECT * FROM users ORDER BY display_name, id").fetchall()
                self._json(200, {"users": [user_dict(row) | {"active": bool(row["active"])} for row in rows]})
            elif path in STATIC_PATHS:
                file_path = self.app.static_dir / STATIC_PATHS[path]
                # The allowlist does not grant access to a symlink pointing elsewhere.
                if not file_path.is_file() or not file_path.resolve().is_relative_to(self.app.static_dir):
                    raise APIError(404, "Archivo no encontrado.")
                mime_type = mimetypes.guess_type(file_path)[0] or "application/octet-stream"
                if mime_type in ("text/html", "text/css", "text/javascript", "application/javascript"):
                    mime_type += "; charset=utf-8"
                content = file_path.read_bytes()
                if path in ("/", "/index.html", "/audit.html"):
                    content = content.replace(b'<html lang="es">', b'<html lang="es" data-audit-required="true">', 1)
                self._send(200, content, mime_type)
            else:
                raise APIError(404, "Archivo o ruta no encontrados.")
            return
        if self.command == "POST" and path == "/api/login":
            data = self._body()
            user, token, csrf_token = self.app.login(data.get("username"), data.get("password"), self.client_address[0])
            self._json(200, {"user": user, "csrf_token": csrf_token}, Set_Cookie=self._cookie(token))
            return
        if not path.startswith("/api/"):
            raise APIError(405, "Método no permitido.")
        session = self._require_session()
        self._csrf(session)
        if self.command == "POST" and path == "/api/logout":
            with self.app.connect() as connection:
                connection.execute("DELETE FROM sessions WHERE token_hash = ?", (session["token_hash"],))
            self.close_connection = True
            self._json(200, {"ok": True}, Set_Cookie=self._cookie("", logout=True))
        elif self.command == "POST" and path == "/api/audits":
            self._store_audit(session)
        elif self.command == "POST" and path == "/api/users":
            if session["user"]["role"] != "admin":
                raise APIError(403, "Solo un administrador puede administrar usuarios.")
            data = self._body()
            user = self.app.create_user(data.get("username"), data.get("display_name"), data.get("password"), data.get("role", "user"))
            self._json(201, {"user": user})
        elif self.command == "PATCH" and (match := re.fullmatch(r"/api/users/([0-9]{1,12})", path)):
            if session["user"]["role"] != "admin":
                raise APIError(403, "Solo un administrador puede administrar usuarios.")
            data = self._body()
            if not isinstance(data.get("active"), bool):
                raise APIError(400, "Indica active como verdadero o falso.")
            self._json(200, {"user": self.app.set_user_active(int(match[1]), data["active"])})
        else:
            raise APIError(404, "Ruta no encontrada.")

    def _handle(self) -> None:
        try:
            self._dispatch()
        except APIError as error:
            # An unread POST body must not be interpreted as a second request.
            if self.command not in ("GET", "HEAD"):
                self.close_connection = True
            headers = {"Retry_After": str(error.extra["retry_after"])} if "retry_after" in error.extra else {}
            self._json(error.status, {"error": error.message, **error.extra}, **headers)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            self.close_connection = True
        except (OSError, sqlite3.Error, ValueError, OverflowError):
            self.close_connection = True
            self._json(500, {"error": "No se pudo completar la operación. Revisa el espacio y el acceso a la carpeta de auditoría."})

    do_GET = _handle
    do_HEAD = _handle
    do_POST = _handle
    do_PATCH = _handle
    do_PUT = _handle
    do_DELETE = _handle


class AuditHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False
    request_queue_size = 32


def make_server(app: AuditApplication, host: str = "127.0.0.1", port: int = 0, tls_cert: str | None = None, tls_key: str | None = None) -> AuditHTTPServer:
    if bool(tls_cert) != bool(tls_key):
        raise ValueError("Indica tanto el certificado como la clave TLS.")
    server_type = AuditHTTPServer
    if ":" in host:
        class IPv6AuditHTTPServer(AuditHTTPServer):
            address_family = socket.AF_INET6
        server_type = IPv6AuditHTTPServer
    server = server_type((host, port), AuditRequestHandler)
    server.app = app
    server.is_tls = bool(tls_cert)
    if tls_cert:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(tls_cert, tls_key)
        server.socket = context.wrap_socket(server.socket, server_side=True)
    return server


def _initial_admin(app: AuditApplication) -> None:
    if not sys.stdin.isatty():
        raise RuntimeError("En la primera ejecución abre una terminal para crear el administrador.")
    print("Primera ejecución: crea el administrador de la auditoría.")
    while True:
        display_name = input("Nombre del administrador: ").strip()
        username = input("Usuario [admin]: ").strip() or "admin"
        password = getpass.getpass("Contraseña (al menos 10 caracteres): ")
        confirmation = getpass.getpass("Repite la contraseña: ")
        if password != confirmation:
            print("Las contraseñas no coinciden. Intenta de nuevo.")
            continue
        try:
            app.create_user(username, display_name, password, "admin")
            break
        except APIError as error:
            print(error.message)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Conversor PDF a Excel con auditoría compartida en la red interna.")
    parser.add_argument("--host", default="127.0.0.1", help="127.0.0.1 para este equipo; 0.0.0.0 para la red interna.")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--data-dir", default=str(Path.home() / ".megaregalonexcel-auditoria"), help="Carpeta privada donde guardar la base de datos.")
    parser.add_argument("--tls-cert", help="Certificado HTTPS para la dirección interna del equipo.")
    parser.add_argument("--tls-key", help="Clave privada del certificado HTTPS.")
    parser.add_argument("--backup", metavar="ARCHIVO", help="Crea un respaldo SQLite completo y termina, sin iniciar el servidor.")
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("El puerto debe estar entre 1 y 65535.")
    if bool(args.tls_cert) != bool(args.tls_key):
        parser.error("Debes indicar --tls-cert y --tls-key juntos.")
    try:
        data_dir = Path(args.data_dir).expanduser()
        if args.backup and not (data_dir / "auditoria.sqlite3").is_file():
            raise RuntimeError("No existe una base de datos de auditoría para respaldar en esa carpeta.")
        app = create_app(data_dir)
        if args.backup:
            destination = app.backup(args.backup)
            print(f"Respaldo completo guardado en: {destination}")
            return 0
        if not app.has_users():
            _initial_admin(app)
        server = make_server(app, args.host, args.port, args.tls_cert, args.tls_key)
        scheme = "https" if server.is_tls else "http"
        local_host = "127.0.0.1" if args.host == "0.0.0.0" else args.host
        url_host = f"[{local_host}]" if ":" in local_host else local_host
        print(f"Aplicación y auditoría: {scheme}://{url_host}:{server.server_port}/")
        print(f"Datos guardados únicamente en: {app.database_path}")
        if args.host == "0.0.0.0":
            print(f"Compañeros: abran {scheme}://IP-INTERNA-DE-ESTE-EQUIPO:{server.server_port}/")
            print("Comparte la IPv4 de este equipo; no la dirección de otro servidor de la empresa.")
        if not server.is_tls:
            print("Conexión HTTP. Para cifrar las conexiones usa --tls-cert y --tls-key.")
        print("Mantén este equipo encendido y esta ventana abierta. Ctrl+C para detener.")
        try:
            server.serve_forever()
        finally:
            server.server_close()
        return 0
    except KeyboardInterrupt:
        print("\nServidor detenido.")
        return 0
    except (OSError, RuntimeError, ValueError, sqlite3.Error) as error:
        print(f"No se pudo iniciar la auditoría: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
