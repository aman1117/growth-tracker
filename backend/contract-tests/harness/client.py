"""Minimal HTTP + WebSocket client that can bind each simulated user to its own loopback IP.

Fiber's rate limiters key on `c.IP()` (the TCP peer address), so every actor gets a distinct
source address in 127.0.0.0/8 (all of it is loopback on Windows and Linux).
"""

from __future__ import annotations

import base64
import hashlib
import http.client
import os
import socket
import struct
import time
from dataclasses import dataclass, field
from typing import Any

from . import jsonx

DEFAULT_TIMEOUT = 30.0


@dataclass
class HttpResult:
    status: int
    reason: str
    headers: dict[str, str]  # lower-cased names; repeated headers joined with ", "
    body: bytes
    received_at: float = field(default_factory=time.time)

    @property
    def content_type(self) -> str:
        return self.headers.get("content-type", "")

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")

    def parsed_json(self) -> Any:
        """The body as a JNum tree, or None when it is not JSON."""
        if not self.body:
            return None
        if "json" not in self.content_type.lower():
            return None
        try:
            return jsonx.loads(self.body)
        except ValueError:
            return None


def http_request(
    host: str,
    port: int,
    method: str,
    path: str,
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
    source_ip: str | None = None,
    timeout: float = DEFAULT_TIMEOUT,
) -> HttpResult:
    """One request on a fresh connection (used for readiness probes)."""
    source = (source_ip, 0) if source_ip else None
    conn = http.client.HTTPConnection(host, port, timeout=timeout, source_address=source)
    try:
        return _send(conn, method, path, {"Connection": "close", **(headers or {})}, body)
    finally:
        conn.close()


def _send(conn: http.client.HTTPConnection, method: str, path: str, headers: dict[str, str],
          body: bytes | None) -> HttpResult:
    conn.putrequest(method, path, skip_accept_encoding=True)
    hdrs = {"User-Agent": "gt-parity/1.0"}
    hdrs.update(headers)
    if body is not None:
        hdrs["Content-Length"] = str(len(body))
    for k, v in hdrs.items():
        conn.putheader(k, v)
    conn.endheaders(body)
    resp = conn.getresponse()
    data = resp.read()
    merged: dict[str, str] = {}
    for k, v in resp.getheaders():
        lk = k.lower()
        merged[lk] = f"{merged[lk]}, {v}" if lk in merged else v
    return HttpResult(resp.status, resp.reason, merged, data)


_RETRYABLE = (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, http.client.RemoteDisconnected,
              http.client.CannotSendRequest, http.client.ResponseNotReady)


class HttpPool:
    """Keep-alive connections, one per source IP.

    Windows picks the ephemeral port at bind() time when a source address is given, without
    looking at the destination; with one connection per request it regularly reuses a 4-tuple
    the server still holds in TIME_WAIT and the SYN is retried after ~1s. Reusing a connection
    per simulated client (as a browser would) avoids that.
    """

    def __init__(self, host: str, port: int, timeout: float = DEFAULT_TIMEOUT):
        self.host = host
        self.port = port
        self.timeout = timeout
        self._conns: dict[str | None, http.client.HTTPConnection] = {}

    def _conn(self, source_ip: str | None) -> http.client.HTTPConnection:
        conn = self._conns.get(source_ip)
        if conn is None:
            source = (source_ip, 0) if source_ip else None
            conn = http.client.HTTPConnection(self.host, self.port, timeout=self.timeout, source_address=source)
            self._conns[source_ip] = conn
        return conn

    def _drop(self, source_ip: str | None) -> None:
        conn = self._conns.pop(source_ip, None)
        if conn is not None:
            conn.close()

    def request(self, method: str, path: str, headers: dict[str, str] | None = None, body: bytes | None = None,
                source_ip: str | None = None) -> HttpResult:
        for attempt in (1, 2):
            conn = self._conn(source_ip)
            reused = conn.sock is not None
            try:
                result = _send(conn, method, path, dict(headers or {}), body)
            except _RETRYABLE:
                self._drop(source_ip)
                if attempt == 1 and reused:  # the server closed an idle keep-alive connection: retry once
                    continue
                raise
            except Exception:
                self._drop(source_ip)
                raise
            if result.headers.get("connection", "").lower() == "close":
                self._drop(source_ip)
            return result
        raise RuntimeError("unreachable")

    def close(self) -> None:
        for ip in list(self._conns):
            self._drop(ip)


