"""Scenario DSL: registry, per-scenario context (`t`), actors and step recording.

A scenario is a plain Python function receiving a `Ctx`. Every HTTP/WebSocket exchange made
through the context becomes a recorded step (request + response), normalized on the fly.
Scenario code must be deterministic: values captured from responses (ids, tokens, codes) may be
reused, but control flow must not depend on volatile data.
"""

from __future__ import annotations

import base64
import datetime as dt
import hashlib
import hmac
import json
import re
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable

from . import jsonx
from .client import HttpPool, HttpResult, WebSocketConnection, encode_multipart, http_request, ws_connect
from .dates import iso, monday_of, today_ist
from .images import image_info
from .normalize import Normalizer, harness_uuid
from .ratelimit import RateLimitTracker

DEFAULT_PASSWORD = "Passw0rd123"
RECORDED_RESPONSE_HEADERS = ("content-type", "retry-after", "x-ratelimit-limit", "x-ratelimit-remaining")
RECORDED_REQUEST_HEADERS = (
    "authorization", "content-type", "x-idempotency-key", "x-maintenance-key", "origin",
    "access-control-request-method", "access-control-request-headers",
)
_MISSING = object()


class ScenarioSkip(Exception):
    pass


class ScenarioAbort(Exception):
    """A required step did not behave as the scenario needs; the rest of the scenario is meaningless."""


# ------------------------------------------------------------------------------ registry

@dataclass
class ScenarioDef:
    name: str
    domain: str
    func: Callable[["Ctx"], None]
    anchor: str = "TODAY"
    requires: tuple[str, ...] = ()  # "db" (seeding/waits), "smtp", "azurite", "managed" (harness-owned server)
    env: dict[str, str] = field(default_factory=dict)
    description: str = ""


REGISTRY: list[ScenarioDef] = []


def scenario(
    name: str,
    domain: str,
    *,
    anchor: str = "TODAY",
    requires: Iterable[str] = (),
    env: dict[str, str] | None = None,
    description: str = "",
):
    def deco(func: Callable[["Ctx"], None]) -> Callable[["Ctx"], None]:
        if any(s.name == name for s in REGISTRY):
            raise ValueError(f"duplicate scenario name {name!r}")
        doc_lines = (func.__doc__ or "").strip().splitlines()
        summary = description or (doc_lines[0].strip() if doc_lines else "")
        REGISTRY.append(ScenarioDef(name, domain, func, anchor, tuple(requires), dict(env or {}), summary))
        return func

    return deco


# ------------------------------------------------------------------------------ runtime objects

@dataclass
class Actor:
    name: str
    ip: str
    username: str | None = None
    email: str | None = None
    password: str = DEFAULT_PASSWORD
    token: str | None = None
    id: int | None = None

    def bearer(self) -> str:
        if not self.token:
            raise ScenarioAbort(f"actor {self.name} has no token (signup/login failed?)")
        return f"Bearer {self.token}"


class Response:
    def __init__(self, result: HttpResult):
        self.result = result
        self.status = result.status
        self.headers = result.headers
        self.text = result.text
        self.json = result.parsed_json()
        self.data = jsonx.to_plain(self.json) if self.json is not None else None

    def get(self, path: str, default: Any = None) -> Any:
        cur = self.data
        for part in path.split("."):
            if isinstance(cur, dict) and part in cur:
                cur = cur[part]
            elif isinstance(cur, list) and re.fullmatch(r"-?\d+", part) and -len(cur) <= int(part) < len(cur):
                cur = cur[int(part)]
            else:
                return default
        return cur

    def need(self, path: str) -> Any:
        """Like get() but aborts the scenario when the value is missing (setup steps)."""
        value = self.get(path, _MISSING)
        if value is _MISSING or value is None:
            raise ScenarioAbort(f"response has no {path!r}: status {self.status}, body {self.text[:300]!r}")
        return value


@dataclass
class Services:
    host: str
    port: int
    db: Any = None  # psycopg connection to the scenario database (or None)
    smtp: Any = None  # SmtpSink (or None)
    ip_base: tuple[int, int] = (0, 1)
    redis_url: str | None = None
    blob_endpoint: str | None = None  # e.g. http://127.0.0.1:<port>/devstoreaccount1 (Azurite)


