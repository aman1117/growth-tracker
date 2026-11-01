"""Shared infrastructure: Postgres admin, Redis flush, SMTP sink, Azurite, free ports."""

from __future__ import annotations

import base64
import datetime as dt
import email
import email.policy
import hashlib
import hmac
import http.client
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import psycopg
from psycopg import sql as pgsql

# Tables, indexes and the extension production created with standalone scripts in
# backend/migrations/*.go. Idempotent, applied after the server under test migrated the schema.
EXTRA_SCHEMA_SQL = """
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE IF NOT EXISTS story_likes (id SERIAL PRIMARY KEY, liker_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE, photo_id INTEGER NOT NULL REFERENCES activity_photos(id) ON UPDATE CASCADE ON DELETE CASCADE, liked_at TIMESTAMP NOT NULL DEFAULT NOW());
CREATE UNIQUE INDEX IF NOT EXISTS idx_story_like_unique ON story_likes (liker_id, photo_id);
CREATE INDEX IF NOT EXISTS idx_story_like_liker ON story_likes (liker_id);
CREATE INDEX IF NOT EXISTS idx_story_like_photo ON story_likes (photo_id);
CREATE TABLE IF NOT EXISTS recent_searches (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE, searched_user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE, searched_at TIMESTAMP NOT NULL DEFAULT NOW(), CONSTRAINT uq_recent_search_user_searched UNIQUE (user_id, searched_user_id));
CREATE INDEX IF NOT EXISTS idx_recent_search_user_time ON recent_searches (user_id, searched_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_username_trgm ON users USING gin (username gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_users_username_lower_pattern ON users (lower(username) text_pattern_ops);
"""


def free_port(host: str = "127.0.0.1") -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind((host, 0))
        return s.getsockname()[1]


def wait_tcp(host: str, port: int, timeout: float) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.1)
    return False


# ------------------------------------------------------------------------------ Postgres

@dataclass
class PgConfig:
    host: str = "127.0.0.1"
    port: int = 55432
    user: str = "postgres"
    password: str = "postgres"

    def url(self, dbname: str) -> str:
        return f"postgres://{self.user}:{self.password}@{self.host}:{self.port}/{dbname}?sslmode=disable"


class PgAdmin:
    def __init__(self, cfg: PgConfig):
        self.cfg = cfg

    def connect(self, dbname: str = "postgres") -> psycopg.Connection:
        return psycopg.connect(
            host=self.cfg.host,
            port=self.cfg.port,
            user=self.cfg.user,
            password=self.cfg.password,
            dbname=dbname,
            autocommit=True,
            connect_timeout=10,
        )

    def terminate(self, dbname: str) -> None:
        with self.connect() as conn:
            conn.execute(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = %s AND pid <> pg_backend_pid()",
                (dbname,),
            )

    def create_db(self, name: str, template: str | None = None) -> None:
        stmt = pgsql.SQL("CREATE DATABASE {}").format(pgsql.Identifier(name))
        if template:
            stmt = pgsql.SQL("CREATE DATABASE {} TEMPLATE {}").format(pgsql.Identifier(name), pgsql.Identifier(template))
        last: Exception | None = None
        for _ in range(50):
            if template:
                self.terminate(template)
            try:
                with self.connect() as conn:
                    conn.execute(stmt)
                return
            except psycopg.errors.ObjectInUse as exc:  # template still has sessions
                last = exc
                time.sleep(0.2)
        raise RuntimeError(f"could not create database {name}: {last}")

    def drop_db(self, name: str) -> None:
        with self.connect() as conn:
            conn.execute(pgsql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(pgsql.Identifier(name)))

    def list_dbs(self, prefix: str) -> list[str]:
        with self.connect() as conn:
            rows = conn.execute("SELECT datname FROM pg_database WHERE datname LIKE %s", (prefix + "%",)).fetchall()
        return [r[0] for r in rows]

    def execute_script(self, dbname: str, script: str) -> None:
        with self.connect(dbname) as conn:
            conn.execute(script)

    @staticmethod
    def truncate_conn(conn: psycopg.Connection) -> None:
        """Empty every table and restart sequences (used to reset an externally managed server's DB)."""
        tables = [r[0] for r in conn.execute(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
        ).fetchall()]
        if tables:
            conn.execute(pgsql.SQL("TRUNCATE {} RESTART IDENTITY CASCADE").format(
                pgsql.SQL(", ").join(pgsql.Identifier(t) for t in tables)))


# ------------------------------------------------------------------------------ Redis

