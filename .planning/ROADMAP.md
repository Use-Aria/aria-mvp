# Roadmap: Aria

## Overview

Aria is built in nine phases that follow strict dependency order. The data pipeline comes first — no SMS, no AI, no UI until Canvas deadlines can be stored and retrieved. Each phase delivers one independently testable capability: infrastructure, Canvas sync, Twilio SMS, Claude briefings, a priority-scored event engine, Google integrations + alerts, syllabus intelligence + study gap detection, the full iOS app + onboarding, and finally Todoist task sync. Seb's iOS work (Phase 8) can begin in parallel once Phase 4 APIs are stable.

## Phases

- [x] **Phase 1: Infrastructure Foundation** - Supabase schema, Redis, Celery skeleton, Twilio number provisioned (completed 2026-03-18)
- [x] **Phase 2: Canvas iCal Sync** - Fetch, parse, diff, and store Canvas deadlines every 60 minutes (completed 2026-03-19)
- [x] **Phase 3: Twilio SMS + TCPA Compliance** - Send and receive SMS with opt-out, quiet hours, and message cap enforced from day one (completed 2026-03-19)
- [x] **Phase 4: Claude AI + Daily Briefing** - Wire Canvas data through Claude Sonnet for daily SMS briefings, Monday extended briefing, conversational replies, task management, and exam countdown (completed 2026-03-19)
- [ ] **Phase 5: Priority Engine + Canonical Timeline DB** - Unified event scoring and delivery routing — all Phase 6+ integrations write to Canonical Store; events scored and routed by priority
- [ ] **Phase 6: Google OAuth + GCal + Gmail + Alerts + Conflict Detection** - Connect Google account, ingest calendar and email, fire deadline alerts within 15 minutes, detect conflicts
- [ ] **Phase 7: Syllabus Parsing + Study Gap Detection** - Upload PDFs, parse with Claude Opus, extract exam topics + grade weights, run gap analysis before exams
- [x] **Phase 8: iOS App + Onboarding** - Full 4-zone iOS card dashboard, in-app chat, voice input, onboarding flow (Seb leads) (completed 2026-03-20)
- [ ] **Phase 9: Todoist Integration** - Todoist OAuth, task read/write, tasks in briefings and scheduling

## Phase Details

### Phase 1: Infrastructure Foundation
**Goal**: The data layer, job queue, and deployment targets exist and are verified — every subsequent phase can write data, enqueue jobs, and send messages
**Depends on**: Nothing (first phase)
**Requirements**: SYNC-01, AUTH-01, AUTH-04
**Success Criteria** (what must be TRUE):
  1. A test record can be written to each Supabase core table (users, integrations, deadlines, syllabi, calendar_events, tasks, messages) with row-level security enforced
  2. A Celery worker on Railway accepts and executes a test task via Redis broker
  3. A Twilio phone number is provisioned and can receive an inbound SMS in the Railway environment
  4. Environment variables for all services are documented and confirmed non-empty in Vercel + Railway
  5. A user can create an account and their session persists across browser refresh (Supabase Auth)
**Plans:** 2/2 complete
Plans:
- [x] 01-01-PLAN.md — Next.js scaffold, Supabase schema + Auth + RLS, health endpoint, SMS webhook stub
- [x] 01-02-PLAN.md — Celery worker + Redis, Docker Compose, ping smoke-test task

### Phase 2: Canvas iCal Sync
**Goal**: Users' Canvas deadlines are continuously fetched, normalized, and stored — the product has something to brief about
**Depends on**: Phase 1
**Requirements**: CANV-01, CANV-02, CANV-03, CANV-04, CANV-05
**Success Criteria** (what must be TRUE):
  1. Given a Canvas iCal URL, all VEVENT records are fetched and stored in the `deadlines` table as Task-typed records with correct due dates in the user's timezone
  2. The sync job runs every 60 minutes per user without manual trigger, confirmed by `synced_at` advancing in Supabase
  3. When a deadline is added, modified, or removed in Canvas, the diff engine detects the change within one sync cycle (60 minutes)
  4. A Canvas feed that returns a rate-limit error is retried with exponential backoff and does not crash the worker
**Plans:** 2/2 complete
Plans:
- [x] 02-01-PLAN.md — TDD: iCal fetch, parse, and diff modules with pytest
- [x] 02-02-PLAN.md — DB layer, Celery tasks + Beat, Docker Compose, trigger route

### Phase 3: Twilio SMS + TCPA Compliance
**Goal**: The system can send and receive SMS with every TCPA-required safeguard active before the first outbound message ever leaves
**Depends on**: Phase 2
**Requirements**: SMS-01, SMS-02, SMS-03, SMS-04, SMS-05, SMS-06, SMS-07, SMS-08, SMS-09, SYNC-02
**Success Criteria** (what must be TRUE):
  1. An outbound SMS sent via Twilio is received on a test phone number within 30 seconds
  2. An inbound SMS to the Twilio number triggers the webhook, returns HTTP 200 in under 1 second, and the message appears in the `messages` table — no Claude call happens synchronously
  3. Texting STOP immediately sets `sms_opted_out: true` in the database; the next scheduled outbound SMS to that user is suppressed
  4. No SMS is sent between 10pm and 8am in the user's local timezone; the 3 unsolicited messages/day cap is enforced regardless of trigger source
  5. PAUSE suspends delivery for 24 hours; HELP returns the command list
