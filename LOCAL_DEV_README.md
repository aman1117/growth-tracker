# Local Development Setup

A complete Docker-based local development environment that mirrors production infrastructure with full debugging support.

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- [Visual Studio Code](https://code.visualstudio.com/) with the [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer) and [CodeLLDB](https://marketplace.visualstudio.com/items?itemName=vadimcn.vscode-lldb) extensions
- [Rust](https://rustup.rs/) installed (optional - for running tests and debugging on the host)
- Git

> **First start:** the backend containers compile the Rust workspace on first start, which takes a few minutes. Build artifacts are cached in Docker volumes, so later starts and rebuilds are incremental.

## Quick Start

### Windows (PowerShell)

```powershell
# Setup environment (optional - only needed for push notifications)
Copy-Item .env.example .env
# Edit .env if you need push notification testing

# Start all services and seed the database
docker compose up -d; docker compose --profile seed up seed
```

### macOS / Linux (Bash)

```bash
# Setup environment (optional - only needed for push notifications)
cp .env.example .env
# Edit .env if you need push notification testing

# Start all services and seed the database
docker compose up -d && docker compose --profile seed up seed
```

The backend creates and migrates the complete database schema (tables, extensions and indexes) automatically on startup, so no manual migration step is needed.

### Access Points

| Service | URL |
|---------|-----|
| **Frontend** | http://localhost:5173 |
| **Backend API** | http://localhost:8000 |
| **Email UI** | http://localhost:8025 |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            Host Machine                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│  localhost:5173  ──► Frontend (Vite + React)                                │
│  localhost:8000  ──► Backend (Rust + axum)                                  │
│  localhost:8025  ──► Mailpit Web UI                                         │
│  localhost:5432  ──► PostgreSQL                                             │
│  localhost:6379  ──► Redis                                                  │
│  localhost:10000 ──► Azurite (Blob Storage)                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Services

| Service | URL | Description |
|---------|-----|-------------|
| **Frontend** | http://localhost:5173 | React app with Vite hot-reload |
| **Backend** | http://localhost:8000 | Rust API with cargo-watch hot-reload |
| **Mailpit** | http://localhost:8025 | Email testing UI (view sent emails) |
| **PostgreSQL** | localhost:5432 | Database |
| **Redis** | localhost:6379 | Cache/sessions |
| **Azurite** | localhost:10000 | Azure Blob Storage emulator |

## Test Users

After seeding, these accounts are available:

| Email | Password | Notes |
|-------|----------|-------|
| alice@local.dev | password123 | 15-day current streak |
| bob@local.dev | password123 | 45-day longest streak (broken 5 days ago) |
| charlie@local.dev | password123 | 7-day current streak, private account |

## Common Commands

### Start/Stop Services

```powershell
# Start all services (detached)
docker compose up -d

# Start with logs visible
docker compose up

# Stop all services (keeps data)
docker compose down

# Stop and delete all data (fresh start)
docker compose down -v
```

### View Logs

```powershell
# All services
docker compose logs -f

# Backend only (see hot-reload)
docker compose logs -f backend

# Frontend only
docker compose logs -f frontend

# Multiple services
docker compose logs -f backend frontend
```

### Rebuild After Changes

```powershell
# Rebuild a specific service
docker compose up -d --build backend

# Rebuild all services
docker compose up -d --build
```

### Database Operations

```powershell
# Seed the database (only needed once, or after reset)
docker compose --profile seed up seed

# Connect to PostgreSQL directly
docker exec -it growth-tracker-db psql -U localdev -d growth_tracker_dev

# Reset database (deletes all data)
docker compose down -v
docker compose up -d
docker compose --profile seed up seed
```

### Run Migrations

No manual migrations are needed. On startup the backend applies the complete schema (all tables plus the `pg_trgm` extension, autocomplete indexes, `activity_photos`, `story_views`, `story_likes`, `recent_searches` and `users.profile_pic_thumb`) as a single atomic batch guarded by an advisory lock (safe with several replicas). Every statement is idempotent, so restarting is always safe and existing databases created by the previous Go backend are upgraded in place without data changes.

#### Backfill Badges (optional)

Only needed if you have existing users without badges:

```powershell
docker exec -it growth-tracker-backend cargo run --bin seed_badges
```

### Access Container Shell

```powershell
# Backend container
docker exec -it growth-tracker-backend sh

# Frontend container
docker exec -it growth-tracker-frontend sh
```

### Run Unit Tests

Unit tests run on the host and don't need the stack, but the backend integration tests need a
PostgreSQL and Redis server, and can reuse the Compose ones. Each test creates and drops its own
temporary database, so `growth_tracker_dev` is never touched. Without `TEST_DATABASE_URL` the
database-backed tests are skipped.

```powershell
# Frontend
cd frontend; npm test

# Backend, against the Compose database and Redis
cd backend; $env:TEST_DATABASE_URL = 'postgres://localdev:localdevpassword@localhost:5432/postgres?sslmode=disable'; $env:REDIS_URL = 'redis://localhost:6379'; cargo test --workspace
```

### Run Contract Tests

The golden HTTP contract suite starts the release server against throwaway databases and
compares every response with the recorded goldens (see `backend/contract-tests/README.md`):

```powershell
make backend-contract
```

## Hot Reload

Both backend and frontend support hot-reload:

- **Backend (Rust)**: Uses [cargo-watch](https://github.com/watchexec/cargo-watch). Edit any file under `backend/crates/` and the server is rebuilt (incrementally) and restarted.
- **Frontend (React)**: Uses Vite. Edit any file in `frontend/src/` and it auto-refreshes.

## Debugging the Backend

Debugging uses [CodeLLDB](https://marketplace.visualstudio.com/items?itemName=vadimcn.vscode-lldb) with the server running natively on the host, against the Compose databases.

### Debug Configuration

VS Code launch configurations are pre-configured in `.vscode/launch.json`:

| Configuration | Description |
|--------------|-------------|
| **Backend (local)** | Build and debug the main API server (`--bin server`) |
| **Push Worker (local)** | Build and debug the push notification worker (`--bin pushworker`) |
| **All Services** | Debug both at once |

Both read their environment from `backend/.env` (copy `backend/.env.example`) and run from `backend/`.

### How to Debug

1. **Start the infrastructure and free port 8000** (the API container would otherwise own it):
   ```powershell
   docker compose up -d
   docker compose stop backend pushworker
   ```

2. **Point `backend/.env` at the Compose services** (`DB_HOST=localhost`, `DB_PORT=5432`, `DB_NAME=growth_tracker_dev`, `DB_USERNAME=localdev`, `DB_PASSWORD=localdevpassword`, `DB_SSLMODE=disable`, `REDIS_URL=redis://localhost:6379`, `PORT=8000`, `ENV=development`).

3. **Set breakpoints** in VS Code by clicking in the gutter next to line numbers in any Rust file under `backend/crates/`

4. **Start the debugger**:
   - Press `F5` or go to **Run and Debug** panel (Ctrl+Shift+D)
   - Select **Backend (local)** or **Push Worker (local)**
   - Click the green play button (the binary is built in debug mode first)

5. **Trigger your breakpoint** by making a request to the API:
   ```powershell
   curl http://localhost:8000/
   ```

6. **Debug** using VS Code's debug controls:
   - **F10** - Step Over
   - **F11** - Step Into
   - **Shift+F11** - Step Out
   - **F5** - Continue
   - Inspect variables in the **Variables** panel
   - Evaluate expressions in the **Debug Console**

When you are done, run `docker compose start backend pushworker` to go back to the containers.

### Troubleshooting Debugging

**Hollow breakpoints (not binding):**
- Make sure you launched a debug build (the launch configurations do this) and not a `--release` binary
- Check the **Debug Console** for build errors

**"Address already in use" on start:**
- The `backend` container is still running: `docker compose stop backend`

**Breakpoint not hit:**
- Verify the code path is being executed
- Async handlers run on Tokio worker threads; use the **Call Stack** panel to switch threads

## Email Testing

All emails sent by the app are captured by **Mailpit** instead of being sent to real addresses.

1. Trigger an email (e.g., password reset)
2. Open http://localhost:8025
3. View the email in the Mailpit UI

## Profile Pictures (Blob Storage)

Profile picture uploads work locally using **Azurite** (Azure Storage emulator):

- Uploads go to: `http://localhost:10000/devstoreaccount1/profile-pictures/`
- The container is auto-created on startup

## Environment Variables

The local development setup uses a `.env` file for secrets that should not be committed to git.

### Required Setup

1. Copy the example file:
   ```powershell
   cp .env.example .env
   ```

2. Edit `.env` and add your secrets:
   ```env
   # Azure Service Bus (for push notifications)
   AZURE_SERVICEBUS_CONNECTION_STRING=Endpoint=sb://...

   # VAPID Keys (for Web Push)
   VAPID_PUBLIC_KEY=your_public_key
   VAPID_PRIVATE_KEY=your_private_key
   ```

### Getting Azure Service Bus Connection String

```powershell
az servicebus namespace authorization-rule keys list `
  --resource-group growth-tracker `
  --namespace-name growthtrackerservicebus `
  --name RootManageSharedAccessKey `
  --query primaryConnectionString -o tsv
```

### Generating VAPID Keys

```powershell
npx web-push generate-vapid-keys
```

> **Note:** The `.env` file is gitignored. Never commit secrets to the repository.

## Troubleshooting

### Port Already in Use

```powershell
# Find what's using the port (e.g., 5432)
netstat -ano | findstr :5432

# Kill the process (replace PID)
taskkill /PID <PID> /F
```

### Container Won't Start

```powershell
# Check container logs
docker compose logs <service-name>

# Rebuild from scratch
docker compose down -v
docker compose build --no-cache
docker compose up -d
```

### Backend Not Connecting to Database

Wait a few seconds after `docker compose up` - the backend waits for PostgreSQL to be healthy before starting.

```powershell
# Check health status
docker compose ps
```

### Changes Not Reflecting

For backend Rust changes:
```powershell
# Check cargo-watch is rebuilding (compile errors show up here too)
docker compose logs -f backend
```

For frontend changes, ensure you're editing files in `frontend/src/` (those are volume-mounted).

### Reset Everything

```powershell
# Nuclear option - removes all containers, volumes, and images
docker compose down -v --rmi local
docker compose up -d --build
docker compose --profile seed up seed
```

## Project Structure

```
growth-tracker/
├── .env                        # Local secrets (gitignored)
├── .env.example                # Environment template
├── .vscode/
│   └── launch.json             # Debug configurations
├── docker-compose.yml          # Main orchestration file
├── LOCAL_DEV_README.md         # This file
├── backend/
│   ├── Dockerfile              # Production build (static musl binary)
│   ├── Dockerfile.dev          # Development with cargo-watch hot reload
│   ├── Dockerfile.pushworker   # Production push worker
│   ├── Dockerfile.pushworker.dev # Development push worker with cargo-watch
│   ├── Cargo.toml              # Rust workspace
│   ├── crates/
│   │   ├── gt-server/          # Main API entry point (`server` binary)
│   │   ├── gt-notify/          # Notifications + push worker (`pushworker` binary)
│   │   ├── gt-jobs/            # Cron jobs + database seeder (`seed` binary)
│   │   └── gt-*/               # Shared core and feature crates
│   └── contract-tests/         # Golden HTTP contract suite
└── frontend/
    ├── Dockerfile.dev          # Development with Vite
    └── src/                    # React application
```

## Local vs Production Parity

| Feature | Local (Docker) | Production |
|---------|----------------|------------|
| **Database** | PostgreSQL 16 (container) | Azure PostgreSQL |
| **Blob Storage** | Azurite (emulator) | Azure Blob Storage |
| **Email** | Mailpit (SMTP) | Resend API |
| **Redis** | Redis 7 (container) | Azure Redis |
| **Frontend** | Vite dev server | Vercel |
| **Backend** | cargo-watch hot-reload | Azure Container Apps |

The code automatically detects the environment (`ENV=development` vs `ENV=production`) and uses the appropriate service:
- **Blob URLs**: `http://localhost:10000/...` (local) vs `https://*.blob.core.windows.net/...` (prod)
- **Email**: SMTP to Mailpit (local) vs Resend API (prod)

## Security Notes

⚠️ **This setup is for LOCAL DEVELOPMENT ONLY**

- All credentials in docker-compose.yml are dummy values
- Never use these credentials in production
- The `.env.local` file is gitignored
- Production env files (`msft.env`, `neon.env`) are never used by docker-compose
- The seeder has multiple safety checks to prevent running on production databases
