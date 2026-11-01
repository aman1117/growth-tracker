# Growth Tracker Backend

The Growth Tracker API, written in **Rust** (axum + tokio + sqlx + redis). It is a Cargo workspace of small, focused crates with clear separation between HTTP handlers, business services and data access.

> The backend was ported from Go (Fiber/GORM) to Rust with a byte-for-byte compatible HTTP contract. Every route, status code, header and JSON body matches the previous implementation. This is proven by the golden contract suite in [`contract-tests/`](contract-tests/README.md).

## 🏗️ Architecture

```
backend/
├── Cargo.toml                 # Workspace definition + shared dependency versions
├── Cargo.lock
├── crates/
│   ├── gt-core/               # Shared foundation used by every other crate
│   │   ├── config.rs          #   environment configuration (same variables as before)
│   │   ├── logging.rs         #   structured JSON logging (+ optional Axiom shipping)
│   │   ├── db.rs, schema.sql  #   Postgres pool + idempotent schema migration at startup
│   │   ├── redis.rs           #   optional Redis client (auto-reconnect) + cache helpers
│   │   ├── jwt.rs, guard.rs   #   JWT auth and per-route auth / rate-limit guards
│   │   ├── ratelimit.rs       #   fixed-window limiter (X-RateLimit-* headers)
│   │   ├── gojson.rs          #   wire-compatible JSON / time formatting
│   │   ├── error.rs, response.rs, extract.rs, body.rs, validator.rs, timeutil.rs
│   │   └── models/            #   database entities
│   ├── gt-users/              # Users, auth, profiles, follows, streaks, badges, email
│   ├── gt-accounts/           # Auth/profile/follow/badge HTTP routes
│   ├── gt-notify/             # Notifications, WebSocket, web-push (+ `pushworker` binary)
│   ├── gt-activity/           # Activities, analytics, tile config, likes, stories
│   ├── gt-photos/             # Blob storage, image processing, activity photos
│   ├── gt-comments/           # Comments and comment likes
│   ├── gt-challenges/         # Challenges, invites, leaderboards
│   ├── gt-jobs/               # Daily cron jobs + seed / reminder CLI binaries
│   └── gt-server/             # HTTP server: routing, CORS, middleware, swagger, scheduler
├── contract-tests/            # Golden HTTP contract suite (Python)
├── docs/swagger.json          # OpenAPI document served at /swagger
├── Dockerfile, Dockerfile.pushworker          # Production images (static musl binaries)
└── Dockerfile.dev, Dockerfile.pushworker.dev  # Hot-reload dev images (cargo-watch)
```

Each feature crate follows the same layering:

```
HTTP Request
    ↓
gt-server (CORS, request logging, trace id, panic recovery, routing)
    ↓
Route guards (JWT auth, rate limiting)
    ↓
Handler (HTTP concerns, validation)
    ↓
Service (business logic)
    ↓
Repository (sqlx queries)
    ↓
PostgreSQL / Redis
```

## 🚀 Getting Started

### Prerequisites

