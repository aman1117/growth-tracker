# Local Development Setup

A complete Docker-based local development environment that mirrors production infrastructure with full debugging support.

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- [Visual Studio Code](https://code.visualstudio.com/) with the [Go extension](https://marketplace.visualstudio.com/items?itemName=golang.Go)
- Git

## Quick Start

### Windows (PowerShell)

```powershell
# Setup environment (optional - only needed for push notifications)
Copy-Item .env.example .env
# Edit .env if you need push notification testing

# Start all services and seed the database
docker-compose up -d; docker-compose --profile seed up seed
```

### macOS / Linux (Bash)

```bash
# Setup environment (optional - only needed for push notifications)
cp .env.example .env
# Edit .env if you need push notification testing

# Start all services and seed the database
docker-compose up -d && docker-compose --profile seed up seed
```

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
│  localhost:8000  ──► Backend (Go + Fiber)                                   │
│  localhost:8025  ──► Mailpit Web UI                                         │
│  localhost:5432  ──► PostgreSQL                                             │
│  localhost:6379  ──► Redis                                                  │
│  localhost:10000 ──► Azurite (Blob Storage)                                 │
│                                                                             │
│  Debug Ports:                                                               │
│  localhost:2345  ──► Backend Delve Debugger                                 │
│  localhost:2346  ──► Push Worker Delve Debugger                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Services

| Service | URL | Description |
|---------|-----|-------------|
| **Frontend** | http://localhost:5173 | React app with Vite hot-reload |
| **Backend** | http://localhost:8000 | Go API with Air hot-reload |
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
docker-compose up -d

# Start with logs visible
docker-compose up

# Stop all services (keeps data)
docker-compose down

# Stop and delete all data (fresh start)
docker-compose down -v
```

### View Logs

```powershell
# All services
docker-compose logs -f

# Backend only (see hot-reload)
docker-compose logs -f backend

# Frontend only
docker-compose logs -f frontend

# Multiple services
docker-compose logs -f backend frontend
```

### Rebuild After Changes

```powershell
# Rebuild a specific service
docker-compose up -d --build backend

# Rebuild all services
docker-compose up -d --build
```

### Database Operations

```powershell
# Seed the database (only needed once, or after reset)
docker-compose --profile seed up seed

# Connect to PostgreSQL directly
docker exec -it growth-tracker-db psql -U localdev -d growth_tracker_dev

# Reset database (deletes all data)
docker-compose down -v
docker-compose up -d
docker-compose --profile seed up seed
```

### Access Container Shell

```powershell
# Backend container
docker exec -it growth-tracker-backend sh

# Frontend container
docker exec -it growth-tracker-frontend sh
```

## Hot Reload

Both backend and frontend support hot-reload:

- **Backend (Go)**: Uses [Air](https://github.com/air-verse/air). Edit any `.go` file and it auto-rebuilds.
- **Frontend (React)**: Uses Vite. Edit any file in `frontend/src/` and it auto-refreshes.

## Debugging Go Services

The development environment includes full debugging support using [Delve](https://github.com/go-delve/delve), the Go debugger.

### Debug Configuration

VS Code launch configurations are pre-configured in `.vscode/launch.json`:

| Configuration | Port | Description |
|--------------|------|-------------|
| **Backend (Docker)** | 2345 | Debug the main API server |
| **Push Worker (Docker)** | 2346 | Debug the push notification worker |
| **All Services** | - | Attach to both services simultaneously |

### How to Debug

1. **Start the containers** (if not already running):
   ```powershell
   docker-compose up -d
   ```

2. **Set breakpoints** in VS Code by clicking in the gutter next to line numbers in any Go file under `backend/`

3. **Attach the debugger**:
   - Press `F5` or go to **Run and Debug** panel (Ctrl+Shift+D)
   - Select **Backend (Docker)** or **Push Worker (Docker)**
   - Click the green play button

4. **Trigger your breakpoint** by making a request to the API:
   ```powershell
   curl http://localhost:8000/
   ```

5. **Debug** using VS Code's debug controls:
   - **F10** - Step Over
   - **F11** - Step Into
   - **Shift+F11** - Step Out
   - **F5** - Continue
   - Inspect variables in the **Variables** panel
   - Evaluate expressions in the **Debug Console**

### Troubleshooting Debugging

**Hollow breakpoints (not binding):**
- Ensure containers are running: `docker-compose ps`
- Rebuild containers: `docker-compose up -d --build backend`
- Check Delve is listening: `docker logs growth-tracker-backend`

**"Failed to attach" error:**
- The app may have crashed. Check logs: `docker-compose logs backend`
- Restart the container: `docker-compose restart backend`

**Breakpoint not hit:**
- Verify the code path is being executed
- Check substitutePath mapping in `.vscode/launch.json`

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
docker-compose logs <service-name>

# Rebuild from scratch
docker-compose down -v
docker-compose build --no-cache
docker-compose up -d
```

### Backend Not Connecting to Database

Wait a few seconds after `docker-compose up` - the backend waits for PostgreSQL to be healthy before starting.

```powershell
# Check health status
docker-compose ps
```

### Changes Not Reflecting

For backend Go changes:
```powershell
# Check Air is detecting changes
docker-compose logs -f backend
```

For frontend changes, ensure you're editing files in `frontend/src/` (those are volume-mounted).

### Reset Everything

```powershell
# Nuclear option - removes all containers, volumes, and images
docker-compose down -v --rmi local
docker-compose up -d --build
docker-compose --profile seed up seed
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
│   ├── Dockerfile              # Production build
│   ├── Dockerfile.dev          # Development with Delve debugger
│   ├── Dockerfile.pushworker   # Production push worker
│   ├── Dockerfile.pushworker.dev # Development push worker with debugger
│   ├── air.toml                # Air hot-reload config
│   ├── cmd/
│   │   ├── server/             # Main API entry point
│   │   ├── pushworker/         # Push notification worker
│   │   └── seed/               # Database seeder
│   └── internal/               # Application code
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
| **Backend** | Air hot-reload | Azure Container Apps |

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
