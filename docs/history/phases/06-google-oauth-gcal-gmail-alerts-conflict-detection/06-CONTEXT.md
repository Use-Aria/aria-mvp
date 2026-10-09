# Phase 6: Google OAuth + GCal + Gmail + Alerts + Conflict Detection - Context

**Gathered:** 2026-03-20
**Status:** Ready for planning

<domain>
## Phase Boundary

Connect Google account via OAuth once; ingest Google Calendar events (7-day rolling window) and Gmail signals (.edu senders); fire deadline-change alerts within 15 minutes; detect Canvas deadline vs. GCal conflicts; implement SMS batching; enrich the Monday extended briefing with conflicts and available study windows. All ingested events write to `canonical_events` via the existing `ingest_canonical_event()` entry point from Phase 5.

Out of scope: syllabus parsing, study gap analysis (Phase 7), onboarding UI (Phase 8 / Seb).

</domain>

<decisions>
## Implementation Decisions

### Gmail Sender Identification
- Monitor all senders with `.edu` email domains (catches yale.edu, mit.edu, etc.) — no user-provided professor list required
- When a `.edu` email arrives, Claude Haiku reads subject + body snippet and outputs JSON: `{is_deadline_change: bool, confidence: float}`
- **Alert threshold:** `confidence >= 0.8 AND is_deadline_change = true` → fire alert; everything else logged as metadata only in `gmail_flags` table
- `gmail_flags` schema: `subject`, `sender`, `flagged_at`, `summary` — full email content never stored
- Cross-reference (GMAI-05): fuzzy-match email subject against `deadlines.title`/`deadlines.course` for the user; if a match exists and the email implies a different due date, fire ALRT-02 with both dates surfaced

### Google OAuth Entry Point
- Phase 6 delivers a magic-link flow: Aria sends an SMS containing a `/api/auth/google?user_id=...` URL; user taps on mobile → standard Google OAuth flow → tokens stored
- Backend route: `/api/auth/google` (Next.js) handles OAuth initiation and `/api/auth/google/callback` handles token exchange
- On OAuth callback success:
  1. Store access_token + refresh_token encrypted in `integrations` table (platform = 'google')
  2. Kick off immediate GCal backfill task (next 7 days)
  3. Establish Gmail watch channel
  4. Send confirmation SMS: "Google connected! I'll now include your calendar and watch for deadline emails."
- Phase 8 (Seb) wraps the same `/api/auth/google` route with a UI button — no backend changes needed later

### Token Refresh
- Before every GCal or Gmail API call: check if `access_token` expires within 5 minutes; if so, refresh using `refresh_token` and store the new token before proceeding
- Logic inlined in each sync task — no separate Beat job
- Refresh tokens stored encrypted at rest (AES-256 per CLAUDE.md requirement)

### GCal Sync Scope
- Fetch events in 7-day forward rolling window (today → +7 days)
- Skip events the user declined (`responseStatus = 'declined'`) and events marked free (`transparency = 'transparent'`)
- Only "busy" events that actually consume time are ingested into `calendar_events`
- Sync trigger: GCal push notification channel (GCAL-03) — Google calls `/api/gcal/webhook` on any event change; Celery task fires immediately. This is required to meet the 15-minute alert window.
- Push channel auto-renewed via Celery Beat 48 hours before 7-day expiry (SYNC-04)

### Conflict Detection
- **Definition of conflict:** A Canvas deadline's `due_date` falls on the same calendar day as a "busy" GCal event for that user
- **Conflict SMS format:** Warn + offer to add study block. e.g.: "Heads up: your Bio Lab Report is due Thursday, and you have a 3-hour seminar that day. Want me to add a 2-hour study block Wednesday evening?" User replies yes/no.
- **Conflict check timing:** Run after every `canvas_sync_user` AND after every `gcal_sync_user` completes — not just daily
- **Deduplication:** Store a `conflict_alerts` record keyed to `(deadline_id, gcal_event_id)`. Fire once per pair. Re-fire if either deadline date or event date changes.