**Plans:** 3/3 complete
Plans:
- [x] 03-01-PLAN.md — TDD: TCPA migration + send_sms_safe() centralized guard
- [x] 03-02-PLAN.md — TDD: STOP/START/PAUSE/HELP command dispatch
- [x] 03-03-PLAN.md — Webhook upgrade + process_inbound_sms task + SYNC-02 verification

### Phase 4: Claude AI + Daily Briefing
**Goal**: Canvas data flows through Claude Sonnet and arrives as a readable morning SMS — users receive value on day one without waiting 18 hours
**Depends on**: Phase 3
**Requirements**: SMS-03, AI-04, AI-05, AI-06, AI-07, AI-08 (partial), AI-09, AI-11, AUTH-07, CONV-01, SYNC-05, SYNC-06
**Success Criteria** (what must be TRUE):
  1. At 8am in the user's local timezone, an SMS arrives summarizing their upcoming deadlines in conversational prose (smart-friend tone, max 800 chars)
  2. On Monday, the briefing covers the full 7-day horizon with exam topic stubs and daily load score
  3. Within 60 seconds of saving a Canvas iCal URL, the user receives a welcome briefing SMS
  4. Replying "what's due this week?" produces a relevant SMS reply within 10 seconds, with last 5 exchanges as context
  5. Users can mark tasks complete, snooze, and set priority via SMS; Aria resolves ambiguous matches to soonest-due
  6. Exam countdown fires at T-7, T-5 (stub), T-3, T-1, and day-of; all bundled into daily briefing
  7. Daily load score (green/yellow/red) computed and included in briefing
**Plans:** 2/2 plans complete
Plans:
- [ ] 04-01-PLAN.md — Schema migration + AI module skeleton + briefing generator with load score and exam countdown
- [ ] 04-02-PLAN.md — Conversational reply handler + Celery task wiring (Beat schedule, fan-out, welcome briefing, inbound SMS)

### Phase 5: Priority Engine + Canonical Timeline DB
**Goal**: All events from all integrations are scored by a unified priority formula and routed to the right delivery channel — the intelligence backbone that Phase 6+ integrations write to
**Depends on**: Phase 4
**Requirements**: PRIO-01, PRIO-02, PRIO-03
**Success Criteria** (what must be TRUE):
  1. All existing Canvas deadlines are migrated into the Canonical Timeline DB with source, type, title, due_at, course_id, and grade_weight fields
  2. Every event has a computed priority score using `(grade_weight × 0.35) + (urgency × 0.45) + (source_authority × 0.20)`; urgency decays exponentially by days remaining
  3. Events scoring ≥ 80 trigger an immediate outbound SMS within 60 seconds of ingestion
  4. Events scoring 50–79 appear in the next morning digest; events scoring < 50 are logged silently
  5. Phase 6 GCal and Gmail integrations write to the Canonical Store and receive priority scores on ingestion
**Plans:** 2 plans
Plans:
- [ ] 05-01-PLAN.md — TDD: Priority scoring engine + delivery router (pure Python)
- [ ] 05-02-PLAN.md — Migration 005, ingest entry point, canvas_sync wiring, backfill, briefing switchover

### Phase 6: Google OAuth + GCal + Gmail + Alerts + Conflict Detection
**Goal**: Users connect their Google account once and Aria starts detecting deadline changes from Calendar and professor emails, firing alerts within 15 minutes; conflicts flagged; SMS batching enforced
**Depends on**: Phase 5
**Requirements**: GCAL-01, GCAL-02, GCAL-03, GCAL-04, GCAL-05, GMAI-01, GMAI-02, GMAI-03, GMAI-04, GMAI-05, ALRT-01, ALRT-02, ALRT-03, INTEL-03, SMS-10, SMS-11, SYNC-03, SYNC-04, AI-08 (full)
**Success Criteria** (what must be TRUE):
  1. A user connects Google via OAuth; tokens stored encrypted in Supabase with refresh rotation
  2. When a Canvas deadline changes, an SMS alert fires within 15 minutes with original deadline, new deadline, course name, and assignment title
  3. When a professor email signals a deadline change, an SMS alert fires and is cross-referenced against Canvas state
  4. GCal events appear in the `calendar_events` table; Monday extended briefing includes GCal conflicts and available study windows
  5. Multiple alerts within 10 minutes are batched into a single SMS; no more than 3 texts in any 10-minute window
  6. When a Canvas deadline overlaps an existing GCal commitment, Aria flags the conflict and offers resolution via SMS
  7. GCal push channels and Gmail watch channels are renewed automatically before 7-day expiry
