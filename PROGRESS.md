# Aria — Session Progress

> Last updated: 2026-04-10
> Use this file at the start of every session to restore context quickly.

---

## What We Accomplished This Session

### Onboarding Redesign — Session 2 (2026-04-10)
- Disconnected ultraplan dependency — planning is now self-contained in PROGRESS.md
- Created `supabase/migrations/008_onboarding_completion.sql` — adds `phone_verified BOOLEAN NOT NULL DEFAULT FALSE` and `onboarding_completed_at TIMESTAMPTZ` to `users` table
- **Blocked:** Could not run `npx supabase db push` — Supabase CLI requires a `SUPABASE_ACCESS_TOKEN` (non-TTY environment, browser login not available). Must run `npx supabase login --token <token>` or set `SUPABASE_ACCESS_TOKEN` env var before next session. Get token from: https://supabase.com/dashboard/account/tokens

### Onboarding Redesign — Plan Written (2026-04-10)
Full redesign of the onboarding flow planned (no code written yet).
- New flow: `welcome → auth → profile → verify-phone → tcpa → tools → success → home`
- Auth moved from phone OTP to Apple Sign-In or Google OAuth
- Phone OTP retained for phone number verification (Twilio Verify, not Twilio Messaging)
- Gmail + Google Calendar promoted to required integrations (Canvas demoted to optional)
- Canvas validation, syllabus PDF upload, and Google Classroom ("coming soon") all in unified tools screen
- Welcome SMS decoupled from Canvas sync — triggered via new `POST /api/onboarding/complete`
- Preferences screen will expose connect/disconnect for all tools post-onboarding
- 7 new backend files, 5 new mobile screens, 5 deleted mobile screens identified

---

## Current State

### Onboarding Redesign (active — plan approved, not yet executed)

| Item | Status |
|---|---|
| Plan written | ✅ Done |
| Backend implementation | ⏳ Not started |
| Mobile implementation | ⏳ Not started |

### v1.1 App Store Launch (blocked on onboarding)

| Phase | Status |
|---|---|
| Phase 10: iOS Build Configuration | 🚧 In Progress — `eas.json` + `app.json` written, Apple credentials still needed |
| Phase 11: Backend Deployment | ⏳ Not started |
| Phase 12: Legal, Listing & Submission | ⏳ Not started |

---

## Next Steps (in priority order)

1. **Onboarding — A7 (DB migration)** — migration file already written at `supabase/migrations/008_onboarding_completion.sql`. **Must get Supabase access token first:** set `SUPABASE_ACCESS_TOKEN` env var (get from supabase.com/dashboard/account/tokens), then run `npx supabase link --project-ref jjnedeyfpgogaizsucxp && npx supabase db push`
2. **Onboarding — Backend APIs (parallel)** — implement `src/app/api/onboarding/profile/route.ts`, `src/app/api/auth/phone/send/route.ts`, `src/app/api/auth/phone/verify/route.ts`, `src/app/api/onboarding/complete/route.ts`; fix stub at `src/app/api/sync/canvas/route.ts` to return `{ deadline_count, sample_courses }`; add `TWILIO_VERIFY_SERVICE_SID` env var
3. **Onboarding — Mobile screens (after API contracts locked)** — create `auth.tsx`, `profile.tsx`, `verify-phone.tsx`, `tools.tsx`, `success.tsx`; update `_layout.tsx` and `mobile/lib/api.ts`; add `expo-apple-authentication` (`npx expo install expo-apple-authentication`)
4. **Onboarding — Delete old screens** — remove `phone.tsx`, `verify.tsx`, `canvas.tsx`, `google.tsx`, `preview.tsx`
5. **Phase 10** — Apple Developer credentials → TestFlight build

---

## Key File Locations

