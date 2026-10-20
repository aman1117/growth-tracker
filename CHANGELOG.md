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
- "Aurora" visual identity across the web app, in light and dark mode: token-driven palette (violet
  primary, green→teal→violet gradients), glass surfaces over an aurora background, Bricolage
  Grotesque + Plus Jakarta Sans type, tactile buttons, and a refreshed favicon, offline page and
  PWA store screenshots.
- Shared UI building blocks: `ConfirmDialog`, `Notice`, `BrandLogo`, `PasswordInput`, a Settings
  `ThemePicker`, `useEscapeKey` (only the top-most overlay handles Escape) and `useBodyScrollLock`
  (one reference-counted scroll lock shared by all overlays).
- `npm run brand:assets` regenerates every logo asset (favicons, PWA/Apple/maskable icons, push
  badge, Android TWA icons and splash, help-center icon, README lockups) from the same geometry the
  in-app `BrandLogo` draws.

### Changed
- New original logo: a "leaf check" mark (two leaves forming a check — growth you can track) with a
  Bricolage Grotesque wordmark, in solid brand colours with no gradients. It replaces the script
  wordmark everywhere: app header, sign-in, favicon, installed-app icons, Android TWA, help center
  and README.
- Reworked the root README for public contributor onboarding.
- Marked android and twa as inactive development surfaces.
- Settings (Profile tab) and own Analytics are tab roots: the bottom tab bar is always visible and
  they no longer show a Back button. Another user's profile/analytics show a Back button that
  falls back to a sensible screen when opened from a deep link.
- "Customize" in the tab bar now works from any screen (opens Home in edit mode).
- Every screen was restyled on the shared components: sign-in flows, Home (day card, tiles, edit
  mode, tile dialogs), stories, notifications, search, profiles, Settings (grouped sections), push
  preferences and follower lists.
- Analytics is now titled "Insights" (route unchanged) and its weekly chart scales to the data.
- Removing a follower asks for confirmation first.
- Bio and username limits in Settings now match the server (150 bytes, 20 characters).

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
- Insights: overlapping weekday labels, best-streak dates shown a day early west of UTC, an
  unreadable chart when filtered, a filter menu unreachable by keyboard, and no state for unknown
  users.
- Settings hid server reasons (username taken, wrong current password) behind generic errors;
  privacy and push failures were silent; switches lost keyboard focus while saving.
- PWA manifest screenshots were declared as 1080×1920 but were smaller, so install prompts
  ignored them.
- App icons were a black wordmark on a transparent background, which disappeared on dark home
  screens and on iOS; Android push notifications used the full-colour icon as the status-bar
  badge instead of a monochrome silhouette.

## [0.1.0] - 2026-03-28

### Added
- Baseline open-source release documentation.