**Plans**: TBD

### Phase 7: Syllabus Parsing + Study Gap Detection
**Goal**: Users can upload course syllabi and Aria extracts exam topics, grade weights, and coverage — briefings become grade-aware and T-5 gap analysis becomes functional
**Depends on**: Phase 6
**Requirements**: AI-01, AI-02, AI-03, AI-10, INTEL-01
**Success Criteria** (what must be TRUE):
  1. A user uploads a syllabus PDF and Claude Opus extracts exams, assignment types, grade weights, and key topics; stored as structured JSON in the `syllabi` table
  2. The next morning briefing after a syllabus is parsed includes grade weight context (e.g., "PSET 3 — 15% of grade")
  3. At T-5 days before an exam, Aria generates a study gap analysis — a prioritized list of uncovered topics ranked by exam weight
  4. A PDF is never re-parsed; `parsed_json` is reused on every subsequent briefing request
  5. Monday extended briefing includes exam topic coverage summaries from parsed syllabi
**Plans**: TBD

### Phase 8: iOS App + Onboarding
**Goal**: A new user can complete onboarding and access a full-featured iOS app with card dashboard, in-app chat, and voice — Seb leads; can begin parallel with Phase 6
**Depends on**: Phase 4 (APIs stable)
**Requirements**: AUTH-02, AUTH-03, AUTH-05, AUTH-06, UI-01, UI-02, UI-03, UI-04, UI-05, UI-06, UI-07, UI-08, UI-09
**Success Criteria** (what must be TRUE):
  1. A new user completes onboarding (phone verify, Canvas URL, Google OAuth) in under 5 minutes and receives a welcome briefing at completion
  2. The iOS home screen renders all 4 zones: pinned quick-access (To-Do, Calendar, Notifications), color-coded daily load status bar, scrollable card grid, persistent chat + voice bar
  3. In-app chat connects to same Aria backend as SMS; all SMS commands work via in-app chat; conversation threads are independent
  4. Voice input transcribes via on-device speech recognition and routes through the same Claude pipeline as typed messages
  5. Cards can be dragged to reorder, swiped to hide, tapped to expand; accent color and dark mode configurable
  6. First briefing preview page shows what the user's first briefing will contain before it sends
**Plans:** 5/5 plans complete
Plans:
- [ ] 08-01-PLAN.md — Expo SDK 55 scaffold, Supabase client + ExpoSecureStoreAdapter, theme system, root layout, Jest setup
- [ ] 08-02-PLAN.md — Onboarding screens 1-4: Welcome, Phone, PIN verify, Canvas URL validation
- [ ] 08-03-PLAN.md — Onboarding screens 5-7: Google OAuth with nonce, TCPA consent, briefing preview
- [ ] 08-04-PLAN.md — 4-zone home screen: QuickAccessBar, LoadStatusBar, CardGrid with drag/swipe/expand
- [ ] 08-05-PLAN.md — In-app chat + voice input + Preferences page (accent, integrations, syllabus upload)

### Phase 9: Todoist Integration
**Goal**: Students can connect Todoist and have personal tasks incorporated into briefings, priority scoring, and scheduling recommendations
**Depends on**: Phase 5 (Priority Engine must exist for task scoring)
**Requirements**: TASK-01, TASK-02
**Success Criteria** (what must be TRUE):
  1. User connects Todoist via OAuth; access token stored encrypted; tasks synced every 2 hours
  2. Todoist tasks appear in daily briefings alongside Canvas deadlines; P1 tasks have source_authority = 0.8 in the Priority Engine
  3. User can create, complete, and update Todoist tasks via SMS command
  4. Task overload detection: if P1 tasks + Canvas deadlines exceed a threshold, Aria warns in the morning briefing
**Plans:** 2/3 plans executed
Plans:
- [ ] 09-01-PLAN.md — Todoist backend modules (fetch/parse/db/sync) + Celery tasks + Beat schedule
- [ ] 09-02-PLAN.md — SMS CRUD via Claude intent + overload detection in briefing
- [ ] 09-03-PLAN.md — OAuth callback route + iOS Preferences Todoist button

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 9 (Phase 8 can begin parallel with Phase 6)

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Infrastructure Foundation | 2/2 | Complete | 2026-03-18 |
| 2. Canvas iCal Sync | 2/2 | Complete | 2026-03-19 |
| 3. Twilio SMS + TCPA Compliance | 3/3 | Complete | 2026-03-19 |
| 4. Claude AI + Daily Briefing | 2/2 | Complete   | 2026-03-19 |
| 5. Priority Engine + Canonical Timeline DB | 0/2 | Planning complete | - |
| 6. Google OAuth + GCal + Gmail + Alerts | 0/TBD | Not started | - |
| 7. Syllabus Parsing + Study Gap Detection | 0/TBD | Not started | - |
| 8. iOS App + Onboarding | 5/5 | Complete    | 2026-03-20 |
| 9. Todoist Integration | 2/3 | In Progress|  |
