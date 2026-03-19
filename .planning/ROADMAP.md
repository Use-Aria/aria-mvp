# Roadmap: Aria

## Overview

Aria is built in seven phases that follow strict dependency order. The data pipeline comes first — no SMS, no AI, no UI until Canvas deadlines can be stored and retrieved. Each phase delivers one independently testable capability: infrastructure that holds state, Canvas sync that captures deadlines, Twilio SMS with full TCPA compliance, Claude briefings that deliver the core value, Google OAuth unlocking Calendar and Gmail signals, syllabus parsing that upgrades briefing quality, and finally the onboarding UI that lets real users connect everything. Seb's frontend work (Phase 7) can begin in parallel once Phase 4 APIs are stable.

## Phases

- [ ] **Phase 1: Infrastructure Foundation** - Supabase schema, Redis, Celery skeleton, Twilio number provisioned — everything else depends on this
- [ ] **Phase 2: Canvas iCal Sync** - Fetch, parse, diff, and store Canvas deadlines every 60 minutes
- [ ] **Phase 3: Twilio SMS + TCPA Compliance** - Send and receive SMS with opt-out, quiet hours, and message cap enforced from day one
- [ ] **Phase 4: Claude AI + Daily Briefing** - Wire Canvas data through Claude Sonnet to produce a daily 8am SMS briefing and handle conversational replies
- [ ] **Phase 5: Google OAuth + Calendar + Gmail + Deadline Alerts** - Connect Google account, ingest calendar and email signals, fire deadline change alerts within 15 minutes
- [ ] **Phase 6: Syllabus Parsing** - Upload PDFs, parse with Claude Opus, store structured JSON, enrich briefings with grade weights
- [ ] **Phase 7: User Onboarding + Frontend UI** - Onboarding flow, syllabus upload UI, preferences, and connection status pages (Seb owns this phase)

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
**Plans:** 1/2 plans executed
Plans:
- [ ] 01-01-PLAN.md — Next.js scaffold, Supabase schema + Auth + RLS, health endpoint, SMS webhook stub
- [ ] 01-02-PLAN.md — Celery worker + Redis, Docker Compose, ping smoke-test task

### Phase 2: Canvas iCal Sync
**Goal**: Users' Canvas deadlines are continuously fetched, normalized, and stored — the product has something to brief about
**Depends on**: Phase 1
**Requirements**: CANV-01, CANV-02, CANV-03, CANV-04, CANV-05
**Success Criteria** (what must be TRUE):
  1. Given a Canvas iCal URL, all VEVENT records are fetched and stored in the `deadlines` table as Task-typed records with correct due dates in the user's timezone
  2. The sync job runs every 60 minutes per user without manual trigger, confirmed by `synced_at` advancing in Supabase
  3. When a deadline is added, modified, or removed in Canvas, the diff engine detects the change within one sync cycle (60 minutes)
  4. A Canvas feed that returns a rate-limit error is retried with exponential backoff and does not crash the worker
**Plans:** 1/2 plans executed
Plans:
- [ ] 02-01-PLAN.md — TDD: iCal fetch, parse, and diff modules with pytest
- [ ] 02-02-PLAN.md — DB layer, Celery tasks + Beat, Docker Compose, trigger route

### Phase 3: Twilio SMS + TCPA Compliance
**Goal**: The system can send and receive SMS with every TCPA-required safeguard active before the first outbound message ever leaves
**Depends on**: Phase 2
**Requirements**: SMS-01, SMS-02, SMS-03, SMS-04, SMS-05, SMS-06, SMS-07, SMS-08, SMS-09, SYNC-02
**Success Criteria** (what must be TRUE):
  1. An outbound SMS sent via Twilio is received on a test phone number within 30 seconds
  2. An inbound SMS to the Twilio number triggers the webhook, returns HTTP 200 in under 1 second, and the message appears in the `messages` table — no Claude call happens synchronously
  3. Texting STOP immediately sets `sms_opted_out: true` in the database; the next scheduled outbound SMS to that user is suppressed even if the carrier-level opt-out has not propagated
  4. No SMS is sent between 10pm and 8am in the user's local timezone; the 3 unsolicited messages/day cap is enforced regardless of trigger source
  5. PAUSE suspends delivery for 24 hours; HELP returns the command list
**Plans**: TBD