| What | Where |
|---|---|
| **Onboarding redesign spec** | **`docs/onboarding-redesign-spec.md`** |
| Project overview | `.planning/PROJECT.md` |
| Roadmap (all phases) | `.planning/ROADMAP.md` |
| GSD decisions log | `.planning/STATE.md` |
| Scheduling spec | `docs/superpowers/specs/2026-03-21-on-demand-scheduling-design.md` |
| Scheduling plan (executed) | `docs/superpowers/plans/2026-03-21-on-demand-scheduling.md` |
| Scheduling module | `celery_worker/sms/schedule.py` |
| SMS reply handler | `celery_worker/ai/replies.py` |
| iOS build config (Phase 10) | `mobile/app.json`, `mobile/eas.json` |
| GCal slot finder | `celery_worker/gcal/slots.py` |
| GCal writeback | `celery_worker/gcal/writeback.py` |

---

## Architecture Gotchas

> Permanent — these survive across sessions. Add new ones as you discover them.

| Gotcha | Rule |
|--------|------|
| Course matching | `syllabi.course_name` vs `canonical_events.course_id` — always use ILIKE; casing/formatting varies |
| Windows strftime | `%-I` fails on Windows; use `%I` + `.lstrip("0").lower()` in `_format_time()` |
| Lazy import patching | Patch at the SOURCE module (`sms.batch.enqueue_alert`), never the importing module |
| Token encryption boundary | Next.js callback NEVER writes tokens to Supabase directly — only `encrypt_and_store_tokens` Celery task writes |
| GCal/Gmail watch expiry | Watch channels expire every 7 days silently — `renew-watch-channels` Beat task runs every 6h |
| Google OAuth verification | Gmail readonly is a sensitive scope — app verification takes 1–6 weeks; start NOW |
| PDF bytes | Never persisted — only base64 passes through Redis queue → Celery decodes → parses → discards |
| Re-parse guard | `check_existing_syllabus()` skips Claude call entirely if `parsed_json` already exists in DB |
| On-demand scheduling flow | Redis pending state (5-min TTL) bridges two-message confirm flow; intercept order: pending_preference → pending_schedule → study_preference → Claude |
| conftest autouse | `tests/ai/conftest.py` stubs out both Redis intercepts for all ai tests — new schedule tests must patch `sms.schedule.*` directly to override |
| Twilio two-service split | `TWILIO_PHONE_NUMBER` + `TWILIO_ACCOUNT_SID/AUTH_TOKEN` = messaging; `TWILIO_VERIFY_SERVICE_SID` = OTP verify — separate service, must be created in Twilio Console |
| Apple Sign-In requires NSFaceIDUsageDescription | `mobile/app.json` must include `NSFaceIDUsageDescription` for Apple Sign-In to pass App Store review |
| Apple auth → Google tools required | If user signs in with Apple (not Google), Gmail+GCal scopes are NOT granted at auth time — tools screen must show a "Connect Google" prompt before allowing Continue |
| Welcome SMS decoupled from Canvas | `tasks.welcome_briefing` is no longer triggered by first Canvas sync — it fires via `POST /api/onboarding/complete`. Don't re-couple these. |

---

## Architecture Reminder

Aria's SMS reply pipeline:
```
Twilio inbound → /api/sms/webhook → Celery (process_inbound_sms) → handle_reply()
                                                                          ↓
                                                               4-step intercept:
                                                               1. pending_preference (Redis)
                                                               2. pending_schedule (Redis)
                                                               3. study_preference keywords
                                                               4. Claude intent extraction
                                                                          ↓
                                                               Action router → schedule / mark_complete / snooze / etc.
```

Scheduling flow:
```
"find me time to study biochem tomorrow"
    → Claude: action=schedule, activity_type=study, subject=biochem, target_date_string=tomorrow
    → handle_schedule_request()
        → get_activity_preference() → "evening" (or ask if unknown)
        → find_free_slots() → [8-10pm, 3-5pm, ...]
        → store_pending_schedule() in Redis (TTL 5min)
        → return "Best window tomorrow is 8–10pm. Should I add it?"
"yes"
    → pending_schedule intercept fires
    → handle_schedule_confirmation()
        → create_study_block() on GCal
        → learn_from_confirmation() → update recent_blocks
        → return "Done — Biochem Study added for 8–10pm tomorrow."
```