def parse_redis_url(url: str) -> tuple[str, int]:
    m = re.match(r"redis://(?:[^@]*@)?([^:/]+)(?::(\d+))?", url)
    if not m:
        raise ValueError(f"unsupported REDIS_URL {url!r}")
    return m.group(1), int(m.group(2) or 6379)


def redis_command(host: str, port: int, *args: str) -> bytes:
    payload = f"*{len(args)}\r\n".encode() + b"".join(
        f"${len(a.encode())}\r\n".encode() + a.encode() + b"\r\n" for a in args
    )
    with socket.create_connection((host, port), timeout=5) as s:
        s.sendall(payload)
        data = b""
        while not data.endswith(b"\r\n"):
            chunk = s.recv(4096)
            if not chunk:
                break
            data += chunk
    return data


def redis_flushall(url: str) -> None:
    host, port = parse_redis_url(url)
    reply = redis_command(host, port, "FLUSHALL")
    if not reply.startswith(b"+OK"):
        raise RuntimeError(f"FLUSHALL failed: {reply!r}")


# ------------------------------------------------------------------------------ SMTP sink

@dataclass
class Mail:
    to: list[str]
    subject: str
    body: str
    received_at: float


class SmtpSink:
    """Local SMTP server capturing the emails the server sends (password reset, verification)."""

    def __init__(self, host: str = "127.0.0.1", port: int | None = None):
        self.host = host
        self.port = port or free_port(host)
        self.messages: list[Mail] = []
        self._lock = threading.Lock()
        self._controller = None

    def start(self) -> None:
        from aiosmtpd.controller import Controller

        sink = self

        class Handler:
            async def handle_DATA(self, server, session, envelope):  # noqa: N802 - aiosmtpd hook name
                msg = email.message_from_bytes(envelope.original_content or envelope.content, policy=email.policy.default)
                if msg.is_multipart():
                    parts = [p.get_content() for p in msg.walk() if p.get_content_maintype() == "text"]
                    body = "\n".join(parts)
                else:
                    body = msg.get_content()
                with sink._lock:
                    sink.messages.append(Mail([r.lower() for r in envelope.rcpt_tos], str(msg.get("Subject", "")), body, time.time()))
                return "250 Message accepted for delivery"

        self._controller = Controller(Handler(), hostname=self.host, port=self.port)
        self._controller.start()

    def stop(self) -> None:
        if self._controller:
            self._controller.stop()
            self._controller = None

    def clear(self) -> None:
        with self._lock:
            self.messages.clear()

    def wait_for(self, to: str, count: int = 1, timeout: float = 10.0, subject_contains: str | None = None) -> list[Mail]:
        """Wait until at least `count` matching messages arrived; returns them (oldest first)."""
        deadline = time.time() + timeout
        while True:
            with self._lock:
                found = [
                    m for m in self.messages
                    if to.lower() in m.to and (subject_contains is None or subject_contains.lower() in m.subject.lower())
                ]
            if len(found) >= count or time.time() >= deadline:
                return found
            time.sleep(0.05)


# ------------------------------------------------------------------------------ Azurite

AZURITE_ACCOUNT = "devstoreaccount1"
AZURITE_KEY = "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw=="


