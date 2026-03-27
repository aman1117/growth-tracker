# Contributing

Thanks for considering a contribution to Growth Tracker.

This repository is maintained as a full-stack application with an actively developed frontend and backend. The android and twa directories are retained for reference, but they are not part of the active contribution surface unless a maintainer explicitly asks for work there.

## Before You Start

Read these files first:

- README.md
- LOCAL_DEV_README.md
- SECURITY.md
- CODE_OF_CONDUCT.md

## Contribution Scope

Active areas:

- frontend/
- backend/
- docker-compose.yml
- root contributor tooling and documentation

Inactive areas unless specifically requested by a maintainer:

- android/
- twa/

## Fork and Clone

1. Fork the repository on GitHub.
2. Clone your fork.
3. Add the upstream remote.

```bash
git clone https://github.com/aman1117/growth-tracker.git
cd growth-tracker
git remote add upstream https://github.com/aman1117/growth-tracker.git
```

## Branch Naming

Use focused branch names:

- feat/short-description
- fix/short-description
- docs/short-description
- chore/short-description
- refactor/short-description

Examples:

- feat/add-search-empty-state
- fix/activity-photo-upload-error
- docs/update-local-setup

## Local Setup

The fastest path is the Docker Compose workflow described in LOCAL_DEV_README.md.

Typical first-time setup:

```bash
docker compose up --build
```

Frontend-only commands:

```bash
cd frontend
npm ci
npm run lint
npm run format:check
npm run typecheck
npm run build
```

Backend-only commands:

```bash
cd backend
go fmt ./...
go vet ./...
go build ./...
```

## Coding Standards

### General

- Keep changes focused and small.
- Prefer clear names over clever abstractions.
- Preserve existing behavior unless the change explicitly targets behavior.
- Update documentation when behavior, setup, or interfaces change.
- Avoid unrelated formatting-only diffs.

### Frontend

- Follow the existing TypeScript, React, and Zustand patterns.
- Keep components small and feature-oriented.
- Run ESLint, Prettier, typecheck, and build locally before opening a PR.
- Do not introduce hardcoded environment-specific URLs or secrets.

### Backend

- Follow existing package boundaries in internal/ and pkg/.
- Keep handlers thin and business logic in services/repositories.
- Use structured logging and consistent error responses.
- Run go fmt, go vet, and go build locally before opening a PR.

## Commit Messages

Use Conventional Commit style where practical:

- feat: add weekly analytics empty state
- fix: prevent duplicate activity photo upload
- docs: clarify docker compose setup
- chore: update dependabot configuration

## Pull Requests

A good PR should:

- Explain the problem and the solution.
- Stay focused on one concern.
- Link the related issue when applicable.
- Include screenshots or screen recordings for UI changes.
- Mention any follow-up work or known limitations.

### PR Checklist

- I read the contribution and security guidelines.
- My change is scoped to the active development surface.
- I ran the relevant local validation commands.
- I updated docs if setup, behavior, or architecture changed.
- I did not add secrets, credentials, or machine-specific paths.
- I added screenshots for UI changes when relevant.

## Tests and Validation

There is currently no committed automated test suite in this repository.

For now, contributors should validate changes with:

- Frontend: lint, format check, typecheck, and production build.
- Backend: go fmt, go vet, and go build.
- Manual verification using the local Docker Compose workflow.

If you add a new testable unit or flow, prefer adding automated coverage alongside the feature rather than deferring it indefinitely.

## Documentation Expectations

Update documentation when you change:

- Local setup steps.
- Environment variables.
- Public APIs or routes.
- Developer workflow.
- User-visible behavior.

## Review Expectations

Maintainers review for:

- Correctness.
- Clarity and maintainability.
- Backward compatibility.
- Security and secrets hygiene.
- Documentation completeness.

Large or risky changes may be asked to split into smaller PRs.

## Filing Issues

Use the issue templates and include enough context to reproduce the problem. If you are proposing a large change, start with an issue before implementation so the direction can be discussed first.

## Breaking Changes

Open an issue before proposing a breaking change. Include:

- What is changing.
- Why it is necessary.
- Migration impact.
- Alternatives considered.

## Good First Contributions

Good first contributions usually include:

- Documentation clarifications.
- Small UI polish fixes.
- Error state improvements.
- Accessibility improvements.
- Small backend validation or response consistency fixes.

## Security

Never file sensitive security issues in public. Follow SECURITY.md.