### Phase 4: Claude AI + Daily Briefing
**Goal**: Canvas data flows through Claude Sonnet and arrives as a readable morning SMS — users receive value on day one without waiting 18 hours
**Depends on**: Phase 3
**Requirements**: AI-04, AI-05, AI-06, AI-07, AUTH-07, SYNC-05, SYNC-06
**Success Criteria** (what must be TRUE):
  1. At 8am in the user's local timezone, an SMS arrives summarizing their upcoming deadlines (scanned in under 10 seconds, 3-5 items maximum)
  2. Within 60 seconds of completing onboarding, the user receives a welcome briefing SMS (cold-start)
  3. Replying "what's due this week?" to Aria produces a relevant, accurate SMS reply within 10 seconds
  4. Briefing generation uses only the last 14 days of deadlines and 7 days of calendar; no prompt exceeds 80% of the model's context limit
  5. The daily briefing Celery job runs at 7am per user timezone and the exam countdown check runs at 7am daily
**Plans**: TBD

### Phase 5: Google OAuth + Calendar + Gmail + Deadline Alerts
**Goal**: Users connect their Google account once and Aria starts detecting deadline changes from both Calendar and professor emails, firing alerts within 15 minutes
**Depends on**: Phase 4
**Requirements**: GCAL-01, GCAL-02, GCAL-03, GCAL-04, GCAL-05, GMAI-01, GMAI-02, GMAI-03, GMAI-04, GMAI-05, ALRT-01, ALRT-02, ALRT-03, SYNC-03, SYNC-04
**Success Criteria** (what must be TRUE):
  1. A user can connect their Google account via OAuth; the access token and refresh token are stored encrypted in Supabase and the refresh token is rotated on use
  2. When a Canvas deadline changes, the user receives an SMS alert within 15 minutes that includes the original deadline, new deadline, course name, and assignment title
  3. When a professor email contains keywords indicating a deadline change, an SMS alert fires and the signal is cross-referenced against the current Canvas state
  4. Google Calendar events from a 7-day rolling window appear in the `calendar_events` table and are included in the next morning briefing
  5. GCal push channels and Gmail watch channels are renewed automatically before their 7-day expiry; no manual intervention is needed
**Plans**: TBD

### Phase 6: Syllabus Parsing
**Goal**: Users can upload a course syllabus and Aria extracts exam dates, assignment weights, and topics — briefings become grade-aware
**Depends on**: Phase 5
**Requirements**: AI-01, AI-02, AI-03
**Success Criteria** (what must be TRUE):
  1. A user can upload a syllabus PDF via the web UI and receive a confirmation that parsing has started
  2. Claude Opus extracts exams, assignment types, grade weights, and key topics from the PDF; the result is stored as structured JSON in the `syllabi` table (raw PDF in Supabase Storage)
  3. The next morning briefing after a syllabus is parsed includes grade weight context (e.g., "PSET 3 — 15% of grade")
  4. A PDF is never re-parsed on subsequent briefing requests; the stored `parsed_json` is reused
**Plans**: TBD

### Phase 7: User Onboarding + Frontend UI
**Goal**: A new user can go from zero to receiving their first briefing SMS in under 5 minutes using a web UI — the backend pipeline is accessible without Supabase console access
**Depends on**: Phase 4 (can begin parallel with Phase 5)
**Requirements**: AUTH-02, AUTH-03, AUTH-05, AUTH-06, UI-01, UI-02, UI-03, UI-04, UI-05
**Success Criteria** (what must be TRUE):
  1. A new user completes onboarding (phone verification, Canvas iCal URL entry, Google OAuth connect) in under 5 minutes and receives a welcome briefing SMS at completion
  2. A user can upload a syllabus PDF from the onboarding or preferences UI with visible upload progress and a success confirmation
  3. The preferences page lets a user update quiet hours and notification frequency; changes take effect on the next outbound SMS
  4. The connection status page shows live health indicators for Google and Canvas integrations (connected / disconnected / needs re-auth)
  5. The first briefing preview page shows what the user's first briefing will contain before it sends
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 (Phase 7 can begin parallel with Phase 5)

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Infrastructure Foundation | 1/2 | In Progress|  |
| 2. Canvas iCal Sync | 1/2 | In Progress|  |
| 3. Twilio SMS + TCPA Compliance | 0/TBD | Not started | - |
| 4. Claude AI + Daily Briefing | 0/TBD | Not started | - |
| 5. Google OAuth + Calendar + Gmail + Deadline Alerts | 0/TBD | Not started | - |
| 6. Syllabus Parsing | 0/TBD | Not started | - |
| 7. User Onboarding + Frontend UI | 0/TBD | Not started | - |
