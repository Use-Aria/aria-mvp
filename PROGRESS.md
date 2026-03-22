# Aria — Session Progress

> Last updated: 2026-03-21
> Use this file at the start of every session to restore context quickly.

---

## What We Accomplished This Session

### 1. Notion Sync
Updated the Aria Notion workspace to match the current git state:
- **Main Aria page** — rewrote the description (removed out-of-scope items like iMessage/Apple Health/Slack), added current milestone (v1.1), filled in the actual tech stack (was "TBD")
- **MVP Progress Log** — added Phases 10, 11, 12 to the status table; added 4 missing push log entries (Push #13 iOS App, Push #14 Todoist, Push #15 v1.0 milestone ship, Push #16 Phase 10 build config)

### 2. Product Decisions Made
Had a detailed product review conversation. Key decisions:

| Topic | Decision |
|---|---|
| Phase 4 scheduling | Add on-demand scheduling to SMS handler — confirmed before booking, learns per-activity preferences over time |
| Phase 7 (syllabus) | Manual PDF upload is correct for now; Canvas iCal doesn't expose syllabus content |
| Phase 8 voice | Current two-tap voice is wrong UX — needs full conversational redesign (voice activity detection, TTS, live visual feedback) |
| Voice redesign timing | **Do after App Store launch** — don't delay Phase 10–12 for it |
| Scheduling activity types | Support **any** activity (not just study/workout) from day one |
| Confirmation flow | Always confirm before booking; learn from confirmed time to refine future suggestions |

### 3. Phase 13 Added to Roadmap
Conversational Voice Mode added as Phase 13 (v1.2, post App Store launch):
- Auto-detect end of speech (no tap to stop)
- Aria responds verbally + shows live visual feedback (calendar animations, task list updates)
- Dedicated full-screen voice canvas UI (not a home page button)
- On-demand scheduling works through voice

### 4. On-Demand Scheduling — Designed & Planned
Full design and implementation plan created for Phase 4 on-demand scheduling:

**Spec:** `docs/superpowers/specs/2026-03-21-on-demand-scheduling-design.md`
**Plan:** `docs/superpowers/plans/2026-03-21-on-demand-scheduling.md`

Design covers:
- New `schedule` SMS intent (any activity type: study, workout, meal, etc.)
- Per-activity time preference store in `preferences_json.activity_preferences`
- Silent preference learning from confirmed bookings (`recent_blocks` rolling window)
- Two-step confirmation flow (Aria proposes → student confirms → books)
- Redis pending state for multi-message flows (5-min TTL)
- Natural language date parsing via `dateparser`
- 4-step intercept order in `handle_reply()` to avoid collisions

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
| Design spec | ✅ Written + reviewed (`docs/superpowers/specs/`) |
| Implementation plan | ✅ Written + reviewed (`docs/superpowers/plans/`) |
| Plan minor fixes (8 items) | ⚠️ Not applied yet — session ran out of context |
| Implementation | ⏳ Not started |

---

## Next Steps (in priority order)

### Immediate — Fix the plan before executing it
The implementation plan has 8 known minor issues identified by the spec reviewer. Apply these before executing:

1. **Add `__init__.py` step** to Task 2 — create `celery_worker/tests/sms/__init__.py`
2. **Add pre-7am test** — `_classify_time_block` before 7am should return `"evening"` (behavior is implemented, just not tested)
3. **Fix `%-I` strftime** — Windows-incompatible; change to `%I` + `lstrip("0")` in `_format_time()`
4. **Add TTL assertion** to `test_store_and_get_pending_schedule` — verify `setex` called with 300s
5. **Fix unmatched-reply test** — assert `clear_pending_schedule` was NOT called (pending key survives)
6. **Add `handle_schedule_decline` no-pending test** — graceful message when pending expired
7. **Fix three-way `or`** in `test_handle_schedule_confirmation_no_pending` — narrow to single assertion
8. **Add `.planning/ROADMAP.md`** to Task 9 file header with path verification step

### Then — Execute the plan
```
/gsd:execute-phase  (or subagent-driven-development skill)
Plan: docs/superpowers/plans/2026-03-21-on-demand-scheduling.md
```

Files the plan creates/modifies:
- `celery_worker/sms/schedule.py` — new (all scheduling logic)
- `celery_worker/ai/replies.py` — modified (intent prompt + intercept + routing)
- `celery_worker/requirements.txt` — add `dateparser>=1.2.0`
- `celery_worker/tests/sms/test_schedule.py` — new
- `celery_worker/tests/ai/test_replies.py` — modified

### After scheduling is implemented
- Continue **Phase 10** — fill in Apple Developer credentials, run `eas build --platform ios --profile preview`, verify TestFlight
- **Phase 11** — Deploy to Vercel + Railway
- **Phase 12** — Privacy Policy, App Store listing, submit

### Post App Store launch (v1.2)
- **Phase 13** — Conversational voice mode redesign (full spec + plan needed)

---

## Key File Locations

| What | Where |
|---|---|
| Project overview | `.planning/PROJECT.md` |
| Roadmap (all phases) | `.planning/ROADMAP.md` |
| Scheduling spec | `docs/superpowers/specs/2026-03-21-on-demand-scheduling-design.md` |
| Scheduling plan | `docs/superpowers/plans/2026-03-21-on-demand-scheduling.md` |
| iOS build config (Phase 10) | `app.json`, `eas.json` |
| SMS reply handler | `celery_worker/ai/replies.py` |
| GCal slot finder | `celery_worker/gcal/slots.py` |
| GCal writeback | `celery_worker/gcal/writeback.py` |

---

## Architecture Reminder (for context restoration)

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

New scheduling flow (once implemented):
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
