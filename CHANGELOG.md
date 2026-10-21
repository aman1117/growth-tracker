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
- Automated unit test suites for both apps. The frontend uses Vitest, React Testing Library and
  jsdom; the backend uses Go's `testing` package with testify, a real PostgreSQL 16 (embedded, or
  `TEST_DATABASE_URL`), in-memory Redis, and local fakes for Azure Blob Storage, Resend and Web
  Push. Shared helpers live in `frontend/src/test` and `backend/internal/testutil`.
- CI runs both suites with 90% coverage gates and publishes the coverage reports. New commands:
  `npm test`, `npm run test:coverage`, `make test`, `make frontend-coverage` and
  `make backend-coverage`; `make check` now runs the tests too.
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
- Bio and username limits in Settings now match the server (150 and 20 characters).
- Text limits are counted in characters (Unicode code points) by both the server and the app:
  bio 150, custom tile names 20, notes 500, comments 200, usernames 3–20 and passwords at least
  8. An emoji or accented letter counts once (bios and tile names used to count bytes).
- `DB_USERNAME`, `DB_PASSWORD` and `DB_NAME` are now escaped when the backend builds its database
  URL, so values containing `@ : / # ? %` work as typed. **Migration:** if you percent-encoded
  them by hand, use the raw values instead (`DATABASE_URL` is used unchanged, as before).
- A missing photo now returns the error code `PHOTO_NOT_FOUND` (was `NOTIFICATION_NOT_FOUND`),
  and replying to a missing parent comment returns 404 (was 400).
- `GET /api/tile-config` and `POST /api/tile-config/user` return 500 (`FETCH_FAILED`) when the
  database fails, instead of `{"success": true, "data": null}`, which means "no layout saved".

### Fixed
- Login could fail for tokens containing base64url characters (`-`/`_`).
- Searching a user created duplicate history entries (Back appeared to do nothing).
- Stale responses could show another day's/user's data when switching quickly (dashboard,
  analytics, profiles).
- Route chunks failing to load after a deploy now recover automatically instead of crashing.
- A crashed screen now recovers when navigating to another tab.
- Expired sessions are cleared on load instead of flashing protected screens.
- Push deep links `/profile/badges` and `/notifications` no longer dead-end.
- "Followed by" avatars on other users' profiles were cropped off-center on phones (the photo sat
  2px down and to the right inside its ring) and showed a doubled ring on larger screens.
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
- Live notifications: idle connections were dropped and reopened every minute (the server
  ignored the browser's keep-alive replies); a reconnect could leave two connections and show
  duplicate notifications; the app now reconnects as soon as the network returns, shows
  "disconnected" instead of "reconnecting" while offline, and stays stopped after giving up or
  disconnecting.
- Notifications: clicking the bell while the panel is open closes it instead of reopening it;
  items open with Space as well as Enter; Enter on an item's delete or username button no longer
  also opens it.
- Tapping the dimmed backdrop of the calendar, comment sheet or notification panel closed it
  twice.
- Stories: double-tap to like never worked; a closed viewer recorded views and loaded like
  status, and opening one loaded the like status twice; photo dates showed the previous day west
  of UTC; some failed uploads (such as "Daily limit reached") were shown as successes.
- Follower and following lists showed Accept/Decline for incoming requests (they belong in
  Follow requests); search suggestions disappeared when removing or clearing recent searches
  failed; an empty badge list said "Legendary status achieved!".
- Home: cancelling a tile drag left tiles stuck; undoing the deletion of a hidden tile put it on
  the grid; Cancel in edit mode did not restore the layout already saved on the server.
  Customizing while your tiles were still loading, after they failed to load (a server error
  looked like having no saved layout) or right after viewing another profile could save the
  default tiles, or that profile's, over your own: Customize now waits for your tiles and retries
  a failed load, and a slower response for a profile you already left is ignored.
- Text fields with a limit: a full field now ignores further typing instead of dropping text
  from the end, pasted text is cut to fit, counters count characters, an @mention that would not
  fit is no longer inserted, and long comments are shortened without splitting an emoji.
- Sign-in: email addresses are sent exactly as typed (mixed-case addresses could not sign in);
  Forgot password shows an error when the request fails instead of a false success; non-Latin
  usernames got the wrong error message.
- Comments: spinners kept spinning when loading failed; editing a comment to mention more than
  10 people was rejected but saved anyway.
- Errors that are not JSON (such as gateway error pages) or have an empty body now show a proper
  message with their HTTP status, empty successful responses no longer fail, an expired session
  during a photo upload signs you out like everywhere else, and screens that fail to load log
  the final error.
- Insights: Escape in an empty people search now closes it and returns focus to the switcher.
- Accessibility: tabs support Left/Right and Home/End with a single Tab stop; clickable avatars
  are keyboard-accessible buttons; buttons with a hover label (Following → Unfollow) are
  announced by their visible label; the user search keeps its suggestions after clearing and no
  longer flashes "No users found".
- Follower and following counts missed the first follow or follow request for users without a
  counter row, and missed follows made while no counter subscriber was listening.
- Streaks did not count the first completed day when the nightly job had already created that
  day's row.
- Unliking a day reported success when the database failed; over-long notes returned a generic
  update error instead of "Note must be 500 characters or less"; long non-Latin autocomplete
  queries could fail.
- Push notifications: the cleanup expired devices that had not received a push yet, and
  re-registering a device wiped its delivery history, so the cleanup could expire an active
  device; the publisher could crash on shutdown during warm-up or on a Service Bus batch error;
  previews and device details could cut an emoji or accented letter in half; day-completed
  notifications sent to several followers carried another follower's notification ID, so
  opening one from a push did not mark it as read.
- Backend: when Redis could not be reached at startup, requests that use it failed instead of
  falling back; the backend now runs without Redis and connects in the background as soon as
  Redis answers. Request logs recorded failed requests with the wrong status and level; a failed
  database initialisation could be reported as success on a later call; boolean environment
  variables now accept any letter case (`TRUE`, `True`).

### Security
- Signing out closes the live notification connection, unregisters the device's push
  subscription and clears the previous user's notifications, follow state, comments, calendar
  data, push settings, Home layout and cached days from the app and the browser, so the next
  person on the device never sees them. Data left behind by a session that expired or was
  rejected is cleared on the next start or sign-in. After signing out, push has to be turned on
  again on that device; a session that merely expires keeps it.
- A browser still subscribed to push for another account (for example after an expired session)
  stops receiving that account's notifications when someone else signs in; push shows as off for
  the new user until they turn it on, and turning it on now works instead of failing.
- The API rejects every token when `JWT_SECRET_KEY` is unset; tokens signed with an empty key
  used to be accepted.
- Replies are only accepted when the parent comment belongs to the day in the request, so a
  reply can no longer be posted into another (possibly private) day's thread.
- User search (`POST /api/users`) no longer returns other users' email addresses, and a blank
  query returns no users instead of everyone.
- `POST /api/push/cleanup` requires the new `MAINTENANCE_API_KEY`, sent in the
  `X-Maintenance-Key` header, and is rate limited; it is disabled while the key is unset.
  Previously any signed-in user could run it.

## [0.1.0] - 2026-03-28

### Added
- Baseline open-source release documentation.
