# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project aims to follow Semantic Versioning once tagged releases begin.

## [Unreleased]

### Added
- Open-source contributor documentation and GitHub community health files.
- Pull request and issue templates.
- CI workflow for frontend and backend validation.
- Dependabot configuration.
- Root editor configuration and repository ownership metadata.
- Native-app style navigation in the web app: system/hardware Back closes open modals, sheets,
  search and the story viewer; scroll position is restored on Back/Forward; per-screen document
  titles; tab re-tap scrolls to top (Home also jumps to today); shared `PageHeader` component.
- Post-login redirect to the originally requested page, and email login on the login form.

### Changed
- Reworked the root README for public contributor onboarding.
- Marked android and twa as inactive development surfaces.
- Settings (Profile tab) and own Analytics are tab roots: the bottom tab bar is always visible and
  they no longer show a Back button. Another user's profile/analytics show a Back button that
  falls back to a sensible screen when opened from a deep link.
- "Customize" in the tab bar now works from any screen (opens Home in edit mode).

### Fixed
- Login could fail for tokens containing base64url characters (`-`/`_`).
- Searching a user created duplicate history entries (Back appeared to do nothing).
- Stale responses could show another day's/user's data when switching quickly (dashboard,
  analytics, profiles).
- Route chunks failing to load after a deploy now recover automatically instead of crashing.
- A crashed screen now recovers when navigating to another tab.
- Expired sessions are cleared on load instead of flashing protected screens.
- Push deep links `/profile/badges` and `/notifications` no longer dead-end.
- Longest-streak lookup in Settings used the UTC date instead of the local date.

## [0.1.0] - 2026-03-28

### Added
- Baseline open-source release documentation.