### GCal Write-Back (Study Blocks — GCAL-05)
- User specifies: title + duration + day (e.g., "add 2 hours for bio pset tomorrow")
- **Time slot selection:** Find gaps ≥ requested duration in waking hours (7am–10pm); prefer the user's stored study-time preference (evening/afternoon/morning from `preferences_json.study_preference`)
- **Default preference:** evening (6–9pm). Aria asks user their preference via SMS when Google OAuth first completes: "Quick question: when do you prefer to study — mornings, afternoons, or evenings?" Reply stored in `preferences_json.study_preference`.
- **Post-create confirmation:** Create event immediately, then SMS: "Done! Added 'Bio Lab Study' 7–9pm tomorrow. Reply 'undo' to remove it." Undo support required.

### SMS Batching (SMS-10, SMS-11)
- Multiple alerts for the same user within 10 minutes are batched into a single SMS
- **Format:** Numbered list sorted by priority score descending. e.g.: "3 updates: 1) Bio Lab Report moved to Friday (was Thursday) 2) Chem PSET extended +1 day 3) Lecture cancelled tomorrow."
- **Implementation:** Redis-based hold queue with 10-minute TTL per user. When an alert fires: check for existing queue in Redis; if present, add to it; if not, start queue + schedule a flush Celery task at TTL expiry. Flush task sends one combined SMS.
- Max 3 texts per 10-minute window (SMS-11) enforced by the same batching layer

### Monday Briefing Enrichment (AI-08 full)
- When GCal is connected, the Monday extended briefing includes:
  1. **Conflict warnings:** "Bio Lab due Thursday — you have Chem seminar (2–5pm) that day."
  2. **Available study windows:** Find gaps ≥ 2 hours in waking hours (7am–10pm) across the 7-day window; rank by user's `study_preference`; surface 2–3 best slots. e.g.: "Tuesday 6–9pm free — good window for the pset."
- Study windows computed deterministically from `calendar_events` table (not via Claude) — same slot-finding logic as the write-back feature

### Claude's Discretion
- Exact Haiku prompt wording for email classification
- Fuzzy match algorithm for Gmail → Canvas title cross-reference (Levenshtein vs. substring)
- Encryption implementation for tokens (library choice, key storage)
- Exact Redis key schema for batch queues
- `conflict_alerts` table schema (new migration)
- Error handling when Gmail watch channel setup fails (silent retry vs. alert)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 6 requirements
- `.planning/REQUIREMENTS.md` §Google Calendar Integration — GCAL-01 through GCAL-05
- `.planning/REQUIREMENTS.md` §Gmail Integration — GMAI-01 through GMAI-05
- `.planning/REQUIREMENTS.md` §Alerts — ALRT-01, ALRT-02, ALRT-03
- `.planning/REQUIREMENTS.md` §Intelligence — INTEL-03 (conflict detection)
- `.planning/REQUIREMENTS.md` §SMS Interface — SMS-10, SMS-11 (batching)
- `.planning/REQUIREMENTS.md` §Sync Engine — SYNC-03, SYNC-04
- `.planning/REQUIREMENTS.md` §Conversational AI — AI-08 (full Monday briefing enrichment)

### Existing patterns to extend
- `celery_worker/priority/ingest.py` — `ingest_canonical_event()` is the shared entry point; Phase 6 GCal/Gmail events call this, not any direct table writes
- `celery_worker/sms/send.py` — `send_sms_alert()` and `send_sms_safe()` — all Phase 6 outbound SMS routes through these
- `celery_worker/tasks.py` — `canvas_sync_all` / `canvas_sync_user` pattern to replicate for `gcal_sync_all` / `gcal_sync_user` and `gmail_watch_all` / `gmail_process_email`
- `celery_worker/celery_app.py` — Beat schedule; Phase 6 adds watch-channel renewal entries
- `supabase/migrations/005_canonical_events.sql` — last migration; Phase 6 adds migration 006

