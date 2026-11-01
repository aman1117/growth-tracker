# Growth Tracker API contract / parity tests

Records "golden" HTTP responses and checks a server against them, so the React frontend sees
**exactly** the same API: status codes, error
messages and codes, JSON shape (key presence, `null` vs `[]` vs missing), number formatting,
array order, selected headers, WebSocket frames and side effects (emails, stored blobs).

```
contract-tests/
  parity.py              CLI: record | check | list
  harness/               client (HTTP pool, multipart, WebSocket), normalizer, comparator,
                         orchestrator (DB/Redis/SMTP/Azurite/server lifecycle), scenario DSL
  scenarios/<domain>.py  the scenario library (every API route)
  goldens/<scenario>.json  recorded responses (one file per scenario)
```

## Provenance

The goldens in `goldens/` were recorded from the original Go (Fiber/GORM) backend at commit`
566d5be` (the last commit before the Rust rewrite), on a host in the Asia/Kolkata time zone. The
Rust server reproduces them with zero differences. To compare against the Go server again, check
out that commit, build it with `go build -o gt-go-server ./cmd/server` and pass it as`
--server-bin`.

## Prerequisites

* Python 3.11+ and `pip install -r requirements.txt` (`psycopg[binary]`, `aiosmtpd`).
* PostgreSQL (superuser; default `postgres:postgres@127.0.0.1:55432`) — the harness creates and
  drops its own `gtparity_*` databases.
* Redis (default `redis://127.0.0.1:56379`, no auth) — **FLUSHALL is sent before every scenario**,
  so never point it at a Redis holding data you care about.
* Node.js + npm for the Azure Blob emulator (Azurite is installed once into `.work/node`);
  without it the two blob scenarios are skipped (`--no-azurite` skips them explicitly).
* The server binary: `cd backend; cargo build --release --bin server` (`target/release/server`).

## Running

```powershell
cd backend\contract-tests
# check the server against the goldens; non-zero exit on any mismatch
python parity.py check --server-bin ..\target\release\server.exe --goldens goldens --keep-going
# re-record goldens (only for an intentional API change; review the diff of goldens/)
python parity.py record --server-bin ..\target\release\server.exe --out goldens
# a subset: names or domains, globs allowed, repeatable
python parity.py check --server-bin ... --scenario follow --scenario "auth_*"
# list scenarios (with recorded step counts per domain)
python parity.py list --goldens goldens
```

Useful options: `--keep-going` (do not stop at the first failing scenario), `--pg-host/--pg-port/
--pg-user/--pg-password`, `--redis-url`, `--smtp-port`, `--work-dir`, `--fail-on-skip`.

For every scenario the harness: clones a freshly migrated template database, flushes Redis,
starts the server on a free port with a fixed environment (`ENV=development`, `TZ=Asia/Kolkata`,
JWT secret, SMTP sink, VAPID key, maintenance key, Azurite for blob scenarios, an empty working
directory so a local `.env` is never loaded), runs the steps, then kills the server. The template
is built once per run by starting the server under test on an empty database (it migrates the
schema) and applying the idempotent SQL the Go server needed from its manual migration scripts
(`pg_trgm`, `story_likes`, `recent_searches`, indexes; a no-op for the Rust server). Server logs go to `.work/run-*/logs/<scenario>.log`; the path is
printed for every failing scenario.

