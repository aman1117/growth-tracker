# Local Development Setup

A complete Docker-based local development environment that mirrors production infrastructure.

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- Git

## Quick Start

```powershell
# Start all services and seed the database (one command)
docker-compose up -d && docker-compose --profile seed up seed

# Open the app
# Frontend: http://localhost:5173
# Backend:  http://localhost:8000
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Host Machine                              │
├─────────────────────────────────────────────────────────────────┤
│  localhost:5173 ──► Frontend (Vite + React)                     │
│  localhost:8000 ──► Backend (Go + Fiber)                        │
│  localhost:8025 ──► Mailpit Web UI                              │
│  localhost:5432 ──► PostgreSQL                                  │
│  localhost:6379 ──► Redis                                       │
│  localhost:10000 ─► Azurite (Blob Storage)                      │
└─────────────────────────────────────────────────────────────────┘
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

The docker-compose.yml contains all necessary environment variables for local development. If you need to customize:

1. Copy `.env.local.example` to `.env.local`
2. Modify values as needed
3. Restart services: `docker-compose up -d`

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
├── docker-compose.yml      # Main orchestration file
├── .env.local.example      # Environment template
├── backend/
│   ├── Dockerfile          # Production build
│   ├── Dockerfile.dev      # Development with Air
│   ├── air.toml            # Air hot-reload config
│   └── cmd/seed/main.go    # Database seeder
└── frontend/
    ├── Dockerfile.dev      # Development with Vite
    └── .dockerignore
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
