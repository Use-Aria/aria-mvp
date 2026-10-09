---
phase: 09-todoist-integration
plan: 03
subsystem: auth
tags: [todoist, oauth, expo-web-browser, deep-link, integrations]

# Dependency graph
requires:
  - phase: 08-ios-app-onboarding
    provides: preferences.tsx Connected Accounts section with Canvas/Google rows
provides:
  - Todoist OAuth callback route at /api/auth/todoist/callback (exchanges code for token, upserts to integrations table)
  - Todoist row in iOS Preferences Connected Accounts section with Connect/Disconnect UI
affects: [todoist-sync, briefing-generator]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "OAuth via WebBrowser.openAuthSessionAsync with aria:// deep link as return URL"
    - "OAuth state param carries user_id to avoid session lookup in server callback"

key-files:
  created:
    - src/app/api/auth/todoist/callback/route.ts
  modified:
    - mobile/app/(home)/preferences.tsx

key-decisions:
  - "Todoist access_token upserted with onConflict: 'user_id,platform' — re-auth overwrites old token without creating duplicate rows"
  - "redirect_uri uses NEXT_PUBLIC_APP_URL env var — supports both dev (localhost:3000) and production Vercel URL without code change"
  - "handleDisconnect updated to handle arbitrary platform strings via ternary chain — no new callback needed for Todoist"

patterns-established:
  - "Todoist OAuth row pattern: identical structure to Canvas/Google rows — dot indicator, label, Connect/Disconnect toggle"
  - "All integration rows except the last get borderBottomWidth: 1 — Todoist row is last so no bottom border"

requirements-completed: [TASK-01]

# Metrics
duration: 8min
completed: 2026-03-20
---

# Phase 9 Plan 03: Todoist OAuth Flow Summary

**Todoist OAuth callback route and iOS Preferences Connect button wired via WebBrowser.openAuthSessionAsync and aria:// deep link**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-03-20T04:00:00Z
- **Completed:** 2026-03-20T04:08:00Z
- **Tasks:** 1 (+ 1 auto-approved human-verify checkpoint)
- **Files modified:** 2

## Accomplishments
- Created Next.js API route at `/api/auth/todoist/callback` that exchanges Todoist auth code for access token, upserts to `integrations` table with `platform='todoist'`, and redirects to `aria://todoist-connected`
- Added Todoist row to iOS Preferences Connected Accounts section following identical Canvas/Google pattern
- Added `handleConnectTodoist` callback using `WebBrowser.openAuthSessionAsync` with Todoist's authorization endpoint (`scope=data:read_write`)
- Updated `handleDisconnect` to handle 'todoist' platform label and disconnect detail message
- Added bottom border to Google row (Todoist row now follows it)

## Task Commits

Each task was committed atomically:

1. **Task 1: Create Todoist OAuth callback route + update iOS Preferences** - `d4b330a` (feat)

**Plan metadata:** (pending docs commit)

## Files Created/Modified
- `src/app/api/auth/todoist/callback/route.ts` - OAuth token exchange endpoint; upserts access_token to integrations, redirects to aria:// deep link
- `mobile/app/(home)/preferences.tsx` - Added WebBrowser import, todoistIntegration lookup, handleConnectTodoist callback, Todoist row in Connected Accounts section, updated handleDisconnect

## Decisions Made
- Todoist access_token upserted with `onConflict: 'user_id,platform'` — re-auth overwrites old token without duplicate rows
- `redirect_uri` uses `NEXT_PUBLIC_APP_URL` env var — supports dev and production without code change
- `handleDisconnect` updated with ternary chain rather than a new callback — keeps disconnect logic centralized

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
Environment variables needed before the OAuth flow works end-to-end:
- `TODOIST_CLIENT_ID` — from Todoist App Management Console
- `TODOIST_CLIENT_SECRET` — from Todoist App Management Console
- `EXPO_PUBLIC_TODOIST_CLIENT_ID` — same as TODOIST_CLIENT_ID, exposed to mobile app
- `NEXT_PUBLIC_APP_URL` — base URL of the Next.js app (e.g., https://aria-mvp.vercel.app)

Also required: Register `{NEXT_PUBLIC_APP_URL}/api/auth/todoist/callback` as an authorized redirect URI in the Todoist App Management Console.

## Next Phase Readiness
- Todoist OAuth connection flow is complete — users can connect from Preferences screen
- Next: Todoist sync job (fetch tasks, normalize to Task[], write to tasks table) can be built with the stored access_token

## Self-Check: PASSED

- src/app/api/auth/todoist/callback/route.ts: FOUND
- mobile/app/(home)/preferences.tsx: FOUND
- Task commit d4b330a: FOUND

---
*Phase: 09-todoist-integration*
*Completed: 2026-03-20*
