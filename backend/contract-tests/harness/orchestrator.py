"""Runs scenarios against a server under test: environment setup, per-scenario isolation,
recording goldens and comparing live runs against them."""

from __future__ import annotations

import fnmatch
import os
import time
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from . import jsonx
from .compare import diff_scenario
from .dates import wait_for_safe_window
from .infra import (
    EXTRA_SCHEMA_SQL, Azurite, PgAdmin, PgConfig, SmtpSink, clean_old_runs, env_without_app_config, free_port,
    redis_flushall,
)
from .runner import REGISTRY, Ctx, ScenarioAbort, ScenarioDef, ScenarioSkip, Services
from .server import ServerProcess, ServerStartError

MAINTENANCE_KEY = "parity-maintenance-key"
VAPID_PUBLIC_KEY = "BParityTestVapidPublicKey0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ01"
VAPID_KEY_ID = "parity-key-1"
RATE_LIMIT_HEADERS = {"x-ratelimit-limit", "x-ratelimit-remaining", "retry-after"}


@dataclass
class RunConfig:
    mode: str  # "record" | "check"
    goldens_dir: Path
    server_bin: str | None = None
    base_url: str | None = None
    database_url: str | None = None
    redis_url: str = "redis://127.0.0.1:56379"
    pg: PgConfig = field(default_factory=PgConfig)
    filters: list[str] = field(default_factory=list)
    keep_going: bool = False
    azurite: bool = True
    smtp_port: int | None = None
    jwt_secret: str = "parity-jwt-secret-do-not-use-in-prod"
    work_root: Path = Path(".work")
    verbose: bool = False
    fail_on_skip: bool = False


@dataclass
class ScenarioResult:
    sdef: ScenarioDef
    status: str  # PASS | FAIL | SKIP | RECORDED | ERROR
    steps: list[dict[str, Any]] = field(default_factory=list)
    diffs: list[tuple[dict[str, Any] | None, list[str]]] = field(default_factory=list)
    message: str = ""
    warnings: list[str] = field(default_factory=list)
    duration: float = 0.0
    log_path: Path | None = None


def select_scenarios(filters: list[str]) -> list[ScenarioDef]:
    if not filters:
        return list(REGISTRY)
    chosen = [s for s in REGISTRY if any(fnmatch.fnmatch(s.name, f) or fnmatch.fnmatch(s.domain, f) for f in filters)]
    if not chosen:
        raise SystemExit(f"no scenario matches {filters}; see `python parity.py list`")
    return chosen