### Architecture constraints
- `CLAUDE.md` — Google OAuth scopes (Calendar + Gmail on single client), token expiry (1 hour, always refresh before calls), Gmail metadata-only policy, model tiers (Haiku for email classification), env var list
- `.planning/phases/05-priority-engine-canonical-timeline-db/05-CONTEXT.md` — `source_authority` values locked (professor email = 0.9), `ingest_canonical_event()` API, `send_sms_alert()` TCPA bypass rules

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `celery_worker/priority/ingest.py::ingest_canonical_event(user_id, source, title, due_at, course_id, grade_weight, skip_routing)` — GCal events call this with `source='gcal'`; Gmail-derived events call with `source='gmail'`
- `celery_worker/ai/db.py::_get_supabase()` — Supabase service-role client; all Phase 6 DB operations use this
- `celery_worker/sms/send.py::_get_user_sms_state()` — fetches phone, timezone, TCPA state; Phase 6 conflict and alert SMS uses this
- `supabase/migrations/001_initial_schema.sql::integrations` table — `platform`, `access_token`, `refresh_token`, `connected_at`, `synced_at` columns already exist; Phase 6 stores Google tokens here

### Established Patterns
- All heavy work in Celery Python — Next.js webhook routes return 200 immediately and enqueue
- Module structure: `celery_worker/[domain]/` — Phase 6 adds `celery_worker/gcal/` and `celery_worker/gmail/` mirroring `celery_worker/canvas/`
- Fan-out pattern: `[integration]_sync_all` dispatches `[integration]_sync_user` per user (see `canvas_sync_all`)
- Beat schedule entries in `celery_app.py`; watch-channel renewal follows the existing `canvas-sync-all-users` pattern
- Timestamps always UTC TIMESTAMPTZ; timezone conversion at render time

### Integration Points
- `/api/gcal/webhook` — new Next.js route for GCal push notifications; returns 200, enqueues Celery task
- `/api/gmail/webhook` — new Next.js route for Gmail push notifications; same pattern
- `/api/auth/google` + `/api/auth/google/callback` — new Next.js OAuth routes; callback stores tokens and triggers immediate sync
- `celery_app.beat_schedule` — needs watch-channel renewal entries (48h before 7-day expiry)
- `ai/briefing.py::generate_briefing()` — Phase 6 passes GCal conflict data and study windows into the briefing prompt for Monday enrichment

</code_context>

<specifics>
## Specific Ideas

- Study time preference question on first Google connect: "Quick question: when do you prefer to study — mornings, afternoons, or evenings?" — conversational, one-reply, stored in `preferences_json.study_preference`
- Study block confirmation SMS: "Done! Added 'Bio Lab Study' 7–9pm tomorrow. Reply 'undo' to remove it." — includes event name, time, and undo option in one message
- Conflict alert format: "Heads up: [assignment] is due [day], and you have [event name] ([duration]) that day. Want me to add a [X]-hour study block [day before] evening?" — includes actionable offer
- Gmail signal alert (ALRT-02) should surface both the Canvas state AND what the email said: "Your professor emailed that [assignment] is due [new date], but Canvas still shows [old date]. Heads up!"

</specifics>

<deferred>
## Deferred Ideas

- **Study gap analysis** — T-5 exam gap analysis requiring syllabus data belongs in Phase 7, not Phase 6
- **Discord integration** — source_authority = 0.6 was set in Phase 5; actual Discord monitoring is post-v1 roadmap
- **GCAL-05 bulk study schedule** — "schedule my whole week of studying" was raised as an idea; single study block per request is Phase 6 scope; bulk scheduling is a future capability

</deferred>

---

*Phase: 06-google-oauth-gcal-gmail-alerts-conflict-detection*
*Context gathered: 2026-03-20*