def encode_multipart(fields: dict[str, str], files: dict[str, tuple[str, bytes, str]]) -> tuple[bytes, str]:
    """Deterministic multipart/form-data encoding (fixed boundary)."""
    boundary = "----gtParityBoundary7MA4YWxkTrZu0gW"
    parts: list[bytes] = []
    for name, value in fields.items():
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
        )
    for name, (filename, content, ctype) in files.items():
        head = (
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
            f"Content-Type: {ctype}\r\n\r\n"
        ).encode()
        parts.append(head + content + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


# ------------------------------------------------------------------------------ WebSocket

class WebSocketClosed(Exception):
    pass


class WebSocketConnection:
    """RFC 6455 client side, just enough for the notifications socket (text frames, ping/pong, close)."""

    def __init__(self, sock: socket.socket, leftover: bytes):
        self.sock = sock
        self.buf = leftover
        self.closed = False

    def _read_exact(self, n: int, deadline: float) -> bytes:
        while len(self.buf) < n:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise TimeoutError("websocket receive timed out")
            self.sock.settimeout(remaining)
            try:
                chunk = self.sock.recv(65536)
            except socket.timeout as exc:
                raise TimeoutError("websocket receive timed out") from exc
            if not chunk:
                raise WebSocketClosed("connection closed by server")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        header = bytes([0x80 | opcode])
        mask = os.urandom(4)
        length = len(payload)
        if length < 126:
            header += bytes([0x80 | length])
        elif length < 65536:
            header += bytes([0x80 | 126]) + struct.pack("!H", length)
        else:
            header += bytes([0x80 | 127]) + struct.pack("!Q", length)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(header + mask + masked)

    def send_text(self, text: str) -> None:
        self._send_frame(0x1, text.encode("utf-8"))

    def recv(self, timeout: float = 5.0) -> tuple[str, bytes]:
        """Next data or close frame as (kind, payload); kind is 'text', 'binary' or 'close'."""
        deadline = time.time() + timeout
        while True:
            b1, b2 = self._read_exact(2, deadline)
            opcode = b1 & 0x0F
            length = b2 & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._read_exact(2, deadline))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._read_exact(8, deadline))[0]
            mask = self._read_exact(4, deadline) if b2 & 0x80 else None
            payload = self._read_exact(length, deadline)
            if mask:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            if opcode == 0x9:  # ping -> pong
                self._send_frame(0xA, payload)
                continue
            if opcode == 0xA:
                continue
            if opcode == 0x8:
                self.closed = True
                return "close", payload
            return ("text" if opcode == 0x1 else "binary"), payload

    def close(self) -> None:
        if not self.closed:
            try:
                self._send_frame(0x8, struct.pack("!H", 1000))
            except OSError:
                pass
            self.closed = True
        try:
            self.sock.close()
        except OSError:
            pass


@dataclass
class WebSocketHandshake:
    status: int
    headers: dict[str, str]
    body: bytes
    connection: WebSocketConnection | None


def ws_connect(
    host: str,
    port: int,
    path: str,
    source_ip: str | None = None,
    upgrade: bool = True,
    timeout: float = 10.0,
) -> WebSocketHandshake:
    """Attempt a WebSocket handshake; a rejected handshake returns its HTTP status, headers and body."""
    sock = socket.create_connection((host, port), timeout=timeout, source_address=(source_ip, 0) if source_ip else None)
    key = base64.b64encode(os.urandom(16)).decode()
    lines = [f"GET {path} HTTP/1.1", f"Host: {host}:{port}", "User-Agent: gt-parity/1.0"]
    if upgrade:
        lines += ["Upgrade: websocket", "Connection: Upgrade", f"Sec-WebSocket-Key: {key}", "Sec-WebSocket-Version: 13"]
    else:
        lines += ["Connection: close"]
    sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())

    deadline = time.time() + timeout
    buf = b""
    while b"\r\n\r\n" not in buf:
        sock.settimeout(max(deadline - time.time(), 0.01))
        chunk = sock.recv(65536)
        if not chunk:
            break
        buf += chunk
    head, _, rest = buf.partition(b"\r\n\r\n")
    status_line, *header_lines = head.decode("latin-1").split("\r\n")
    status = int(status_line.split(" ")[1])
    headers: dict[str, str] = {}
    for line in header_lines:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()

    if status == 101:
        expected = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        if headers.get("sec-websocket-accept") != expected:
            sock.close()
            raise ValueError("invalid Sec-WebSocket-Accept from server")
        return WebSocketHandshake(status, headers, b"", WebSocketConnection(sock, rest))

    body = rest
    length = int(headers.get("content-length", "-1"))
    while length >= 0 and len(body) < length and time.time() < deadline:
        sock.settimeout(max(deadline - time.time(), 0.01))
        chunk = sock.recv(65536)
        if not chunk:
            break
        body += chunk
    sock.close()
    return WebSocketHandshake(status, headers, body[: length if length >= 0 else None], None)
