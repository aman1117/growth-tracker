SHELL := /bin/sh

# Postgres (superuser) and Redis used by the contract tests; defaults match docker-compose.yml.
# The harness creates its own gtparity_* databases and FLUSHALLs Redis before every scenario.
CONTRACT_PG_ARGS ?= --pg-host 127.0.0.1 --pg-port 5432 --pg-user localdev --pg-password localdevpassword
CONTRACT_REDIS_URL ?= redis://127.0.0.1:6379

.PHONY: help setup dev up down logs seed check test frontend-install frontend-lint frontend-format-check frontend-typecheck frontend-test frontend-coverage frontend-build backend-fmt backend-lint backend-test backend-coverage backend-build backend-contract

help:
	@echo "Available targets:"
	@echo "  setup                 Install frontend dependencies"
	@echo "  dev                   Start local stack with Docker Compose"
	@echo "  up                    Start local stack in detached mode"
	@echo "  down                  Stop local stack"
	@echo "  logs                  Tail backend and frontend logs"
	@echo "  seed                  Run seed profile"
	@echo "  check                 Run frontend and backend validation, including tests"
	@echo "  test                  Run frontend and backend unit tests"
	@echo "  frontend-install      Install frontend dependencies"
	@echo "  frontend-lint         Run frontend lint"
	@echo "  frontend-format-check Run frontend format check"
	@echo "  frontend-typecheck    Run frontend typecheck"
	@echo "  frontend-test         Run frontend unit tests"
	@echo "  frontend-coverage     Run frontend unit tests with coverage thresholds"
	@echo "  frontend-build        Run frontend production build"
	@echo "  backend-fmt           Check backend formatting"
	@echo "  backend-lint          Run backend clippy lints"
	@echo "  backend-test          Run backend unit tests"
	@echo "  backend-coverage      Run backend tests with the 90% line coverage minimum (needs cargo-llvm-cov)"
	@echo "  backend-build         Build backend binaries"
	@echo "  backend-contract      Run the API contract tests against a release build"

setup: frontend-install

frontend-install:
	cd frontend && npm ci

frontend-lint:
	cd frontend && npm run lint

frontend-format-check:
	cd frontend && npm run format:check

frontend-typecheck:
	cd frontend && npm run typecheck

frontend-test:
	cd frontend && npm run test

frontend-coverage:
	cd frontend && npm run test:coverage

frontend-build:
	cd frontend && npm run build

backend-fmt:
	cd backend && cargo fmt --all --check

backend-lint:
	cd backend && cargo clippy --workspace --all-targets -- -D warnings

backend-test:
	cd backend && cargo test --workspace

backend-coverage:
	cd backend && cargo llvm-cov --workspace --html --fail-under-lines 90

backend-build:
	cd backend && cargo build --workspace --bins

backend-contract:
	cd backend && cargo build --release --bin server && python contract-tests/parity.py check --server-bin target/release/server --goldens contract-tests/goldens --keep-going $(CONTRACT_PG_ARGS) --redis-url $(CONTRACT_REDIS_URL)

test: frontend-test backend-test

check: frontend-format-check frontend-lint frontend-typecheck frontend-test frontend-build backend-fmt backend-lint backend-test backend-build

dev:
	docker compose up --build

up:
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f backend frontend

seed:
	docker compose --profile seed up seed