def make_jwt(secret: str, claims: dict[str, Any], header: dict[str, Any] | None = None) -> str:
    def b64(data: bytes) -> str:
        return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

    header = header or {"alg": "HS256", "typ": "JWT"}
    signing_input = b64(json.dumps(header, separators=(",", ":")).encode()) + "." + b64(
        json.dumps(claims, separators=(",", ":")).encode()
    )
    if header.get("alg") == "none":
        return signing_input + "."
    sig = hmac.new(secret.encode(), signing_input.encode(), hashlib.sha256).digest()
    return signing_input + "." + b64(sig)


def jwt_claims(token: str) -> dict[str, Any]:
    payload = token.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    return json.loads(base64.urlsafe_b64decode(payload))


# ------------------------------------------------------------------------------ context

class Ctx:
    """Everything a scenario needs: actors, requests, waits, seeding, dates."""

    def __init__(self, sdef: ScenarioDef, services: Services, jwt_secret: str, log: Callable[[str], None]):
        self.sdef = sdef
        self.svc = services
        self.jwt_secret = jwt_secret
        self.log = log
        self.today = today_ist()
        self.week = monday_of(self.today)
        self.norm = Normalizer({"TODAY": self.today, "WEEK": self.week}, sdef.anchor)
        self.steps: list[dict[str, Any]] = []
        self.warnings: list[str] = []
        self._ip_next = 0
        self._actors: dict[str, Actor] = {}
        self.http = HttpPool(services.host, services.port)
        self.rate_limits = RateLimitTracker()

    # ---------------------------------------------------------------- dates
    def day(self, offset: int = 0) -> str:
        """ISO date `offset` days from today (IST)."""
        return iso(self.today + dt.timedelta(days=offset))

    def wday(self, offset: int = 0) -> str:
        """ISO date `offset` days from Monday of the current IST week."""
        return iso(self.week + dt.timedelta(days=offset))

    @staticmethod
    def uuid(n: int) -> str:
        return harness_uuid(n)

    # ---------------------------------------------------------------- actors
    def _next_ip(self) -> str:
        self._ip_next += 1
        b2, b3 = self.svc.ip_base
        n = self._ip_next + 9
        return f"127.{b2}.{b3 + n // 250}.{n % 250 + 2}"

    def user(self, name: str, username: str | None = None, email: str | None = None,
             password: str = DEFAULT_PASSWORD) -> Actor:
        if name in self._actors:
            raise ValueError(f"actor {name} already exists")
        uname = username or name
        actor = Actor(name, self._next_ip(), uname, email or f"{uname}@parity.test", password)
        self._actors[name] = actor
        return actor

    def anon(self, name: str = "anon") -> Actor:
        """An unauthenticated client with its own source IP."""
        if name in self._actors:
            return self._actors[name]
        actor = Actor(name, self._next_ip())
        self._actors[name] = actor
        return actor

    def new_ip(self, actor: Actor) -> Actor:
        """Move an actor to a fresh source IP (another device): IP-keyed limiters start over."""
        actor.ip = self._next_ip()
        return actor

    def observe(self, name: str, value: Any) -> None:
        """Record a server side effect that is not an HTTP response (e.g. emails sent) as a step."""
        now = self._now(time.time())
        self._append(name, None, {"method": "OBSERVE", "path": name},
                     {"status": 0, "headers": {}, "body_type": "json", "body": self.norm.value(value, now)},
                     self.norm.take_issues())

    def forge_token(self, user_id: int, username: str, ttl: int = 3600, secret: str | None = None,
                    alg: str = "HS256") -> str:
        now = int(time.time())
        return make_jwt(secret if secret is not None else self.jwt_secret,
                        {"user_id": user_id, "username": username, "exp": now + ttl, "iat": now},
                        {"alg": alg, "typ": "JWT"})

    # ---------------------------------------------------------------- HTTP
    def call(
        self,
        actor: Actor,
        method: str,
        path: str,
        name: str,
        *,
        json: Any = _MISSING,
        raw: str | bytes | None = None,
        content_type: str | None = None,
        auth: Any = True,
        headers: dict[str, str] | None = None,
        form: dict[str, str] | None = None,
        files: dict[str, tuple[str, bytes, str]] | None = None,
        extra_response_headers: Iterable[str] = (),
        body_mode: str = "record",
        expect: int | None = None,
        record: bool = True,
    ) -> Response:
        req_headers: dict[str, str] = {}
        if auth is True:
            req_headers["Authorization"] = actor.bearer()
        elif isinstance(auth, str):
            req_headers["Authorization"] = auth
        body: bytes | None = None
        recorded_body: Any = None
        if json is not _MISSING:
            body = jsonx.request_body_bytes(json)
            req_headers["Content-Type"] = content_type or "application/json"
            recorded_body = json
        elif raw is not None:
            body = raw.encode() if isinstance(raw, str) else raw
            if content_type:
                req_headers["Content-Type"] = content_type
            recorded_body = {"raw": raw if isinstance(raw, str) else raw.decode("latin-1")}
        elif form is not None or files is not None:
            body, ctype = encode_multipart(form or {}, files or {})
            req_headers["Content-Type"] = ctype
            recorded_body = {
                "multipart_fields": dict(form or {}),
                "multipart_files": {
                    k: {"filename": f[0], "content_type": f[2], "bytes": len(f[1]),
                        "sha256": hashlib.sha256(f[1]).hexdigest()[:16]}
                    for k, f in (files or {}).items()
                },
            }
        elif content_type:
            req_headers["Content-Type"] = content_type
        req_headers.update(headers or {})

        result = self.http.request(method, path, req_headers, body, source_ip=actor.ip)
        resp = Response(result)
        rl = self._account_rate_limit(method, path, req_headers.get("Authorization"), actor.ip, result)
        if record:
            self._record_http(actor, method, path, name, req_headers, recorded_body, result,
                              tuple(extra_response_headers), body_mode)
            if rl:
                self.steps[-1]["ratelimit"] = rl
        if expect is not None and resp.status != expect:
            self.warnings.append(f"step {len(self.steps)} {name!r}: expected status {expect}, got {resp.status}")
        return resp

    def _account_rate_limit(self, method: str, path: str, authorization: str | None, ip: str,
                            result: HttpResult) -> dict[str, Any] | None:
        user = None
        if authorization and authorization.startswith("Bearer "):
            try:
                uid = int(jwt_claims(authorization[7:].strip()).get("user_id") or 0)
            except Exception:
                uid = 0
            if uid:
                user = next((a.name for a in self._actors.values() if a.id == uid), f"user{uid}")
        return self.rate_limits.observe(method, path, result.status, result.headers, user, ip, result.received_at)

    def get(self, actor: Actor, path: str, name: str, **kw: Any) -> Response:
        return self.call(actor, "GET", path, name, **kw)

    def post(self, actor: Actor, path: str, name: str, **kw: Any) -> Response:
        return self.call(actor, "POST", path, name, **kw)

    def put(self, actor: Actor, path: str, name: str, **kw: Any) -> Response:
        return self.call(actor, "PUT", path, name, **kw)

    def patch(self, actor: Actor, path: str, name: str, **kw: Any) -> Response:
        return self.call(actor, "PATCH", path, name, **kw)

    def delete(self, actor: Actor, path: str, name: str, **kw: Any) -> Response:
        return self.call(actor, "DELETE", path, name, **kw)

    def burst(self, actor: Actor, method: str, paths: list[str], workers: int = 8) -> list[int]:
        """Send unrecorded authenticated requests concurrently (to exhaust a per-user rate limit quickly,
        so the Retry-After of the following recorded 429 stays close to the window length).
        Each worker uses its own source IP: only use this for limiters keyed by user ID."""
        from concurrent.futures import ThreadPoolExecutor

        headers = {"Authorization": actor.bearer()}
        chunks = [paths[i::workers] for i in range(workers)]
        ips = [self._next_ip() for _ in range(workers)]

        def run(idx: int) -> list[tuple[str, HttpResult]]:
            pool = HttpPool(self.svc.host, self.svc.port)
            try:
                return [(p, pool.request(method, p, headers, None, source_ip=ips[idx])) for p in chunks[idx]]
            finally:
                pool.close()

        with ThreadPoolExecutor(workers) as ex:
            results = [(ips[i], p, r) for i, rs in enumerate(ex.map(run, range(workers))) for p, r in rs]
        for ip, p, r in sorted(results, key=lambda x: x[2].received_at):
            self._account_rate_limit(method, p, headers["Authorization"], ip, r)
        return [r.status for _, _, r in results]

    def _now(self, ts: float) -> dt.datetime:
        return dt.datetime.fromtimestamp(ts, dt.timezone.utc)

    def _record_http(self, actor: Actor, method: str, path: str, name: str, req_headers: dict[str, str],
                     recorded_body: Any, result: HttpResult, extra_headers: tuple[str, ...], body_mode: str) -> None:
        now = self._now(result.received_at)
        n = self.norm
        request: dict[str, Any] = {"method": method, "path": n.string(path, now, path="request.path")}
        rh = {k: n.string(v, now, path=f"request.headers.{k}") for k, v in req_headers.items()
              if k.lower() in RECORDED_REQUEST_HEADERS}
        if rh:
            request["headers"] = rh
        if recorded_body is not None:
            request["body"] = n.value(recorded_body, now, path="request.body")
        n.take_issues()  # shape checks apply to responses only

        wanted = set(RECORDED_RESPONSE_HEADERS) | {h.lower() for h in extra_headers}
        response: dict[str, Any] = {
            "status": result.status,
            "headers": {k: v for k, v in sorted(result.headers.items()) if k in wanted},
        }
        parsed = result.parsed_json()
        if body_mode == "ignore":
            response["body_type"], response["body"] = "ignored", None
        elif not result.body:
            response["body_type"], response["body"] = "empty", ""
        elif parsed is not None:
            response["body_type"], response["body"] = "json", n.value(parsed, now, path="$")
        else:
            response["body_type"], response["body"] = "text", n.string(result.text, now, path="$")
        self._append(name, actor, request, response, n.take_issues())

    def _append(self, name: str, actor: Actor | None, request: dict[str, Any], response: dict[str, Any],
                issues: list[str]) -> None:
        step: dict[str, Any] = {
            "index": len(self.steps) + 1,
            "name": name,
            "actor": actor.name if actor else None,
            "request": request,
            "response": response,
        }
        if issues:
            step["issues"] = issues
        self.steps.append(step)

    # ---------------------------------------------------------------- common flows
    def register(self, actor: Actor, name: str | None = None, expect: int | None = 201) -> Response:
        return self.post(actor, "/api/register", name or f"register {actor.name}",
                         json={"email": actor.email, "username": actor.username, "password": actor.password},
                         auth=False, expect=expect)

    def login(self, actor: Actor, name: str | None = None, identifier: str | None = None,
              password: str | None = None, require: bool = True) -> Response:
        r = self.post(actor, "/api/login", name or f"login {actor.name}",
                      json={"identifier": identifier or actor.username, "password": password or actor.password},
                      auth=False)
        if r.status == 200 and r.get("access_token"):
            actor.token = r.get("access_token")
            actor.id = int(jwt_claims(actor.token)["user_id"])
        elif require:
            raise ScenarioAbort(f"login of {actor.name} failed: {r.status} {r.text[:200]}")
        return r

    def signup(self, *actors: Actor) -> None:
        """Register and log in each actor (two recorded steps per actor)."""
        for actor in actors:
            r = self.register(actor)
            if r.status != 201:
                raise ScenarioAbort(f"registration of {actor.name} failed: {r.status} {r.text[:200]}")
            self.login(actor)

    def users(self, *names: str) -> list[Actor]:
        """Create and sign up several actors."""
        actors = [self.user(n) for n in names]
        self.signup(*actors)
        return actors

    def follow(self, follower: Actor, target: Actor, name: str | None = None, expect: int | None = 200) -> Response:
        r = self.post(follower, f"/api/users/{target.id}/follow", name or f"{follower.name} follows {target.name}",
                      expect=expect)
        self.quiesce()  # follow / follow-request notifications are created in goroutines
        return r

    def accept(self, owner: Actor, requester: Actor, name: str | None = None) -> Response:
        r = self.post(owner, f"/api/me/follow-requests/{requester.id}/accept",
                      name or f"{owner.name} accepts {requester.name}", expect=200)
        self.quiesce()
        return r

    def set_private(self, actor: Actor, private: bool = True) -> Response:
        return self.post(actor, "/api/update-privacy", f"{actor.name} sets is_private={private}",
                         json={"is_private": private}, expect=200)

    def activity(self, actor: Actor, activity: str, hours: float, date: str, note: str | None = None,
                 name: str | None = None, expect: int | None = 200) -> Response:
        body: dict[str, Any] = {"username": actor.username, "activity": activity, "hours": hours, "date": date}
        if note is not None:
            body["note"] = note
        return self.post(actor, "/api/create-activity", name or f"{actor.name} logs {activity} {hours}h",
                         json=body, expect=expect)

    # ---------------------------------------------------------------- database (seeding / async waits)
    def require_db(self) -> Any:
        if self.svc.db is None:
            raise ScenarioSkip("needs direct database access (run with a harness-managed server or --database-url)")
        return self.svc.db

    def sql(self, statement: str, params: Iterable[Any] = ()) -> None:
        """Seed or adjust data directly (simulates cron jobs / the passage of time)."""
        self.require_db().execute(statement, tuple(params))

    def sql_value(self, statement: str, params: Iterable[Any] = ()) -> Any:
        row = self.require_db().execute(statement, tuple(params)).fetchone()
        return row[0] if row else None

    def wait_sql(self, what: str, statement: str, params: Iterable[Any] = (),
                 until: Callable[[Any], bool] = bool, timeout: float = 5.0) -> Any:
        """Poll the database until `until(first column of first row)` holds (async server work)."""
        if self.svc.db is None:
            time.sleep(min(timeout, 2.0))
            return None
        deadline = time.time() + timeout
        value = None
        while True:
            value = self.sql_value(statement, params)
            if until(value):
                time.sleep(0.05)  # let the server finish the request/goroutine that wrote it
                return value
            if time.time() >= deadline:
                raise ScenarioAbort(f"timed out after {timeout}s waiting for {what} (last value {value!r})")
            time.sleep(0.05)

    def wait_notifications(self, actor: Actor, count: int, timeout: float = 5.0) -> None:
        """Wait until `actor` has at least `count` notifications (they are created in goroutines)."""
        self.wait_sql(f"{count} notification(s) for {actor.name}",
                      "SELECT count(*) FROM notifications WHERE user_id = %s", (actor.id,),
                      until=lambda v: v is not None and v >= count, timeout=timeout)

    def settle(self, seconds: float = 0.3) -> None:
        """Give fire-and-forget server goroutines time to finish when there is nothing to poll."""
        time.sleep(seconds)

    def quiesce(self, stable: float = 0.15, timeout: float = 5.0) -> None:
        """Wait until no notification has been created/changed for `stable` seconds.

        Used after actions whose notifications are created in goroutines but may legitimately be
        skipped (dedupe), so that IDs of later notifications never depend on goroutine timing."""
        if self.svc.db is None:
            time.sleep(stable * 3)
            return
        query = "SELECT count(*)::text || ':' || coalesce(max(id), 0)::text || ':' || " \
                "count(read_at)::text FROM notifications"
        deadline = time.time() + timeout
        last = self.sql_value(query)
        last_change = time.time()
        while time.time() < deadline:
            time.sleep(0.03)
            cur = self.sql_value(query)
            if cur != last:
                last, last_change = cur, time.time()
            elif time.time() - last_change >= stable:
                return

    def wait_ws_subscribed(self, actor: Actor, count: int = 1, timeout: float = 5.0) -> None:
        """Wait until the server subscribed `count` WebSocket(s) of `actor` to its Redis channel."""
        if not self.svc.redis_url:
            time.sleep(0.5)
            return
        from .infra import parse_redis_url, redis_command

        host, port = parse_redis_url(self.svc.redis_url)
        channel = f"notif:channel:{actor.id}"
        deadline = time.time() + timeout
        while True:
            reply = redis_command(host, port, "PUBSUB", "NUMSUB", channel)
            m = re.search(rb":(\d+)\r\n$", reply)
            if m and int(m.group(1)) >= count:
                return
            if time.time() >= deadline:
                raise ScenarioAbort(f"WebSocket of {actor.name} not subscribed after {timeout}s ({reply!r})")
            time.sleep(0.05)

    # ---------------------------------------------------------------- blob storage
    def observe_blob(self, name: str, url: str | None) -> None:
        """Fetch a blob the server reported (mapping its public URL to the emulator) and record
        whether it exists plus its content type, image format and dimensions."""
        if not url or not self.svc.blob_endpoint:
            self.observe(name, {"url": url, "fetched": False})
            return
        m = re.match(r"https?://[^/]+/devstoreaccount1(/.*)$", url)
        if not m:
            self.observe(name, {"url": url, "fetched": False, "reason": "not an emulator URL"})
            return
        from urllib.parse import urlparse

        ep = urlparse(self.svc.blob_endpoint)
        res = http_request(ep.hostname or "127.0.0.1", ep.port or 80, "GET", ep.path + m.group(1), timeout=10.0)
        info: dict[str, Any] = {"status": res.status}
        if res.status == 200:
            info["content_type"] = res.headers.get("content-type")
            info.update(image_info(res.body))
        self.observe(name, info)

    # ---------------------------------------------------------------- email
    def email_token(self, to: str, count: int = 1, subject_contains: str | None = None, timeout: float = 10.0) -> str:
        if self.svc.smtp is None:
            raise ScenarioSkip("needs the harness SMTP sink")
        mails = self.svc.smtp.wait_for(to, count=count, timeout=timeout, subject_contains=subject_contains)
        if len(mails) < count:
            raise ScenarioAbort(f"expected {count} email(s) to {to} (subject~{subject_contains!r}), got {len(mails)}")
        m = re.search(r"token=([0-9a-fA-F]+)", mails[count - 1].body)
        if not m:
            raise ScenarioAbort(f"no token link in email to {to}")
        return m.group(1)

    def email_count(self, to: str, subject_contains: str | None = None) -> int:
        if self.svc.smtp is None:
            return 0
        return len(self.svc.smtp.wait_for(to, count=10**6, timeout=0, subject_contains=subject_contains))

    def observe_emails(self, name: str, to: str, subject_contains: str | None = None) -> None:
        """Record the emails sent to `to` so far (recipients, subject, links) as a step."""
        if self.svc.smtp is None:
            raise ScenarioSkip("needs the harness SMTP sink")
        mails = self.svc.smtp.wait_for(to, count=10**6, timeout=0, subject_contains=subject_contains)
        self.observe(name, [
            {"to": m.to, "subject": m.subject, "links": re.findall(r"https?://[^\"'\s<>]+", m.body)}
            for m in mails
        ])

    # ---------------------------------------------------------------- WebSocket
    def ws(self, actor: Actor, name: str, token: Any = True, upgrade: bool = True,
           path: str = "/api/ws/notifications") -> "WsSession | None":
        if token is True:
            token = actor.token
        full = path if token is None else f"{path}?token={token}"
        hs = ws_connect(self.svc.host, self.svc.port, full, source_ip=actor.ip, upgrade=upgrade)
        now = self._now(time.time())
        n = self.norm
        request = {"method": "GET", "path": n.string(full, now, path="request.path"),
                   "headers": {"upgrade": "websocket" if upgrade else "(none)"}}
        response: dict[str, Any] = {"status": hs.status,
                                    "headers": {k: v for k, v in hs.headers.items() if k in RECORDED_RESPONSE_HEADERS}}
        if hs.connection is None:
            parsed = None
            if "json" in hs.headers.get("content-type", "") and hs.body:
                try:
                    parsed = jsonx.loads(hs.body)
                except ValueError:
                    parsed = None
            if parsed is not None:
                response["body_type"], response["body"] = "json", n.value(parsed, now)
            elif hs.body:
                response["body_type"], response["body"] = "text", n.string(hs.body.decode("utf-8", "replace"), now)
            else:
                response["body_type"], response["body"] = "empty", ""
        n.take_issues()
        self._append(name, actor, request, response, [])
        return WsSession(self, actor, full, hs.connection) if hs.connection else None


