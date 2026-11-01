#!/usr/bin/env python3
"""Growth Tracker HTTP API contract/parity harness.

Records golden responses from a reference server (the Go backend) and checks another server
(the Rust rewrite) against them. See README.md.

  python parity.py record --server-bin %TEMP%\\gt-go-server.exe --out goldens
  python parity.py check  --server-bin path\\to\\rust-server.exe --goldens goldens
  python parity.py check  --base-url http://127.0.0.1:8080 --goldens goldens --scenario auth_*
  python parity.py list   [--goldens goldens]
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from harness import jsonx  # noqa: E402
from harness.infra import PgConfig  # noqa: E402
from harness.orchestrator import Orchestrator, RunConfig, select_scenarios  # noqa: E402
from harness.runner import REGISTRY  # noqa: E402
import scenarios  # noqa: E402,F401  (registers every scenario)


def _add_common(p: argparse.ArgumentParser) -> None:
    p.add_argument("--server-bin", help="server executable to start for every scenario (harness-managed lifecycle)")
    p.add_argument("--base-url", help="use an already-running server instead (skips lifecycle)")
    p.add_argument("--database-url", help="with --base-url: Postgres URL of that server's DB "
                                          "(truncated before each scenario; enables seeding/waits)")
    p.add_argument("--redis-url", default=os.environ.get("PARITY_REDIS_URL", "redis://127.0.0.1:56379"),
                   help="Redis the server uses (FLUSHALL before each scenario)")
    p.add_argument("--pg-host", default="127.0.0.1")
    p.add_argument("--pg-port", type=int, default=55432)
    p.add_argument("--pg-user", default="postgres")
    p.add_argument("--pg-password", default="postgres")
    p.add_argument("--scenario", action="append", default=[], metavar="NAME",
                   help="run only matching scenarios (name or domain, glob allowed; repeatable)")
    p.add_argument("--keep-going", action="store_true", help="do not stop at the first failing scenario")
    p.add_argument("--no-azurite", action="store_true", help="do not start the Azure Blob emulator (blob scenarios are skipped)")
    p.add_argument("--smtp-port", type=int, help="port for the SMTP sink (default: random; 1025 with --base-url)")
    p.add_argument("--work-dir", default=str(HERE / ".work"), help="scratch directory for logs and emulator data")
    p.add_argument("--fail-on-skip", action="store_true", help="treat skipped scenarios as failures")
    p.add_argument("-v", "--verbose", action="store_true")


def _config(args: argparse.Namespace, mode: str, goldens: str) -> RunConfig:
    return RunConfig(
        mode=mode,
        goldens_dir=Path(goldens).resolve(),
        # absolute: the server runs in an empty working directory
        server_bin=str(Path(os.path.expandvars(args.server_bin)).resolve()) if args.server_bin else None,
        base_url=args.base_url,
        database_url=args.database_url,
        redis_url=args.redis_url,
        pg=PgConfig(args.pg_host, args.pg_port, args.pg_user, args.pg_password),
        filters=args.scenario,
        keep_going=args.keep_going,
        azurite=not args.no_azurite,
        smtp_port=args.smtp_port,
        work_root=Path(args.work_dir),
        verbose=args.verbose,
        fail_on_skip=args.fail_on_skip,
    )


def cmd_list(args: argparse.Namespace) -> int:
    goldens = Path(args.goldens) if args.goldens else None
    by_domain: dict[str, list[tuple[str, int | None]]] = {}
    for s in select_scenarios(args.scenario):
        steps = None
        if goldens and (goldens / f"{s.name}.json").exists():
            steps = jsonx.loads((goldens / f"{s.name}.json").read_text(encoding="utf-8"))["step_count"]
            steps = int(steps)
        by_domain.setdefault(s.domain, []).append((s.name, steps))
        flags = ",".join(s.requires)
        print(f"{s.domain:16} {s.name:42} {'' if steps is None else steps:>5}  {flags:20} {s.description}")
    if goldens:
        print()
        total_s = total_st = 0
        for domain, items in by_domain.items():
            n_steps = sum(st or 0 for _, st in items)
            total_s += len(items)
            total_st += n_steps
            print(f"{domain:16} {len(items):3d} scenario(s) {n_steps:5d} step(s)")
        print(f"{'TOTAL':16} {total_s:3d} scenario(s) {total_st:5d} step(s)")
    return 0


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):  # never crash on non-ASCII diff output in a legacy console
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="backslashreplace", line_buffering=True)
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)

    rec = sub.add_parser("record", help="run scenarios against the reference server and write golden files")
    _add_common(rec)
    rec.add_argument("--out", default=str(HERE / "goldens"), help="goldens directory to write")

    chk = sub.add_parser("check", help="run scenarios and compare against golden files")
    _add_common(chk)
    chk.add_argument("--goldens", default=str(HERE / "goldens"), help="goldens directory to compare against")

    lst = sub.add_parser("list", help="list scenarios (with recorded step counts when --goldens is given)")
    lst.add_argument("--goldens", default=None)
    lst.add_argument("--scenario", action="append", default=[])

    args = parser.parse_args(argv)
    if args.cmd == "list":
        return cmd_list(args)
    if not args.server_bin and not args.base_url:
        parser.error("either --server-bin or --base-url is required")
    goldens = args.out if args.cmd == "record" else args.goldens
    cfg = _config(args, args.cmd, goldens)
    return Orchestrator(cfg).run()


if __name__ == "__main__":
    sys.exit(main())
