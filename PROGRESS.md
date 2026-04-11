# Aria — Session Progress

> Last updated: 2026-04-11 (session 2)
> Use this file at the start of every session to restore context quickly.

---

## What We Accomplished This Session

### Onboarding Phase C — Auth Pivot (COMPLETE, 2026-04-11 session 2)

Executing `docs/superpowers/plans/2026-04-11-onboarding-phone-auth-pivot.md`.

**All 10 code tasks done. Plan fully executed.**

| Task | What shipped | Commit |
|------|-------------|--------|
| Task 1 | Deleted `src/app/api/auth/phone/send/route.ts` + `/verify/route.ts` | `9386f9a` |
| Task 2 | `src/app/api/onboarding/profile/route.ts` — phone now read from `user.phone` session (dropped from request body) | `c9f41a1` |
| Task 3 | `mobile/lib/api.ts` — removed `sendPhoneOtp`/`verifyPhoneOtp`, updated `saveProfile` signature, exported `API_BASE` | `091b881` |
| Task 4 | `mobile/app/(onboarding)/auth.tsx` — full rewrite: phone entry + `supabase.auth.signInWithOtp`. Also wrote tests + fixed Expo winter runtime Jest blocker (`jest.globals.js` + `__mocks__/empty.js`) | `c9202e3` |
| Task 5 | `mobile/app/(onboarding)/verify-phone.tsx` — now uses `supabase.auth.verifyOtp`, no mount API call, navigates to `profile`. `PinInput` updated with `testID` + `onComplete` forwarding for tests | `3ae59b4` |
| Tasks 6–10 | `profile.tsx` (phone removed, navigate to tcpa, ProgressBar step 4, Pressable + Text.disabled), `tools.tsx` (WebBrowser + integrations poll), `_layout.tsx` (reorder), `expo-apple-authentication` uninstalled, 11/11 tests pass, lint clean | `7d3d8a5` |

---

## Current Status

**OB-P1 (all 10 code tasks) = DONE.** Branch: `onboarding`. Committed + pushed.

**Blocked on OB-P0 (manual):** Supabase phone auth provider must be enabled before simulator testing. See exact steps below.

---

## OB-P0 — Supabase Phone Auth Setup (Manual — Daniel)

**Location:** supabase.com → your project → Authentication → Providers → Phone

1. Toggle "Enable Phone provider" ON
2. Select **Twilio** as SMS provider
3. Fill in:
   - **Account SID** → `TWILIO_ACCOUNT_SID` from `.env.local`
   - **Auth Token** → `TWILIO_AUTH_TOKEN` from `.env.local`
   - **Messaging Service SID** → a Twilio `MG...` SID (NOT `TWILIO_PHONE_NUMBER`, NOT `TWILIO_VERIFY_SERVICE_SID` which is `VA...`)
     - To create: Twilio Console → Messaging → Services → Create Messaging Service → add your phone number as sender → copy the `MG...` SID
   - **Twilio Content SID** → leave blank (WhatsApp only)
   - **Test Phone Numbers and OTPs** → add your own number + code `123456` for simulator testing (no real SMS needed)
4. Click Save

---

## Next Steps (in order)

| Step | What | Who |
|------|------|-----|
| **OB-P0** ⚠️ | Enable Supabase phone auth + Twilio Messaging Service (see above) | Daniel |
| **OB-C3** | Integration test on simulator: phone → OTP → profile → TCPA → Google → success → welcome SMS | Daniel |
| **OB-C4** | Code review backend + mobile screens, fix findings | Daniel |
| **OB-C5** | Merge `onboarding` → `main` | Daniel |
| **OB-D1** | `mobile/app/(home)/preferences.tsx` integration management UI (after merge) | Daniel |

---

## Critical Jest Fix Applied (session 1)

**Problem:** Expo 55 winter runtime installs lazy getters for `structuredClone`, `__ExpoImportMetaRegistry` etc. on `global`. When these fire during React test rendering, they try to `require()` from Jest's torn-down module scope → "You are trying to import a file outside of the scope of the test code."

**Fix:** `mobile/jest.globals.js` (added to `setupFiles` in `jest.config.js`) pre-defines those globals as **non-configurable** before Expo loads, preventing Expo's `installGlobal()` from overwriting them with lazy getters.

**Also:** `mobile/__mocks__/empty.js` + `moduleNameMapper` entry (belt-and-suspenders — can remove if unneeded).

---

## Test Status

All 11 tests in `mobile/__tests__/onboarding.test.tsx` pass. Run:

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
| getSession() mock in tests | The test mock returns a plain object (not Promise). Use `await supabase.auth.getSession()` pattern, NOT `.then()` — awaiting a non-promise returns the value directly |
| Text.disabled for testing | RN `Text` has a `disabled` prop explicitly for testing. Pass `disabled={condition}` to `<Text>` to make `getByText(...).parent?.props.disabled` work in test renderer. Neither `TouchableOpacity` nor `Pressable` exposes `disabled` on their rendered host element. |
| Supabase phone auth Twilio field | Supabase wants a **Messaging Service SID** (`MG...`), NOT the raw phone number and NOT the Verify Service SID (`VA...`). Create in Twilio Console → Messaging → Services. |
