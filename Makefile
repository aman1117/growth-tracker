SHELL := /bin/sh

.PHONY: help setup dev up down logs seed check test frontend-install frontend-lint frontend-format-check frontend-typecheck frontend-test frontend-coverage frontend-build backend-fmt backend-vet backend-test backend-coverage backend-build

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
	@echo "  backend-vet           Run backend vet"
	@echo "  backend-test          Run backend unit tests"
	@echo "  backend-coverage      Run backend unit tests with the coverage minimum"
	@echo "  backend-build         Build backend packages"

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
	cd backend && test -z "`gofmt -l .`"

backend-vet:
	cd backend && go vet ./...

backend-test:
	cd backend && go test ./...

backend-coverage:
	cd backend && sh scripts/test-coverage.sh

backend-build:
	cd backend && go build ./...

test: frontend-test backend-test

check: frontend-format-check frontend-lint frontend-typecheck frontend-test frontend-build backend-fmt backend-vet backend-test backend-build

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