`--base-url http://host:port` runs against an already running server instead (no lifecycle,
no Azurite / env-specific scenarios; add `--database-url` to enable scenarios that seed data or
wait for asynchronous work — the database is truncated before each scenario). Rate-limit
headers are not compared in this mode (the server's limiter state is not reset).

### Clock safety

The server's output depends on the date in IST, and on cron jobs. The harness waits before a
scenario that would overlap 23:58–00:07 IST (date rollover, streak and challenge crons),
21:58–22:02 IST (streak reminders) or 05:28–05:32 IST (UTC midnight).

## What is compared, and normalization

Each step stores the request (method, path, recorded headers, body) and the response (status,
`Content-Type`, `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, body as JSON or
text). Goldens are pretty-printed with sorted keys; numbers are kept as their literal text.
Before comparing, golden and live exchanges go through the same normalizer:

| value | becomes |
|---|---|
| JWT | `<JWT>` |
| RFC3339 timestamp (not midnight) | `<TIME Z>` / `<TIME +05:30>` — the zone designator is kept, and `skew=+05:30` is added when the instant is off from the wall clock (rounded to 30 min), e.g. local times labelled `Z` or the +24h token expiry |
| timestamp with trailing fractional zeros or a bare `.` | reported as a **format mismatch** (Go trims them) |
| midnight timestamp / ISO date / `2 Jan, 2006` date | relative to the scenario anchor: `<TODAY>T00:00:00Z`, `<TODAY-3>`, `<WEEK+6>`, `<TODAY-1:human>` (dates more than 400 days away are kept verbatim) |
| random UUIDs (request ids, connection ids, blob names) | `<UUID#n>` (scenario-chosen ids `c0deNNNN-0000-4000-8000-…` are kept) |
| challenge invite codes | `<CODE#n>` (`<CODE#n:lower>` for the lower-case spelling) |
| follow-list cursors (`next_cursor` strings) | `<CURSOR#n>` |
| 64-hex reset / verification tokens | `<TOKEN#n>` |

Numbered placeholders are assigned in order of first appearance within a scenario, so a value
reused later (an invite code in a URL, a cursor) maps to the same placeholder. Everything else
is compared exactly. Two header rules account for wall-clock effects only:

* `Retry-After` is compared as *Retry-After + age of the limiter window* (≈ the window length),
  ±3 s: the raw value depends on how long the scenario took to reach the limit.
* Fiber limiter windows are fixed 60 s / 15 min windows. Each limited response is annotated
  with its limiter key, window number and hit count (see `harness/ratelimit.py`); a different
  `X-RateLimit-Remaining` is accepted only when the two runs are in a different window for that
  key *and* the live value equals `limit - hits` of its own window.

Asynchronous server work (notifications created in goroutines, recent searches, debounced photo
notifications, WebSocket subscriptions) is awaited by polling the database or Redis
(`PUBSUB NUMSUB`), never by weakening comparisons.

## Writing a scenario

```python
from harness.runner import Ctx, scenario

@scenario("likes_example", "likes", requires=("db",))   # requires: db | smtp | azurite
def likes_example(t: Ctx) -> None:
    """One-line description (shown by `parity.py list`)."""
    alice, bob = t.users("alice", "bob")             # register + login (each actor has its own IP)
    t.activity(alice, "study", 2, t.day(0))          # dates relative to today in IST
    r = t.post(bob, "/api/like-day", "bob likes alice's day",
               json={"username": "alice", "date": t.day(0)})
    t.get(alice, "/api/notifications", "alice sees the like")
```

* Every `t.get/post/put/patch/delete/call` is recorded as a step (name must be stable);
  `auth=False` sends no token, `auth="Bearer …"` a custom header, `raw=` a raw body,
  `form=`/`files=` multipart, `headers=` extra headers, `record=False` an unrecorded request.
* `r.get("a.b.0")` / `r.need(...)` read values from responses to reuse them later.
* `t.anon()`, `t.new_ip(actor)`: separate source IPs (127.x.y.z) for IP-keyed rate limits
  (5 auth requests/min, 5 password-reset requests/15 min).
* `t.sql(...)`, `t.wait_sql(...)`, `t.wait_notifications(...)`, `t.quiesce()`: seed data or
  wait for goroutines; `t.ws(...)` for WebSockets; `t.email_token(...)`/`t.observe_emails(...)`
  for emails; `t.observe(...)`/`t.observe_blob(...)` to record side effects as steps.
* Never create activities for IST *yesterday*: whether that touches streaks depends on the
  time of day (the streak service compares against the UTC date).
* Keep ties out of orderings the server does not define (e.g. use distinct hours or follower
  counts), then add the module to `scenarios/__init__.py`, record it and run `check` twice:
  it must report zero differences.