class Orchestrator:
    def __init__(self, cfg: RunConfig, log=print):
        self.cfg = cfg
        self.log = log
        self.run_id = time.strftime("%Y%m%d-%H%M%S") + f"-{os.getpid()}"
        self.work = (cfg.work_root / f"run-{self.run_id}").resolve()
        self.pg = PgAdmin(cfg.pg)
        self.db_prefix = "gtparity_" + self.run_id.replace("-", "_")
        self.template_db: str | None = None
        self.smtp: SmtpSink | None = None
        self.azurite: Azurite | None = None
        self.azurite_error: str | None = None
        self.managed = cfg.base_url is None
        self.results: list[ScenarioResult] = []

    # ------------------------------------------------------------------ environment
    def server_env(self, db_url: str, port: int, sdef: ScenarioDef | None) -> dict[str, str]:
        env = env_without_app_config()
        env.update({
            "DATABASE_URL": db_url,
            "REDIS_URL": self.cfg.redis_url,
            "JWT_SECRET_KEY": self.cfg.jwt_secret,
            "PORT": str(port),
            "ENV": "development",
            "TZ": "Asia/Kolkata",
            "FRONTEND_BASE_URL": "http://frontend.parity.test",
            "SMTP_HOST": "127.0.0.1",
            "SMTP_PORT": str(self.smtp.port if self.smtp else 1),
            "RESEND_API_KEY": "",
            "EMAIL_FROM_ADDRESS": "noreply@parity.test",
            "MAINTENANCE_API_KEY": MAINTENANCE_KEY,
            "PPROF_ENABLED": "false",
            "VAPID_PUBLIC_KEY": VAPID_PUBLIC_KEY,
            "VAPID_KEY_ID": VAPID_KEY_ID,
            "HOSTNAME": "parity-harness",
        })
        if sdef and "azurite" in sdef.requires and self.azurite:
            env.update({
                "AZURE_STORAGE_CONNECTION_STRING": self.azurite.connection_string,
                "AZURE_STORAGE_ACCOUNT_NAME": "devstoreaccount1",
                "AZURE_STORAGE_CONTAINER": self.azurite.container,
            })
        for k, v in (sdef.env if sdef else {}).items():
            if v is None:
                env.pop(k, None)
            else:
                env[k] = v
        return env

    def setup(self, selected: list[ScenarioDef]) -> None:
        self.cfg.work_root.mkdir(parents=True, exist_ok=True)
        clean_old_runs(self.cfg.work_root.resolve(), keep=5)
        (self.work / "logs").mkdir(parents=True, exist_ok=True)
        self.log(f"work dir: {self.work}")

        if any("smtp" in s.requires for s in selected) or self.managed:
            port = self.cfg.smtp_port or (None if self.managed else 1025)
            self.smtp = SmtpSink(port=port)
            try:
                self.smtp.start()
                self.log(f"smtp sink: 127.0.0.1:{self.smtp.port}")
            except Exception as exc:  # port in use, etc.
                self.log(f"WARNING: SMTP sink unavailable ({exc}); email scenarios will be skipped")
                self.smtp = None

        if self.managed and self.cfg.azurite and any("azurite" in s.requires for s in selected):
            az = Azurite(self.work, log=self.log)
            try:
                az.start()
                self.azurite = az
                self.log(f"azurite: 127.0.0.1:{az.port} (container {az.container})")
            except Exception as exc:
                self.azurite_error = str(exc)
                self.log(f"WARNING: Azurite unavailable ({exc}); blob scenarios will be skipped")
                az.stop()
        elif not self.cfg.azurite:
            self.azurite_error = "disabled with --no-azurite"

        if self.managed:
            self.build_template()

    def start_server(self, db_url: str, sdef: ScenarioDef | None, log_path: Path) -> tuple[ServerProcess, int, float]:
        """Starts the server under test on a free port; returns it, its port and the startup time.

        Retries on another port when the chosen one was taken before the server could bind it."""
        attempts = 3
        for attempt in range(1, attempts + 1):
            port = free_port()
            server = ServerProcess(self.cfg.server_bin, self.server_env(db_url, port, sdef),
                                   self.work / "server-cwd", log_path, port)
            server.start()
            try:
                return server, port, server.wait_ready()
            except ServerStartError as exc:
                server.stop()
                if not exc.port_in_use or attempt == attempts:
                    raise
                self.log(f"  port {port} was taken before the server bound it; retrying on another port")
        raise AssertionError("unreachable")

    def build_template(self) -> None:
        """Fresh DB -> server migrates it -> extra SQL -> reused as TEMPLATE for every scenario."""
        self.template_db = f"{self.db_prefix}_tpl"
        self.log(f"building schema template {self.template_db} with {self.cfg.server_bin}")
        self.pg.create_db(self.template_db)
        server, _, took = self.start_server(self.cfg.pg.url(self.template_db), None,
                                            self.work / "logs" / "_template.log")
        try:
            self.pg.execute_script(self.template_db, EXTRA_SCHEMA_SQL)
            self.log(f"  server migrated the schema in {took:.1f}s")
        finally:
            server.stop()
        self.pg.terminate(self.template_db)

    def teardown(self) -> None:
        if self.azurite:
            self.azurite.stop()
        if self.smtp:
            self.smtp.stop()
        if self.managed:
            try:
                for db in self.pg.list_dbs(self.db_prefix):
                    self.pg.drop_db(db)
            except Exception as exc:
                self.log(f"WARNING: could not drop test databases: {exc}")

    # ------------------------------------------------------------------ scenarios
    def skip_reason(self, sdef: ScenarioDef) -> str | None:
        if "azurite" in sdef.requires and not self.azurite:
            return f"Azure Blob emulator not available ({self.azurite_error or 'not started'})"
        if "smtp" in sdef.requires and not self.smtp:
            return "SMTP sink not available"
        if not self.managed:
            if "managed" in sdef.requires or sdef.env or "azurite" in sdef.requires:
                return "needs a harness-managed server (specific server configuration)"
            if "db" in sdef.requires and not self.cfg.database_url:
                return "needs --database-url for seeding / async waits"
        return None

    def run_one(self, idx: int, sdef: ScenarioDef) -> ScenarioResult:
        result = ScenarioResult(sdef, "ERROR")
        reason = self.skip_reason(sdef)
        if reason:
            result.status, result.message = "SKIP", reason
            return result

        wait_for_safe_window(horizon_s=150, log=self.log)
        started = time.time()
        server: ServerProcess | None = None
        db_conn = None
        db_name = None
        try:
            if self.managed:
                db_name = f"{self.db_prefix}_{idx:03d}"
                self.pg.create_db(db_name, template=self.template_db)
                redis_flushall(self.cfg.redis_url)
                result.log_path = self.work / "logs" / f"{sdef.name}.log"
                server, port, _ = self.start_server(self.cfg.pg.url(db_name), sdef, result.log_path)
                db_conn = self.pg.connect(db_name)
                host = "127.0.0.1"
                ip_base = (0, 1)
            else:
                parsed = urlparse(self.cfg.base_url)
                host, port = parsed.hostname or "127.0.0.1", parsed.port or 80
                if self.cfg.database_url:
                    import psycopg

                    db_conn = psycopg.connect(self.cfg.database_url, autocommit=True)
                    PgAdmin.truncate_conn(db_conn)
                if self.cfg.redis_url:
                    redis_flushall(self.cfg.redis_url)
                ip_base = (1 + (int(time.time()) // 60) % 200, 1 + idx % 50)  # fresh limiter keys per run
            if self.smtp:
                self.smtp.clear()

            blob_endpoint = (f"http://127.0.0.1:{self.azurite.port}/devstoreaccount1"
                             if self.azurite and "azurite" in sdef.requires else None)
            ctx = Ctx(sdef, Services(host, port, db_conn, self.smtp, ip_base, self.cfg.redis_url, blob_endpoint),
                      self.cfg.jwt_secret, self.log)
            try:
                sdef.func(ctx)
                result.status = "OK"
            except ScenarioSkip as exc:
                result.status, result.message = "SKIP", str(exc)
            except ScenarioAbort as exc:
                result.status, result.message = "ABORT", f"scenario aborted: {exc}"
            except Exception as exc:  # broken scenario code or unexpected live response shape
                result.status = "ABORT"
                result.message = f"scenario raised {type(exc).__name__}: {exc}\n{traceback.format_exc(limit=4)}"
            finally:
                ctx.http.close()
            result.steps = ctx.steps
            result.warnings = ctx.warnings
        except ServerStartError as exc:
            result.status, result.message = "ERROR", str(exc)
        except Exception as exc:
            result.status, result.message = "ERROR", f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=6)}"
        finally:
            if server:
                server.stop()
            if db_conn is not None:
                db_conn.close()
            if db_name:
                try:
                    self.pg.drop_db(db_name)
                except Exception as exc:
                    self.log(f"WARNING: could not drop {db_name}: {exc}")
            result.duration = time.time() - started
        return result

    # ------------------------------------------------------------------ goldens
    def golden_path(self, sdef: ScenarioDef) -> Path:
        return self.cfg.goldens_dir / f"{sdef.name}.json"

    def write_golden(self, sdef: ScenarioDef, steps: list[dict[str, Any]]) -> None:
        self.cfg.goldens_dir.mkdir(parents=True, exist_ok=True)
        doc = {
            "scenario": sdef.name,
            "domain": sdef.domain,
            "description": sdef.description,
            "date_anchor": sdef.anchor,
            "step_count": len(steps),
            "steps": steps,
        }
        self.golden_path(sdef).write_text(jsonx.dumps(doc), encoding="utf-8")

    def load_golden(self, sdef: ScenarioDef) -> dict[str, Any] | None:
        path = self.golden_path(sdef)
        if not path.exists():
            return None
        return jsonx.loads(path.read_text(encoding="utf-8"))

    # ------------------------------------------------------------------ main loop
    def run(self) -> int:
        selected = select_scenarios(self.cfg.filters)
        mode = self.cfg.mode
        if self.managed and not self.cfg.server_bin:
            raise SystemExit("--server-bin is required unless --base-url is given")
        if self.managed and not Path(self.cfg.server_bin).exists():
            raise SystemExit(f"server binary not found: {self.cfg.server_bin}")
        if mode == "check" and not self.cfg.goldens_dir.exists():
            raise SystemExit(f"goldens directory not found: {self.cfg.goldens_dir}")

        self.log(f"{mode}: {len(selected)} scenario(s) against "
                 f"{self.cfg.base_url or self.cfg.server_bin}")
        ignore_headers = set() if self.managed else RATE_LIMIT_HEADERS
        if not self.managed:
            self.log("note: --base-url mode ignores rate-limit headers (the server's limiter state is not reset)")
        stop = False
        try:
            self.setup(selected)
            for idx, sdef in enumerate(selected, 1):
                if stop:
                    break
                res = self.run_one(idx, sdef)
                if mode == "record":
                    if res.status == "OK":
                        self.write_golden(sdef, res.steps)
                        res.status = "RECORDED"
                    elif res.status == "ABORT":
                        res.status = "ERROR"
                else:
                    golden = self.load_golden(sdef)
                    if res.status in ("OK", "ABORT"):
                        if golden is None:
                            res.status, res.message = "FAIL", f"no golden file {self.golden_path(sdef)}"
                        else:
                            # Round-trip through the golden serialization so both sides share one representation
                            live_steps = jsonx.loads(jsonx.dumps(res.steps))
                            res.diffs = diff_scenario(golden["steps"], live_steps, ignore_headers)
                            aborted = res.status == "ABORT"
                            res.status = "FAIL" if res.diffs or aborted else "PASS"
                self.results.append(res)
                self.report(res)
                if res.status in ("FAIL", "ERROR") and not self.cfg.keep_going:
                    self.log("stopping at the first failure (use --keep-going to run everything)")
                    stop = True
        except KeyboardInterrupt:
            self.log("interrupted")
        finally:
            self.teardown()
        return self.summary()

    def report(self, res: ScenarioResult) -> None:
        name = res.sdef.name
        steps = len(res.steps)
        line = f"[{res.status:8}] {name:40} {steps:4d} steps  {res.duration:5.1f}s"
        if res.status == "SKIP":
            line += f"  ({res.message})"
        self.log(line)
        if res.status in ("FAIL", "ERROR"):
            if res.message:
                for l in res.message.rstrip().splitlines():
                    self.log(f"    ! {l}")
            for step, lines in res.diffs:
                if step is None:
                    self.log(f"    - {lines[0]}")
                    continue
                req = step["request"]
                self.log(f"    #{step['index']} {step['name']!r}  {req.get('method')} {req.get('path')}")
                for l in lines:
                    self.log(f"        - {l}")
            if res.log_path:
                self.log(f"    server log: {res.log_path}")
        if res.warnings and (self.cfg.verbose or res.status in ("RECORDED", "ERROR", "FAIL")):
            for w in res.warnings:
                self.log(f"    ? {w}")

    def summary(self) -> int:
        counts: dict[str, int] = {}
        for r in self.results:
            counts[r.status] = counts.get(r.status, 0) + 1
        total_steps = sum(len(r.steps) for r in self.results)
        mismatched = sum(len([d for d in r.diffs if d[0] is not None]) for r in self.results)
        self.log("")
        self.log("summary: " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items()))
                 + f"; {total_steps} steps" + (f"; {mismatched} mismatching step(s)" if self.cfg.mode == "check" else ""))
        self.log(f"logs: {self.work / 'logs'}")
        if counts.get("FAIL") or counts.get("ERROR"):
            return 1
        if self.cfg.fail_on_skip and counts.get("SKIP"):
            return 1
        return 0
