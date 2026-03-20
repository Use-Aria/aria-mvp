---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: unknown
stopped_at: Completed 06-05-PLAN.md
last_updated: "2026-03-20T03:37:26.548Z"
progress:
  total_phases: 9
  completed_phases: 6
  total_plans: 16
  completed_plans: 16
---

---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: unknown
stopped_at: Completed 01-infrastructure-foundation/01-01-PLAN.md
last_updated: "2026-03-18T21:19:33.544Z"
progress:
  total_phases: 7
  completed_phases: 1
  total_plans: 2
  completed_plans: 2
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-18)

**Core value:** Students never miss a deadline or lose track of their week — Aria surfaces what matters, when it matters, over SMS.
**Current focus:** Phase 06 — google-oauth-gcal-gmail-alerts-conflict-detection

## Current Position

Phase: 06 (google-oauth-gcal-gmail-alerts-conflict-detection) — EXECUTING
Plan: 1 of 5

## Performance Metrics

**Velocity:**

- Total plans completed: 0
- Average duration: -
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

**Recent Trend:**

- Last 5 plans: -
- Trend: -

*Updated after each plan completion*
| Phase 01-infrastructure-foundation P02 | 1 | 2 tasks | 6 files |
| Phase 01-infrastructure-foundation P01 | 5 | 2 tasks | 11 files |
| Phase 02-canvas-ical-sync P01 | 7 | 2 tasks | 12 files |
| Phase 02-canvas-ical-sync P02 | 6 | 2 tasks | 8 files |
| Phase 03-twilio-sms-tcpa-compliance P02 | 25 | 1 tasks | 6 files |
| Phase 03 P01 | 417 | 1 tasks | 7 files |
| Phase 03 P03 | 4 | 2 tasks | 5 files |
| Phase 04-claude-ai-daily-briefing P01 | 4 | 2 tasks | 8 files |
| Phase 04-claude-ai-daily-briefing P02 | 9 | 2 tasks | 7 files |
| Phase 05-priority-engine-canonical-timeline-db P01 | 2 | 2 tasks | 6 files |
| Phase 05-priority-engine-canonical-timeline-db P02 | 6 | 2 tasks | 8 files |
| Phase 06-google-oauth-gcal-gmail-alerts-conflict-detection P01 | 5 | 2 tasks | 14 files |
| Phase 06-google-oauth-gcal-gmail-alerts-conflict-detection P02 | 8 | 2 tasks | 3 files |
| Phase 06-google-oauth-gcal-gmail-alerts-conflict-detection P03 | 8 | 2 tasks | 13 files |
| Phase 06-google-oauth-gcal-gmail-alerts-conflict-detection P04 | 6 | 2 tasks | 11 files |
| Phase 06-google-oauth-gcal-gmail-alerts-conflict-detection P05 | 10 | 2 tasks | 10 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- Roadmap: Use Next.js 15.2 (not 14) — async Request API breaking change avoidable now, painful to migrate later
- Roadmap: Use pgvector (Supabase extension) instead of Chroma — eliminates separate Railway service at MVP scale
- Roadmap: Phase 7 (Frontend UI) can begin parallel with Phase 5 — Seb can build against stable Phase 3-4 APIs
- Roadmap: GCal + Gmail watch channel renewal (SYNC-04) ships in Phase 5 alongside initial watch setup — not deferrable
- Roadmap: TCPA compliance (SYNC-02, SMS-04 through SMS-09) ships in Phase 3 with first SMS capability — legal requirement
- [Phase 01-infrastructure-foundation]: No Supabase DB write in tasks.ping — deferred to Phase 2 when real users exist, avoids PING_TEST_USER_ID placeholder
- [Phase 01-infrastructure-foundation]: Dockerfile over Nixpacks for Railway — explicit Python 3.12 version control, no Railway-specific build magic
- [Phase 01-infrastructure-foundation]: Used @supabase/ssr with getClaims() (not deprecated @supabase/auth-helpers or getSession()) for session persistence in Next.js 15 App Router
- [Phase 01-infrastructure-foundation]: server.ts createClient() is async (await cookies()) — required for Next.js 15 async Request API; handle_new_user trigger uses SECURITY DEFINER SET search_path = '' to prevent injection
- [Phase 02-canvas-ical-sync]: icalendar==6.3.2 chosen over 7.0.3 (too new) and ics.py (weaker TZID handling) for Canvas iCal parsing
- [Phase 02-canvas-ical-sync]: All-day DATE events normalized to 23:59:59Z (not midnight UTC) to avoid false overdue status on deadline day
- [Phase 02-canvas-ical-sync]: Diff sensitivity: only due_date changes trigger changed entries; title-only changes silently ignored
- [Phase 02-canvas-ical-sync]: celery_beat uses --schedule=/tmp/celerybeat-schedule to keep generated binary out of source tree
- [Phase 02-canvas-ical-sync]: mark_synced is last call in canvas_sync_user — synced_at only written after apply_diff succeeds
- [Phase 02-canvas-ical-sync]: celery_beat service has no SUPABASE_URL — Beat only dispatches tasks, workers execute them
- [Phase 03-twilio-sms-tcpa-compliance]: STOP confirmation uses send_sms_direct (not send_sms_safe) — guard would suppress required opt-out confirmation
- [Phase 03-twilio-sms-tcpa-compliance]: SMS keyword dispatch: exact set-lookup after body.strip().upper() — no regex or NLP, required for CTIA carrier compliance
- [Phase 03-01]: conftest.py adds celery_worker root to sys.path for pytest — required because @patch() resolves module paths at collection time, not runtime
- [Phase 03-01]: Midnight-spanning quiet window uses OR logic: (local_time >= qs) or (local_time < qe) — naive range check always evaluates False for overnight windows
- [Phase 03-03]: Celery task receives user_id (UUID) not phone — webhook looks up user before enqueueing to avoid PII in Redis
- [Phase 03-03]: phone added to _get_user_sms_state select so process_inbound_sms can retrieve it without a second DB call
- [Phase 04-01]: Snoozed deadline filtering done in Python after Supabase query — supabase-py v2 lacks native timestamp comparison filter for snoozed_until > now
- [Phase 04-01]: generate_briefing takes no conversation_history param — briefing personalization from conversation context deferred per CONTEXT.md; reply handler owns conversation history
- [Phase 04-01]: Timezone-aware date comparison uses local date for days_until calculation — prevents off-by-one errors with Canvas all-day events stored as 23:59:59 UTC
- [Phase 04-claude-ai-daily-briefing]: Off-topic SMS handled with OFF_TOPIC_RESPONSE constant (no second Claude call) — saves latency and cost on non-deadline messages
- [Phase 04-claude-ai-daily-briefing]: build_history_messages deduplicates consecutive same-role messages — prevents invalid alternating-role violations in Claude messages API
- [Phase 04-claude-ai-daily-briefing]: welcome_briefing.delay called AFTER mark_synced — first sync state is confirmed before triggering welcome
- [Phase 04-claude-ai-daily-briefing]: process_inbound_sms uses is_proactive=False for reply sends — bypasses daily proactive cap for user-initiated conversations
- [Phase 05-priority-engine-canonical-timeline-db]: score_event() returns int (round(raw * 100)) stored as 0-100 integer for clean DB queries and delivery threshold comparisons
- [Phase 05-priority-engine-canonical-timeline-db]: compute_urgency clamp: days_remaining <= 0 (including exactly 0) returns 1.0 — due-today events get max urgency
- [Phase 05-priority-engine-canonical-timeline-db]: ingest_canonical_event uses lazy import for send_priority_alert to avoid circular dependency (tasks.py imports from priority)
- [Phase 05-priority-engine-canonical-timeline-db]: get_events_for_briefing appends due_date/course shim keys — generate_briefing remains unchanged, transition is backwards-compatible
- [Phase 05-priority-engine-canonical-timeline-db]: backfill_canonical_events_user uses skip_routing=True to prevent alert spam for pre-existing deadlines on Phase 5 deploy
- [Phase 06-google-oauth-gcal-gmail-alerts-conflict-detection]: Celery task is the encryption boundary for OAuth tokens — plaintext only in Next.js memory and transient Redis queue, encrypted before any Supabase write
- [Phase 06-google-oauth-gcal-gmail-alerts-conflict-detection]: HMAC state in httpOnly oauth_state cookie for stateless CSRF protection — no DB round-trip needed on OAuth initiation
- [Phase 06-google-oauth-gcal-gmail-alerts-conflict-detection]: Study preference interception before Claude intent extraction — no second LLM call for a 1-word answer
- [Phase 06-google-oauth-gcal-gmail-alerts-conflict-detection]: SMS-10/SMS-11 enforced via batch queue: all priority alerts enqueue then flush after 600s countdown; SETNX lock for atomic first-enqueuer detection; event marked sent at enqueue not flush to prevent priority router re-dispatch
- [Phase 06-google-oauth-gcal-gmail-alerts-conflict-detection]: Patch at gcal.auth.build_gcal_service (not gcal.fetch) for lazy import mocking — attribute only exists on source module
- [Phase 06-google-oauth-gcal-gmail-alerts-conflict-detection]: X-Goog-Channel-Token set to user_id during watch setup — stateless push routing without DB lookup
- [Phase 06-google-oauth-gcal-gmail-alerts-conflict-detection]: detect_conflicts_user registered as stub task now — allows gcal_sync_user to chain immediately; Plan 05 replaces stub
- [Phase 06-google-oauth-gcal-gmail-alerts-conflict-detection]: rapidfuzz token_set_ratio threshold=70 for email-deadline fuzzy matching — allows partial title matches while rejecting unrelated subjects
- [Phase 06-google-oauth-gcal-gmail-alerts-conflict-detection]: Gmail watch renewal piggybacks on existing renew_watch_channels Beat task — no new Beat schedule entry needed
- [Phase 06-google-oauth-gcal-gmail-alerts-conflict-detection]: Patch ai.db._get_supabase not gcal.conflicts._get_supabase in conflict tests — lazy import means attribute only exists on source module
- [Phase 06-google-oauth-gcal-gmail-alerts-conflict-detection]: gcal_context enrichment gated by is_monday in generate_briefing — avoids cluttering daily briefings with conflict data
- [Phase 06-google-oauth-gcal-gmail-alerts-conflict-detection]: Study windows computed deterministically from calendar_events (not Claude API call) for Monday briefing enrichment

### Pending Todos

None yet.

### Blockers/Concerns

- Google OAuth app verification (Gmail readonly is a sensitive scope) can take 1–6 weeks. Start the Google Cloud Console verification request before Phase 5 begins, ideally during Phase 3.
- Verify `claude-haiku-4-5-20251001` is a valid model string before Phase 5 implementation. Use `anthropic.models.list()`.
- Confirm Vercel function timeout limit (Hobby vs Pro plan) before Phase 3 deployment — affects error handling on webhook paths.

## Session Continuity

Last session: 2026-03-20T03:30:46.360Z
Stopped at: Completed 06-05-PLAN.md
Resume file: None