class Azurite:
    """Azure Blob emulator (npm package `azurite`), installed on demand into the work directory."""

    def __init__(self, work_dir: Path, container: str = "profile-pictures", log=print):
        self.work_dir = work_dir
        self.container = container
        self.log = log
        self.port = free_port()
        self.proc: subprocess.Popen | None = None
        self.node_prefix = work_dir.parent / "node"  # shared across runs
        self.data_dir = work_dir / "azurite-data"
        self.log_path = work_dir / "logs" / "azurite.log"
        self._log_file: Any = None

    @property
    def entry(self) -> Path:
        return self.node_prefix / "node_modules" / "azurite" / "dist" / "src" / "blob" / "main.js"

    def ensure_installed(self) -> None:
        if self.entry.exists():
            return
        npm = shutil.which("npm") or shutil.which("npm.cmd")
        if not npm:
            raise RuntimeError("npm not found (needed to install azurite)")
        self.node_prefix.mkdir(parents=True, exist_ok=True)
        self.log("  [azurite] installing azurite into " + str(self.node_prefix) + " (one-time)")
        subprocess.run(
            [npm, "install", "--prefix", str(self.node_prefix), "azurite@3", "--no-audit", "--no-fund", "--silent"],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            shell=sys.platform == "win32",
        )
        if not self.entry.exists():
            raise RuntimeError(f"azurite entry point not found at {self.entry}")

    def start(self) -> None:
        self.ensure_installed()
        node = shutil.which("node")
        if not node:
            raise RuntimeError("node not found")
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        self._log_file = open(self.log_path, "wb")
        self.proc = subprocess.Popen(
            [node, str(self.entry), "--blobHost", "127.0.0.1", "--blobPort", str(self.port),
             "--location", str(self.data_dir), "--skipApiVersionCheck", "--loose"],
            stdout=self._log_file,
            stderr=subprocess.STDOUT,
            cwd=str(self.work_dir),
        )
        if not wait_tcp("127.0.0.1", self.port, 60):
            self.stop()
            raise RuntimeError(f"azurite did not start (log: {self.log_path})")
        self.create_public_container(self.container)

    def stop(self) -> None:
        if self.proc:
            self.proc.kill()
            try:
                self.proc.wait(10)
            except subprocess.TimeoutExpired:
                pass
            self.proc = None
        if self._log_file:
            self._log_file.close()
            self._log_file = None
        shutil.rmtree(self.data_dir, ignore_errors=True)

    @property
    def connection_string(self) -> str:
        return (
            f"DefaultEndpointsProtocol=http;AccountName={AZURITE_ACCOUNT};AccountKey={AZURITE_KEY};"
            f"BlobEndpoint=http://127.0.0.1:{self.port}/{AZURITE_ACCOUNT};"
        )

    def create_public_container(self, name: str) -> None:
        """PUT ?restype=container with blob-level public read access (Shared Key auth)."""
        date = dt.datetime.now(dt.timezone.utc).strftime("%a, %d %b %Y %H:%M:%S GMT")
        version = "2021-08-06"
        headers = {"x-ms-blob-public-access": "blob", "x-ms-date": date, "x-ms-version": version}
        canon_headers = "".join(f"{k}:{headers[k]}\n" for k in sorted(headers))
        canon_resource = f"/{AZURITE_ACCOUNT}/{AZURITE_ACCOUNT}/{name}\nrestype:container"
        string_to_sign = "PUT\n\n\n\n\n\n\n\n\n\n\n\n" + canon_headers + canon_resource
        sig = base64.b64encode(
            hmac.new(base64.b64decode(AZURITE_KEY), string_to_sign.encode(), hashlib.sha256).digest()
        ).decode()
        headers["Authorization"] = f"SharedKey {AZURITE_ACCOUNT}:{sig}"
        headers["Content-Length"] = "0"
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.request("PUT", f"/{AZURITE_ACCOUNT}/{name}?restype=container", headers=headers)
            resp = conn.getresponse()
            body = resp.read()
            if resp.status not in (201, 409):
                raise RuntimeError(f"container creation failed: {resp.status} {body[:300]!r}")
        finally:
            conn.close()


def clean_old_runs(base: Path, keep: int = 5) -> None:
    runs = sorted((p for p in base.glob("run-*") if p.is_dir()), key=lambda p: p.name)
    for old in runs[:-keep] if keep else runs:
        shutil.rmtree(old, ignore_errors=True)


def env_without_app_config(extra_drop: tuple[str, ...] = ()) -> dict[str, str]:
    """A copy of os.environ minus any Growth Tracker configuration that could leak into the server."""
    app_vars = {
        "DATABASE_URL", "DB_HOST", "DB_PORT", "DB_NAME", "DB_USERNAME", "DB_PASSWORD", "DB_SSLMODE",
        "REDIS_URL", "JWT_SECRET_KEY", "TTL_ACCESS_TOKEN", "TTL_REFRESH_TOKEN", "PORT", "ENV",
        "FRONTEND_BASE_URL", "AZURE_STORAGE_CONNECTION_STRING", "AZURE_STORAGE_ACCOUNT_NAME",
        "AZURE_STORAGE_CONTAINER", "AZURE_SERVICEBUS_CONNECTION_STRING", "AZURE_SERVICEBUS_QUEUE_NAME",
        "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT", "VAPID_KEY_ID", "RESEND_API_KEY",
        "EMAIL_FROM_ADDRESS", "EMAIL_FROM_NAME", "SMTP_HOST", "SMTP_PORT", "AXIOM_DATASET", "AXIOM_API_TOKEN",
        "PPROF_ENABLED", "PPROF_PREFIX", "PPROF_TOKEN", "MAINTENANCE_API_KEY", "HOSTNAME",
        "FOLLOW_MAX_PER_MINUTE", "FOLLOW_MAX_PER_DAY", "FOLLOW_MAX_TOTAL", "FOLLOW_TOMBSTONE_RETENTION_DAYS",
        "SERVER_READ_TIMEOUT", "SERVER_WRITE_TIMEOUT",
    }
    drop = app_vars | set(extra_drop)
    return {k: v for k, v in os.environ.items() if k.upper() not in drop}
