# Growth Tracker Backend

A professional Go backend service for the Growth Tracker application, featuring clean architecture, dependency injection, and enterprise-grade code organization.

## 🏗️ Architecture

The application follows a clean architecture pattern with clear separation of concerns:

```
backend/
├── cmd/
│   └── server/
│       └── main.go           # Application entry point
├── internal/                  # Private application code
│   ├── config/               # Configuration management
│   ├── constants/            # Application-wide constants
│   ├── container/            # Dependency injection
│   ├── database/             # Database connection & migrations
│   ├── dto/                  # Data Transfer Objects
│   │   ├── requests.go       # Request payloads
│   │   └── responses.go      # Response payloads
│   ├── handlers/             # HTTP handlers (controllers)
│   │   ├── activity.go
│   │   ├── analytics.go
│   │   ├── auth.go
│   │   ├── blob.go
│   │   ├── password_reset.go
│   │   ├── profile.go
│   │   ├── streak.go
│   │   ├── tile_config.go
│   │   └── token.go
│   ├── logger/               # Structured logging with Axiom
│   ├── middleware/           # HTTP middleware
│   ├── repository/           # Data access layer
│   ├── response/             # Standardized API responses
│   ├── routes/               # Route definitions
│   ├── services/             # Business logic layer
│   │   ├── analytics.go
│   │   ├── email.go
│   │   └── services.go
│   └── validator/            # Input validation
├── pkg/                      # Public/reusable packages
│   ├── models/               # Domain models (GORM entities)
│   └── redis/                # Redis client wrapper
├── migrations/               # SQL migration files
├── go.mod
├── go.sum
├── .env.example              # Environment template
└── Dockerfile
```

## 🔄 Request Flow

```
HTTP Request
    ↓
Middleware (Logging, CORS, Auth)
    ↓
Router → Handler
    ↓
Handler (HTTP concerns, validation)
    ↓
Service (Business logic)
    ↓
Repository (Data access)
    ↓
Database
```

## 🚀 Getting Started

### Prerequisites

- Go 1.23+
- PostgreSQL (or Neon serverless)
- Redis (optional, for password reset)
- Azure Storage (optional, for profile pictures)

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

4. Run the server:
```bash
go run ./cmd/server
```

### Building

```bash
# Build binary
go build -o server ./cmd/server

# Run binary
./server
```

## 📦 Package Responsibilities

### `cmd/server`
Application entry point. Initializes all dependencies and starts the server.

### `internal/config`
- Environment variable loading
- Configuration structs with sensible defaults
- Validation of required settings

### `internal/constants`
- All magic strings and numbers
- Error codes and messages
- Date formats and validation limits

### `internal/container`
- Dependency injection container
- Wires all components together
- Single source of truth for dependencies

### `internal/database`
- Database connection management
- Auto-migrations
- Transaction helpers

### `internal/dto`
- Request/Response DTOs
- Decoupled from domain models
- Input/output contracts

### `internal/handlers`
- HTTP request handling
- Input validation
- Response formatting
- No business logic

### `internal/logger`
- Structured logging with Zap
- Axiom integration for cloud logging
- Context-aware loggers with trace IDs

### `internal/middleware`
- Request logging with trace IDs
- JWT authentication
- User context injection

### `internal/repository`
- Data access layer
- GORM query abstractions
- No business logic

### `internal/response`
- Standardized API responses
- Helper functions for common responses
- Consistent error formatting

### `internal/routes`
- Route definitions
- Endpoint grouping
- Middleware application

### `internal/services`
- Business logic
- Domain rules enforcement
- Cross-cutting concerns

### `internal/validator`
- Input validation
- Business rule validation
- Error aggregation

### `pkg/models`
- GORM entity definitions
- Domain model constants
- Database schema

### `pkg/redis`
- Redis client wrapper
- Password reset tokens
- Secure token handling

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
| GET | `/api/profile/:username` | Get user by username |

### Activities
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/activities` | Get activities (with filters) |
| PUT | `/api/activities` | Update activities |

### Streaks
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/streaks` | Get user streaks |
| GET | `/api/streaks/user/:username` | Get user streaks by username |

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

## 🔧 Configuration

All configuration is done via environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 8080) |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `JWT_SECRET` | Yes | JWT signing secret |
| `JWT_EXPIRY_HOURS` | No | Token expiry (default: 168) |
| `REDIS_URL` | No | Redis connection string |
| `AZURE_STORAGE_CONNECTION_STRING` | No | Azure Blob storage |
| `RESEND_API_KEY` | No | Resend API key for emails |
| `AXIOM_TOKEN` | No | Axiom logging token |

See `.env.example` for full configuration options.

## 🏛️ Design Principles

### Clean Architecture
- Dependencies point inward
- Business logic is framework-agnostic
- External concerns are abstracted

### Dependency Injection
- All dependencies injected via constructor
- No global state (except logger for convenience)
- Easy to test and mock

### Single Responsibility
- Each package has one job
- Handlers don't do business logic
- Services don't do HTTP

### Explicit over Implicit
- No magic configuration
- All constants defined explicitly
- Clear error messages

### Graceful Degradation
- Optional features fail gracefully
- Missing Redis disables password reset
- Missing email service disables notifications

## 📝 Code Style

- Follow Go conventions and idioms
- Use descriptive variable names
- Document all exported types and functions
- Handle all errors explicitly

## 🧪 Testing

```bash
# Run all tests
go test ./...

# Run with coverage
go test -cover ./...

# Run specific package tests
go test ./internal/services/...
```

## 📄 License

MIT License - see LICENSE file for details.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Write/update tests
5. Submit a pull request
