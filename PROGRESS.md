# Aria — Session Progress

> Last updated: 2026-04-10
> Use this file at the start of every session to restore context quickly.

---

## What We Accomplished This Session

### Onboarding Redesign — Phases A + B Shipped (2026-04-10)

**DB Migration:**
- Fixed `006_google_integrations.sql` — `ADD CONSTRAINT IF NOT EXISTS` → `CREATE UNIQUE INDEX IF NOT EXISTS`
- Pushed migrations 006–008 to Supabase project `jjnedeyfpgogaizsucxp` (Aria MVP)
- Migration 008 adds `phone_verified BOOLEAN` and `onboarding_completed_at TIMESTAMPTZ` to `users` table

**Phase A — Backend routes:**
- `POST /api/onboarding/profile` — upserts name, phone, university, graduation_year
- `POST /api/auth/phone/send` — Twilio Verify OTP send (`TWILIO_VERIFY_SERVICE_SID`)
- `POST /api/auth/phone/verify` — checks OTP, sets `phone_verified=true`; 410=expired, 422=wrong
- `POST /api/sync/canvas` — real iCal fetch + VEVENT count + course extraction (was a stub)
- `POST /api/onboarding/complete` — sets `onboarding_completed_at`, enqueues `tasks.welcome_briefing`

**Phase B — Mobile screens:**
- Installed `expo-apple-authentication`
- Created: `auth.tsx`, `profile.tsx`, `verify-phone.tsx`, `tools.tsx`, `success.tsx`
- Updated: `_layout.tsx`, `tcpa.tsx` (nav → tools), `welcome.tsx` (nav → auth)
- Added to `mobile/lib/api.ts`: `saveProfile()`, `completeOnboarding()`, `uploadSyllabus()`
- Deleted: `phone.tsx`, `verify.tsx`, `canvas.tsx`, `google.tsx`, `preview.tsx`

**New screen flow:** `welcome → auth → profile → verify-phone → tcpa → tools → success → home`

---

## Current State

### Onboarding Redesign (branch: `onboarding`)

| Phase | Status |
|---|---|
| Phase A — Backend routes | ✅ Done — committed |
| Phase B — Mobile screens | ✅ Done — committed |
| Phase C — Integration testing + code review | ⏳ **Start here next session** |
| Phase D — preferences.tsx integration management | ⏳ After Phase C |

---

## Next Steps

### Before running the simulator (do first):
1. Fill `mobile/.env` — `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` and `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` (Google Cloud Console → OAuth 2.0 → iOS client ID)
2. Verify Apple Sign-In enabled in Supabase Auth dashboard (Auth → Providers → Apple)

### Phase C — Integration test (Google path on simulator):
1. Start services: `npm run dev` + Docker Compose (Celery + Redis)
2. Launch simulator: `cd mobile && npx expo start --ios`
3. Walk the full flow: Sign in with Google → fill profile → OTP SMS arrives → TCPA → skip optional tools → Complete → welcome SMS received
4. Verify in Supabase: `phone_verified=true` and `onboarding_completed_at` set on the user row

### Phase C — Code review:
- Run `superpowers:requesting-code-review` on the onboarding branch
- Key files: all 5 backend routes + 5 new mobile screens

### Phase C — Merge:
- After review findings fixed: merge `onboarding` → `main`

### Phase D (after merge):
- `mobile/app/(home)/preferences.tsx` — integration management (Google connect/disconnect, Canvas URL edit, syllabus list, Classroom coming soon)

---

## Key File Locations

| What | Where |
|---|---|
| Onboarding spec | `docs/onboarding-redesign-spec.md` |
| DB migration (008) | `supabase/migrations/008_onboarding_completion.sql` |
| Profile route | `src/app/api/onboarding/profile/route.ts` |
| Phone OTP send | `src/app/api/auth/phone/send/route.ts` |
| Phone OTP verify | `src/app/api/auth/phone/verify/route.ts` |
| Canvas validation | `src/app/api/sync/canvas/route.ts` |
| Onboarding complete | `src/app/api/onboarding/complete/route.ts` |
| Auth screen | `mobile/app/(onboarding)/auth.tsx` |
| Profile screen | `mobile/app/(onboarding)/profile.tsx` |
| Verify phone screen | `mobile/app/(onboarding)/verify-phone.tsx` |
| Tools screen | `mobile/app/(onboarding)/tools.tsx` |
| Success screen | `mobile/app/(onboarding)/success.tsx` |
| Mobile API client | `mobile/lib/api.ts` |
| Mobile env vars | `mobile/.env` |

---

## Architecture Gotchas

| Gotcha | Rule |
|--------|------|
| Course matching | `syllabi.course_name` vs `canonical_events.course_id` — always use ILIKE |
| Windows strftime | `%-I` fails; use `%I` + `.lstrip("0").lower()` |
| Token encryption boundary | Next.js callback NEVER writes tokens to Supabase — only `encrypt_and_store_tokens` Celery task |
| GCal/Gmail watch expiry | Watch channels expire every 7 days — `renew-watch-channels` Beat task runs every 6h |
| Google OAuth verification | Gmail readonly scope needs Google app verification (1–6 weeks) |
| PDF bytes | Never persisted — base64 through Redis → Celery → parse → discard |
| Re-parse guard | `check_existing_syllabus()` skips Claude if `parsed_json` already in DB |
| conftest autouse | `tests/ai/conftest.py` stubs Redis intercepts — new schedule tests must patch `sms.schedule.*` directly |
| Supabase migration syntax | `ADD CONSTRAINT IF NOT EXISTS` not supported — use `CREATE UNIQUE INDEX IF NOT EXISTS` |
| Twilio Verify vs Messaging | `TWILIO_VERIFY_SERVICE_SID` is SEPARATE from `TWILIO_ACCOUNT_SID`. Do not mix. |
| Welcome SMS trigger | Only `POST /api/onboarding/complete` → `tasks.welcome_briefing`. Never re-couple to Canvas sync. |
| Apple auth + Google scopes | Apple Sign-In grants no Google scopes. `tools.tsx` detects `app_metadata.provider` and shows Connect Google. |
| Google OAuth nonce flow | rawNonce → Supabase; SHA-256(rawNonce) → Google `extraParams.nonce`. Never swap. |
| ExpoSecureStore limit | 2KB per key — never store provider_token client-side. |