- Rust (stable, via [rustup](https://rustup.rs))
- PostgreSQL (or Neon serverless)
- Redis (optional: caching, password reset, rate-limit sharing, pub/sub)
- Azure Storage or Azurite (optional: profile pictures and activity photos)

### Installation

1. Clone the repository:
```bash
git clone https://github.com/aman1117/growth-tracker.git
cd growth-tracker/backend
```

2. Copy environment template:
```bash
cp .env.example .env
```

3. Configure your environment variables in `.env`

4. Run the server (the schema is created/migrated automatically on startup):
```bash
cargo run --bin server
```

### Building

```bash
# Optimised binaries in target/release/
cargo build --release --bin server --bin pushworker

# Run binary
./target/release/server
```

### Binaries

| Binary | Crate | Purpose |
|--------|-------|---------|
| `server` | `gt-server` | HTTP API + WebSocket + scheduled jobs |
| `pushworker` | `gt-notify` | Web-push delivery worker (Azure Service Bus consumer) |
| `seed` | `gt-jobs` | Seed development data |
| `seed_badges` | `gt-jobs` | Backfill badges for existing users |
| `send_reminders` | `gt-jobs` | Send streak reminder emails now |
| `test_reminder` | `gt-jobs` | Send a test reminder email |
| `backfill_profile_thumbs` | `gt-photos` | Generate missing profile picture thumbnails |

Run any of them with `cargo run --bin <name>`.

## ⏰ Scheduled Jobs

The server runs these daily jobs (Asia/Kolkata time):

| Time | Job |
|------|-----|
| 00:00 | Streak processing |
| 00:05 | Challenge completion + stale invite cleanup |
| 03:00 | Old notification cleanup |
| 04:00 | Follow tombstone cleanup |
| 22:00 | Streak reminder emails |

## 🔐 API Endpoints

### Authentication
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Register new user |
| POST | `/api/auth/login` | Login user |
| POST | `/api/auth/refresh` | Refresh JWT token |

### Profile
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/profile/me` | Get current user |
| PUT | `/api/profile/bio` | Update bio |
| PUT | `/api/profile/username` | Update username |
| PUT | `/api/profile/password` | Change password |
| GET | `/api/profile/search` | Search users |
| GET | `/api/profile/{username}` | Get user by username |

### Activities
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/activities` | Get activities (with filters) |
| PUT | `/api/activities` | Update activities |

### Streaks
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/streaks` | Get user streaks |
| GET | `/api/streaks/user/{username}` | Get user streaks by username |

### Analytics
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/analytics/week` | Get weekly analytics |

### Tile Configuration
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/tile-config` | Get user tile config |
| PUT | `/api/tile-config` | Update tile config |

### Password Reset
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/forgot-password` | Request password reset |
| POST | `/api/auth/reset-password` | Reset password with token |

### Profile Picture
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/profile/picture` | Upload profile picture |
| DELETE | `/api/profile/picture` | Delete profile picture |

## 🔁 Compatibility With the Go Backend

The Rust server is a drop-in replacement: same routes, status codes, headers, JSON bodies
(including key order, `null` vs `[]`, number and timestamp formats), rate limits, WebSocket
messages, emails, blob names, database schema and environment variables. Existing databases are
used as-is. The golden contract suite (`make backend-contract`) proves this for every route.

Deliberate differences, none visible to the web app:

- **JSON request keys must match exactly.** Go's decoder also accepted other letter cases
  (`Username` for `username`) and duplicate keys (last one wins); these requests now get the
  usual `400` invalid-body response.
- **No `/debug/pprof` endpoints** (`PPROF_*` variables are ignored); use OS-level profilers.
- **Graceful shutdown:** SIGTERM finishes in-flight requests (up to 10 s) and flushes logs and
  queued push messages instead of exiting immediately.
- **Read timeout** applies to the request head and idle keep-alive connections, not to the
  body, so slow photo uploads on mobile networks are no longer cut off after 30 s.
- **Paths starting with `/api/profile` but not followed by `/`** (e.g. `/api/profilex`) return
  `404` instead of Fiber's prefix-matched `401`.
- **Internal error details** in a few `500` messages differ (Azure Blob SDK and image decoder
  texts), as do log field layouts; log messages are unchanged.
- **Ties that Go resolved randomly** (map iteration order) are now deterministic: activity
  summaries with equal totals and the order in which invalid tile colours are reported.
- **IDs and cursors above 2^63−1** are treated as not found / first page (same responses as Go
  except a cursor that large, which returned `500`).
- `test_reminder` no longer panics after storing the first notification.
## 🔧 Configuration

All configuration is done via environment variables. These are the same variables as the previous Go service, so existing deployments need no changes.

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 8000) |
| `ENV` | No | `development` or `production` (default: `development`) |
| `DATABASE_URL` | Yes* | PostgreSQL connection string (*or the `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USERNAME`, `DB_PASSWORD`, `DB_SSLMODE` parts) |
| `JWT_SECRET_KEY` | Yes | JWT signing secret (every token is rejected while unset) |
| `TTL_ACCESS_TOKEN` | No | Access token lifetime in minutes (default: 1440) |
| `SERVER_READ_TIMEOUT` / `SERVER_WRITE_TIMEOUT` | No | Connection timeouts as Go durations (default: `30s`) |
| `REDIS_URL` | No | Redis connection string |
| `AZURE_STORAGE_CONNECTION_STRING` | No | Azure Blob storage (profile pictures, activity photos) |
| `AZURE_SERVICEBUS_CONNECTION_STRING` | No | Service Bus queue for web push |
| `RESEND_API_KEY` | No | Resend API key for emails (SMTP via `SMTP_HOST`/`SMTP_PORT` otherwise) |
| `AXIOM_API_TOKEN` / `AXIOM_DATASET` | No | Ship production logs to Axiom |
| `MAINTENANCE_API_KEY` | No | Enables `POST /api/push/cleanup` |
| `RUST_LOG` | No | Optional log filter override (e.g. `info,sqlx=warn`) |
See `.env.example` for full configuration options.

> **Runtime profiling:** the Go-specific `/debug/pprof` endpoints (`PPROF_*` variables) were removed with the Go runtime. Use OS-level profilers such as `perf`, `samply` or `cargo flamegraph` instead.

## 🏛️ Design Principles

### Clean Architecture
- Dependencies point inward (`gt-core` ← feature crates ← `gt-server`)
- Business logic is framework-agnostic
- External concerns are abstracted

### Dependency Injection
- Each crate exposes a `*Context` struct built from shared dependencies
- No hidden global state (except the logger and the optional Redis client)
- Easy to test with a real Postgres/Redis or pure unit tests

### Single Responsibility
- Each crate and module has one job
- Handlers don't do business logic
- Services don't do HTTP

### Explicit over Implicit
- No magic configuration
- All constants defined explicitly
- Clear error messages

### Graceful Degradation
- Optional features fail gracefully
- Missing Redis disables password reset and caching
- Missing email service disables notifications
- Graceful shutdown on SIGTERM/Ctrl-C

## 📝 Code Style

- `cargo fmt` formatting (configured in `rustfmt.toml`) and `cargo clippy -D warnings`
- Use descriptive names and document public items
- Handle every error explicitly (no `unwrap` in request paths)

## 🧪 Testing

```bash
# Run all tests (integration tests use TEST_DATABASE_URL / REDIS_URL when set)
cargo test --workspace

# Run a single crate's tests
cargo test -p gt-users

# Lint
cargo clippy --workspace --all-targets -- -D warnings

# Coverage (requires cargo-llvm-cov; CI fails below 90% of lines)
cargo llvm-cov --workspace --html --fail-under-lines 90

# HTTP contract tests against the golden responses
cd contract-tests && python parity.py check --server-bin ../target/release/server --goldens goldens
```

## 📄 License

MIT License - see LICENSE file for details.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Write/update tests
5. Submit a pull request