# Growth Tracker

A personal growth tracking application backend built with Go, featuring user authentication and activity tracking capabilities.

## Overview

This project is a RESTful API backend for tracking personal growth activities. The backend provides secure user authentication using JWT tokens and is designed to support activity tracking features where users can log and monitor their daily activities.

## Tech Stack

- **Language**: Go 1.22.5
- **Web Framework**: [Fiber v2](https://gofiber.io/) - Fast HTTP web framework
- **Database**: PostgreSQL with [GORM](https://gorm.io/) ORM
- **Authentication**: JWT (JSON Web Tokens) using `golang-jwt/jwt/v5`
- **Password Hashing**: bcrypt via `golang.org/x/crypto`
- **Environment Management**: `joho/godotenv`

## Project Structure

```
backend/
├── main/
│   └── main.go          # Application entry point, server setup, and route definitions
├── models/
│   └── user.go          # User data model with GORM tags
├── services/
│   ├── auth.go          # Authentication handlers (register, login, protected routes)
│   └── db.go            # Database service functions (user creation, retrieval)
├── utils/
│   └── utils.go         # Utility functions (DB connection, JWT generation/parsing, env vars)
├── go.mod               # Go module dependencies
└── go.sum               # Dependency checksums
```

## Features

### Authentication System
- **User Registration**: Create new user accounts with email, username, and password
  - Email and username uniqueness validation
  - Password minimum length requirement (8 characters)
  - Secure password hashing with bcrypt
- **User Login**: Authenticate users with email or username
  - Returns JWT access token with expiration
  - Bearer token authentication
- **Protected Routes**: JWT middleware for securing endpoints
  - Token validation and user context injection

### Database
- PostgreSQL database connection with SSL
- Automatic database migrations using GORM
- User model with timestamps (created_at, updated_at)

## API Endpoints

| Method | Endpoint      | Description                    | Auth Required |
|--------|---------------|--------------------------------|---------------|
| GET    | `/`           | Health check endpoint          | No            |
| POST   | `/register`   | Register a new user            | No            |
| POST   | `/login`      | Login and get access token     | No            |
| GET    | `/protected`  | Example protected endpoint     | Yes           |

### Request/Response Examples

**Register** (`POST /register`)
```json
{
  "email": "user@example.com",
  "username": "johndoe",
  "password": "securepass123"
}
```

**Login** (`POST /login`)
```json
{
  "identifier": "user@example.com",  // or username
  "password": "securepass123"
}
```

Response:
```json
{
  "success": true,
  "access_token": "eyJhbGciOiJIUzI1NiIs...",
  "token_type": "Bearer",
  "expires_at": "2024-01-01T12:00:00Z",
  "expires_in": 3600
}
```

## Setup Instructions

1. **Prerequisites**
   - Go 1.22.5 or higher
   - PostgreSQL database
   - Environment variables configured (see below)

2. **Install Dependencies**
   ```bash
   cd backend
   go mod download
   ```

3. **Environment Variables**
   Create a `.env` file in the `backend/` directory with:
   ```env
   DB_USERNAME=your_db_username
   DB_PASSWORD=your_db_password
   DB_HOST=your_db_host
   DB_PORT=5432
   DB_NAME=your_db_name
   JWT_SECRET_KEY=your_secret_key_here
   TTL_ACCESS_TOKEN=60  # Token expiration in minutes
   PORT=8000            # Server port (optional, defaults to 8000)
   ```

4. **Run the Application**
   ```bash
   cd backend/main
   go run main.go
   ```
   
   The server will start at `http://localhost:8000` (or your configured PORT).

## Database Schema

### Users Table
- `id` (uint, primary key)
- `email` (string, unique, not null)
- `username` (string, unique, not null)
- `password_hash` (string, not null)
- `created_at` (timestamp, auto-created)
- `updated_at` (timestamp, auto-updated)

## TODOs

- [x] Design authentication database schema for the `users` table.
- [x] Create an `activity` table to store activities for each day, with:
  - Columns for each activity detail (name, type, duration, etc.)
  - A foreign key `user_id` referencing the `users` table
- [x] Add Add, Update, Get Logic for `activity` table
- [ ] One can see others activities also.
- [ ] Enforce 24hr total rule for activities
- [ ] CronJob to set activity hours to 0 at 12 AM for all users.
- [ ] Make code structure as done by professional dev.
