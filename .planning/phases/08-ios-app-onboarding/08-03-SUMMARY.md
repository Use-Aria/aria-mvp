---
phase: 08-ios-app-onboarding
plan: 03
subsystem: ui
tags: [expo, react-native, google-oauth, expo-auth-session, expo-crypto, tcpa, supabase-auth, onboarding]

requires:
  - phase: 08-ios-app-onboarding/08-01
    provides: supabase.ts ExpoSecureStoreAdapter, api.ts with getBriefingPreview, theme.ts with useTheme
  - phase: 08-ios-app-onboarding/08-02
    provides: ProgressBar component with currentStep prop

provides:
  - mobile/app/(onboarding)/google.tsx (Step 5 — Google OAuth with nonce threading and skip CTA)
  - mobile/app/(onboarding)/tcpa.tsx (Step 6 — TCPA consent toggle, writes has_alert_consent)
  - mobile/app/(onboarding)/preview.tsx (Step 7 — briefing preview with 404/500 graceful degradation)

affects:
  - Phase 5 alert delivery (reads has_alert_consent from preferences_json)
  - Backend /api/briefing/preview route (preview screen handles its absence gracefully)

tech-stack:
  added: []
  patterns:
    - "Module-level WebBrowser.maybeCompleteAuthSession() — must be outside component, not in useEffect"
    - "Nonce pair for Google OAuth: hashed nonce to Google extraParams, raw nonce to Supabase signInWithIdToken"
    - "Google provider_token intentionally excluded from client-side ExpoSecureStore (2KB limit risk)"
    - "TCPA toggle defaults OFF — explicit boolean written (not omitted) so Phase 5 can distinguish declined vs unset"
    - "router.replace for onboarding completion — removes stack so user cannot back-navigate into onboarding"
    - "API 404/500 graceful degradation — preview screen shows fallback without crashing"

key-files:
  created:
    - mobile/app/(onboarding)/google.tsx
    - mobile/app/(onboarding)/tcpa.tsx
    - mobile/app/(onboarding)/preview.tsx
  modified: []

key-decisions:
  - "Google provider_token NOT stored client-side — ExpoSecureStore 2KB limit can cause silent failures; backend stores it via Supabase auth webhook"
  - "TCPA has_alert_consent written as explicit false (not omitted) when toggle is OFF — Phase 5 send_sms_alert reads this field to determine bypass eligibility"
  - "router.replace (not push) on Enter Aria — removes onboarding stack from navigation history so user cannot swipe back"
  - "Preview screen fetches on mount and handles 404/500 gracefully — /api/briefing/preview does not exist yet; fallback shows 'Couldn't load preview. Your first briefing will arrive tomorrow morning.'"

patterns-established:
  - "Nonce pair pattern for Google OAuth: generate UUID, hash with SHA-256, pass hashed to OAuth extraParams, raw to signInWithIdToken"
  - "TCPA screen pattern: toggle defaults OFF, read-merge-write to preserve preferences_json keys"
  - "Graceful API degradation: catch() sets loading to false, null state triggers error UI with fallback CTA"

requirements-completed: [AUTH-02, AUTH-03, UI-01, UI-05]

duration: 4min
completed: 2026-03-20
---

# Phase 08 Plan 03: Onboarding Screens 5-7 (Google OAuth, TCPA, Briefing Preview) Summary

**Google OAuth with nonce-threaded signInWithIdToken (provider_token excluded), TCPA toggle defaulting OFF writing explicit has_alert_consent, and briefing preview with 404/500 graceful fallback completing the 7-step onboarding wizard**

## Performance

- **Duration:** ~4 min
- **Started:** 2026-03-20T02:22:11Z
- **Completed:** 2026-03-20T02:25:57Z
- **Tasks:** 2 completed
- **Files created:** 3

## Accomplishments

- Google OAuth screen (Step 5): nonce pair generated on mount, hashed nonce sent to Google, raw nonce to Supabase `signInWithIdToken`, `provider_token` intentionally excluded from client-side storage, skip CTA navigates directly to TCPA
- TCPA consent screen (Step 6): `Switch` defaults `false` (TCPA legal requirement), reads existing `preferences_json` before merge, writes explicit `has_alert_consent: boolean` on Confirm
- Briefing preview screen (Step 7): fetches `BriefingPreviewResponse` from `/api/briefing/preview` on mount, handles 404/500 with "Couldn't load preview" + "Continue anyway" fallback, uses `router.replace` to prevent back-navigation into onboarding

## Task Commits

Each task was committed atomically:

1. **Task 1: Google OAuth screen with nonce threading and skip CTA** - `5a501f4` (feat)
2. **Task 2: TCPA consent screen and briefing preview screen** - `7877fa6` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified

- `mobile/app/(onboarding)/google.tsx` — Step 5: Google OAuth with expo-crypto nonce pair, expo-auth-session Google provider, supabase.auth.signInWithIdToken, skip flow
- `mobile/app/(onboarding)/tcpa.tsx` — Step 6: React Native Switch defaulting OFF, Supabase preferences_json merge-write for has_alert_consent
- `mobile/app/(onboarding)/preview.tsx` — Step 7: api.getBriefingPreview() with loading skeleton, success card, error fallback, router.replace to home

## Decisions Made

- **Google provider_token excluded:** ExpoSecureStore has a 2KB per-key limit. Google's provider_token can exceed this, causing silent storage failures on app re-launch. The Supabase session (access_token + refresh_token) is stored automatically by ExpoSecureStoreAdapter. Backend stores provider_token via Supabase auth webhook.
- **TCPA explicit false:** `has_alert_consent` is written as `false` when toggle is OFF (not omitted). Phase 5's `send_sms_alert()` reads this field — it must distinguish "user declined" from "field never set".
- **router.replace on Enter Aria:** Removes the onboarding group from the navigation stack. User cannot swipe back into onboarding after completing it.
- **Preview graceful degradation:** `/api/briefing/preview` does not exist yet (planned for Phase 4+). Preview screen handles this with a catch block, setting `briefing` to `null` and rendering the fallback UI.

## Deviations from Plan

None — plan executed exactly as written. ProgressBar component already existed from Plan 02 (no deviation needed).

## Issues Encountered

None.

## User Setup Required

None — no external service configuration required beyond EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID and EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID environment variables (documented in existing CLAUDE.md).

## Next Phase Readiness

- Onboarding wizard is fully complete (7 steps): welcome → phone → verify → canvas → google → tcpa → preview
- User lands on home screen after "Enter Aria" with no back navigation to onboarding
- `has_alert_consent` in `users.preferences_json` is ready for Phase 5 alert delivery
- Backend `/api/briefing/preview` route needed for preview screen to show real content (currently shows fallback)

---
*Phase: 08-ios-app-onboarding*
*Completed: 2026-03-20*