class WsSession:
    def __init__(self, ctx: Ctx, actor: Actor, path: str, conn: WebSocketConnection):
        self.ctx = ctx
        self.actor = actor
        self.path = path
        self.conn = conn

    def recv(self, name: str, timeout: float = 5.0) -> Any:
        """Receive the next message and record it as a step; returns the parsed (plain) payload."""
        now_ts = time.time()
        try:
            kind, payload = self.conn.recv(timeout)
        except TimeoutError:
            kind, payload = "timeout", b""
        except Exception as exc:  # connection dropped
            kind, payload = "error", str(exc).encode()
        now = self.ctx._now(max(now_ts, time.time()))
        n = self.ctx.norm
        response: dict[str, Any] = {"ws_frame": kind}
        plain = None
        if kind == "text":
            try:
                parsed = jsonx.loads(payload)
                plain = jsonx.to_plain(parsed)
                response["body_type"], response["body"] = "json", n.value(parsed, now)
            except ValueError:
                response["body_type"], response["body"] = "text", n.string(payload.decode("utf-8", "replace"), now)
        elif kind == "close":
            code = int.from_bytes(payload[:2], "big") if len(payload) >= 2 else None
            response["close_code"] = code
            response["body"] = payload[2:].decode("utf-8", "replace")
        self.ctx._append(name, self.actor, {"method": "WS-RECV", "path": n.string(self.path, now)}, response,
                         n.take_issues())
        return plain

    def send(self, text: str) -> None:
        self.conn.send_text(text)

    def close(self) -> None:
        self.conn.close()
