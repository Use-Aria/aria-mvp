# Aria — Session Progress

> Last updated: 2026-03-22
> Use this file at the start of every session to restore context quickly.

---

## What We Accomplished This Session

### On-Demand Scheduling — Shipped (2026-03-22)
Applied all 8 plan fixes and executed the full implementation:
- `celery_worker/sms/schedule.py` — new module: date parsing, per-activity preference CRUD, preference learning (silent, from confirmed bookings), Redis pending state, schedule request/confirmation/decline orchestration
- `celery_worker/ai/replies.py` — updated `INTENT_SYSTEM_PROMPT` with `schedule` action + 4 new fields; replaced single intercept with full 4-step intercept order
- `celery_worker/tests/sms/test_schedule.py` — 29 new tests (all passing)
- `celery_worker/tests/ai/test_replies.py` — 5 new intercept/routing tests
- `celery_worker/tests/ai/conftest.py` — autouse fixture so existing tests don't need Redis
- `celery_worker/requirements.txt` — added `dateparser>=1.2.0`
- `.planning/ROADMAP.md` — Phase 13 (Conversational Voice Mode, v1.2) added

**Total test count: 306 (all passing)**

---

## Current State

### v1.1 App Store Launch (active milestone)

| Phase | Status |
|---|---|
| Phase 10: iOS Build Configuration | 🚧 In Progress — `eas.json` + `app.json` written, Apple credentials still needed |
| Phase 11: Backend Deployment | ⏳ Not started |
| Phase 12: Legal, Listing & Submission | ⏳ Not started |

### Phase 4 Enhancement (on-demand scheduling)

| Item | Status |
|---|---|
| Design spec | ✅ Done (`docs/superpowers/specs/`) |
| Implementation plan | ✅ Done (`docs/superpowers/plans/`) |
| Plan fixes (8 items) | ✅ Applied |
| Implementation | ✅ Shipped — 306 tests passing |

---

## Next Steps (in priority order)

1. **Phase 10** — Fill Apple Developer credentials (`APPLE_ID`, `ASC_APP_ID`, team ID in `.env.local`), run `eas build --platform ios --profile preview`, verify TestFlight install
2. **Phase 11** — Deploy Next.js to Vercel, Celery workers to Railway, configure all production env vars
3. **Phase 12** — Privacy Policy, Terms of Service, App Store Connect listing, screenshots, submit
4. **Phase 13** (post launch) — Conversational voice mode redesign (spec + plan needed)

---

## Key File Locations

| What | Where |
|---|---|
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
