# Aria — Session Progress

> Last updated: 2026-04-11
> Use this file at the start of every session to restore context quickly.

---

## What We Accomplished This Session

### Onboarding Phase C — Auth Pivot (partial, 2026-04-11)

Executing `docs/superpowers/plans/2026-04-11-onboarding-phone-auth-pivot.md`.

Tasks completed (5 of 9 code tasks):

| Task | What shipped | Commit |
|------|-------------|--------|
| Task 1 | Deleted `src/app/api/auth/phone/send/route.ts` + `/verify/route.ts` | `9386f9a` |
| Task 2 | `src/app/api/onboarding/profile/route.ts` — phone now read from `user.phone` session (dropped from request body) | `c9f41a1` |
| Task 3 | `mobile/lib/api.ts` — removed `sendPhoneOtp`/`verifyPhoneOtp`, updated `saveProfile` signature, exported `API_BASE` | `091b881` |
| Task 4 | `mobile/app/(onboarding)/auth.tsx` — full rewrite: phone entry + `supabase.auth.signInWithOtp`. Also wrote tests + fixed Expo winter runtime Jest blocker (`jest.globals.js` + `__mocks__/empty.js`) | `c9202e3` |
| Task 5 | `mobile/app/(onboarding)/verify-phone.tsx` — now uses `supabase.auth.verifyOtp`, no mount API call, navigates to `profile`. `PinInput` updated with `testID` + `onComplete` forwarding for tests | `3ae59b4` |

---

## Remaining Phase C Tasks (Tasks 6–10)

All on branch `onboarding`. Plan: `docs/superpowers/plans/2026-04-11-onboarding-phone-auth-pivot.md`

| Task | File | What to do |
|------|------|------------|
| **Task 6** | `mobile/app/(onboarding)/profile.tsx` | Remove phone field + PhoneInput import. Tests already written in `__tests__/onboarding.test.tsx`. Run failing test first, then update screen. Navigate to `tcpa`. ProgressBar step → 4. |
| **Task 7** | `mobile/app/(onboarding)/tools.tsx` | Replace `expo-auth-session` nonce logic with `WebBrowser.openBrowserAsync` + integrations table poll. Check for `expo-crypto` imports to remove. |
| **Task 8** | `mobile/app/(onboarding)/_layout.tsx` | Reorder Stack: auth → verify-phone → profile (verify-phone BEFORE profile). |
| **Task 9** | `mobile/package.json` | `npm uninstall expo-apple-authentication` (auth.tsx no longer imports it). |
| **Task 10** | — | Full test suite (`npx jest __tests__/onboarding.test.tsx --verbose`) + `npm run lint` + confirm no `auth/phone/send\|verify` references in src/ or mobile/. |

---

## Critical Jest Fix Applied This Session

**Problem:** Expo 55 winter runtime installs lazy getters for `structuredClone`, `__ExpoImportMetaRegistry` etc. on `global`. When these fire during React test rendering, they try to `require()` from Jest's torn-down module scope → "You are trying to import a file outside of the scope of the test code."

**Fix:** `mobile/jest.globals.js` (added to `setupFiles` in `jest.config.js`) pre-defines those globals as **non-configurable** before Expo loads, preventing Expo's `installGlobal()` from overwriting them with lazy getters.

**Also:** `mobile/__mocks__/empty.js` + `moduleNameMapper` entry (belt-and-suspenders — can remove if unneeded).

---

## Test Status

All tests in `mobile/__tests__/onboarding.test.tsx` for Tasks 4 + 5 pass (7 tests). Tasks 6 tests are written and failing (expected — TDD). Run:

```bash
cd mobile && npx jest __tests__/onboarding.test.tsx --verbose
```

---

## Key File Locations

| What | Where |
|------|-------|
| Phase C pivot plan (full task list) | `docs/superpowers/plans/2026-04-11-onboarding-phone-auth-pivot.md` |
| Onboarding spec (screen flow, API contracts) | `docs/onboarding-redesign-spec.md` |
| Onboarding test file | `mobile/__tests__/onboarding.test.tsx` |
| Jest globals fix | `mobile/jest.globals.js` |
| Branch | `onboarding` |

---

## Architecture Gotchas

> Permanent — these survive across sessions.

| Gotcha | Rule |
|--------|------|
| Course matching | `syllabi.course_name` vs `canonical_events.course_id` — always use ILIKE |
| Windows strftime | `%-I` fails on Windows; use `%I` + `.lstrip("0").lower()` |
| Lazy import patching | Patch at the SOURCE module, never the importing module |
| Token encryption boundary | Next.js callback NEVER writes tokens to Supabase directly |
| GCal/Gmail watch expiry | Watch channels expire every 7 days — `renew-watch-channels` Beat task runs every 6h |
| Google OAuth verification | Gmail readonly is sensitive scope — app verification takes 1–6 weeks |
| PDF bytes | Never persisted — only base64 passes through Redis queue |
| Re-parse guard | `check_existing_syllabus()` skips Claude call if `parsed_json` already exists |
| On-demand scheduling flow | Redis pending state (5-min TTL) bridges two-message confirm flow |
| conftest autouse | `tests/ai/conftest.py` stubs Redis intercepts — new schedule tests must patch `sms.schedule.*` directly |
| Expo winter runtime in Jest | Pre-define `structuredClone` + `__ExpoImportMetaRegistry` as non-configurable in `jest.globals.js` — see fix above |
| PhoneInput test input | `fireEvent.changeText` with RAW DIGITS only (e.g. `'5551234567'`), not formatted string. Formatted string double-counts the `+1` country code. |
| PinInput testID | `PinInput` accepts `testID` prop forwarded to root View with `onComplete` — `fireEvent(el, 'complete', code)` works |
| Phone in profile route | Since pivot: phone is NOT in request body — backend reads `user.phone` from Supabase JWT session |
