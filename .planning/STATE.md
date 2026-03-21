---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: unknown
stopped_at: Completed 07-syllabus-parsing-study-gap-detection/07-02-PLAN.md
last_updated: "2026-03-21T16:54:12.606Z"
progress:
  total_phases: 9
  completed_phases: 9
  total_plans: 26
  completed_plans: 26
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

See: .planning/PROJECT.md (updated 2026-03-21)

**Core value:** Students don't have a productivity problem — they have a fragmentation problem. Aria is the first layer that sees everything simultaneously and acts on it proactively.
**Current focus:** v1.0 milestone archived — planning next milestone

## Current Position

Phase: 09 (todoist-integration) — COMPLETE
All 9 phases complete

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
| Phase 07-syllabus-parsing-study-gap-detection P01 | 3 | 2 tasks | 6 files |
| Phase 07 P02 | 4 | 2 tasks | 6 files |
| Phase 08-ios-app-onboarding P01 | 683 | 2 tasks | 29 files |
| Phase 08-ios-app-onboarding P02 | 15 | 2 tasks | 7 files |
| Phase 08-ios-app-onboarding P03 | 226 | 2 tasks | 3 files |
| Phase 08-ios-app-onboarding P04 | 25 | 2 tasks | 7 files |
| Phase 08-ios-app-onboarding P05 | 8 | 2 tasks | 7 files |
| Phase 09-todoist-integration P03 | 8 | 1 tasks | 2 files |
| Phase 09-todoist-integration P01 | 12 | 2 tasks | 12 files |
| Phase 09-todoist-integration P02 | 18 | 2 tasks | 4 files |

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
- [Phase 07-01]: check_existing_syllabus uses .not_.is_('parsed_json', 'null') query to implement never-re-parse guard — skips Claude call if row already has parsed data
- [Phase 07-01]: parse_syllabus_pdf strips markdown code fences before json.loads — Claude Opus occasionally wraps JSON in fences despite instructions
- [Phase 07-01]: POST /api/upload/syllabus accepts user_id from FormData (Phase 7 bypass) — replaced with Supabase session in Phase 8 when auth UI is built
- [Phase 07-01]: PDF bytes are never persisted — only base64 string passes through transient Redis queue
- [Phase 07-02]: get_syllabus_context fetches all user syllabi in one query then does Python-side partial matching — avoids N Supabase calls per deadline loop
- [Phase 07-02]: gap_analysis_all_users targets full UTC calendar day range for T-5 detection — robust for all-day events stored as 23:59:59Z
- [Phase 08-ios-app-onboarding]: Excluded src/ template directory from tsconfig — SDK 55 template uses src/app but plan specifies mobile/app
- [Phase 08-ios-app-onboarding]: Added @types/jest and types:[jest] in tsconfig — required for jest globals in mock and test files
- [Phase 08-ios-app-onboarding]: ThemeContextType.colors typed as union (COLORS.light | COLORS.dark) — literal string types differ between light and dark palettes
- [Phase 08-ios-app-onboarding]: CanvasUrlInput client-side regex delegates format error to canvas.tsx screen — component always calls onValidate, parent owns regex check and error state
- [Phase 08-ios-app-onboarding]: PinInput uses individual TextInput refs per cell (not masked input) for precise focus control per iOS UX guidelines
- [Phase 08-ios-app-onboarding]: canvas.tsx uses Promise.race with 10-second timeout for validateCanvasUrl to surface network failures as unreachable error variant
- [Phase 08-ios-app-onboarding]: Google provider_token NOT stored client-side — ExpoSecureStore 2KB limit causes silent failures; backend stores via Supabase auth webhook
- [Phase 08-ios-app-onboarding]: TCPA has_alert_consent written as explicit false (not omitted) when OFF — Phase 5 send_sms_alert reads this field to distinguish declined from unset
- [Phase 08-ios-app-onboarding]: router.replace (not push) on Enter Aria — removes onboarding stack so user cannot swipe back after completing onboarding
- [Phase 08-ios-app-onboarding]: Zone 4 in home/index.tsx is a 64px spacer View — Plan 05 replaces with real ChatBar component
- [Phase 08-ios-app-onboarding]: DeadlineCard onDone/onSnooze are UI-only with TODO comments — no backend task completion or snooze routes in Phase 8
- [Phase 08-ios-app-onboarding]: Urgency score field absent from DeadlineCard — deferred to Phase 9 post Phase 6 canonical_events integration
- [Phase 08-ios-app-onboarding]: ChatBar VoiceButton opens sheet on voice result but does not auto-send — ChatSheet owns send pipeline; voice in ChatSheet auto-sends directly
- [Phase 08-ios-app-onboarding]: SafeAreaView in home/index.tsx uses edges=[top,left,right] omitting bottom — ChatBar handles its own bottom padding via useSafeAreaInsets
- [Phase 09-03]: Todoist access_token upserted with onConflict: 'user_id,platform' — re-auth overwrites old token without creating duplicate rows
- [Phase 09-03]: redirect_uri uses NEXT_PUBLIC_APP_URL env var — supports both dev (localhost:3000) and production Vercel URL without code change
- [Phase 09-todoist-integration]: todoist/db.py wraps ai.db._get_supabase via local proxy to avoid module-level import failure in test environments
- [Phase 09-todoist-integration]: todoist_sync_user uses autoretry_for=(Exception,) — 403 is caught in sync_todoist_user and returns gracefully, preventing infinite retry on revoked tokens
- [Phase 09-todoist-integration]: test_sync.py injects stub priority.ingest via sys.modules — priority/ingest.py uses str|None (Python 3.10+) which fails at import time on system Python 3.9 test runner
- [Phase 09-todoist-integration]: Lazy imports in _apply_todoist_mutation preserve todoist.db/fetch patch targets for unit tests
- [Phase 09-todoist-integration]: from __future__ import annotations added to replies.py and briefing.py for Python 3.9 test runner compatibility

### Pending Todos

None yet.

### Blockers/Concerns

- Google OAuth app verification (Gmail readonly is a sensitive scope) can take 1–6 weeks. Start the Google Cloud Console verification request if not already done.
- Confirm Vercel function timeout limit (Hobby vs Pro plan) before Phase 3 deployment — affects error handling on webhook paths.
- Phase 7 requires PDF upload endpoint (Next.js API route) — confirm Vercel 4.5MB body size limit is sufficient for typical syllabus PDFs.

## Session Continuity

Last session: 2026-03-21T02:40:03.234Z
Stopped at: Completed 07-syllabus-parsing-study-gap-detection/07-02-PLAN.md
Resume file: None
