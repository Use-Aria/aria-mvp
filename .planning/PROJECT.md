# Aria

## What This Is

Aria is a proactive AI personal assistant for college students that unifies academic life — Canvas deadlines, syllabus topics, personal tasks, and schedule — into one intelligent layer that communicates via SMS. No new app to open. Students get a smart assistant that lives in their messages and knows their schedule better than they do.

**Builders:** Josh Shin (backend) & Sebastian Alvaro Cuervo (frontend)
**Target users:** Yale students — closed beta targeting 50 users in 30 days post-launch
**MVP target:** March 19, 2026

## Core Value

Students never miss a deadline or lose track of their week — Aria surfaces what matters, when it matters, over SMS.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Canvas iCal sync — fetch assignments/exams, diff for changes, store in Supabase
- [ ] Google Calendar integration — OAuth, read/write events, push notifications
- [ ] Twilio SMS layer — outbound briefings, inbound reply handling with Claude
- [ ] Syllabus PDF parsing — Claude Opus parses uploads, stores structured JSON
- [ ] Weekly briefing generation — Claude Sonnet synthesizes data into Monday 8am SMS
- [ ] Deadline change alerts — detect Canvas diffs, fire SMS alert within 15 min
- [ ] User onboarding — phone capture, Canvas iCal URL, Google OAuth, SMS verification
- [ ] Background sync engine — Celery + Redis, Canvas every 60 min, GCal real-time
- [ ] Frontend UI — onboarding flow, syllabus upload, preferences, connection status (Seb)

### Out of Scope

- Todoist integration — v2, not core to MVP value
- Spotify focus session automation — v2
- Gmail monitoring for professor emails — v2 (API scopes added but feature deferred)
- Study gap detection — v2
- Exam countdown scheduling — v2
- Web dashboard — Phase 3
- iOS app shell — Phase 3
- Multi-university support — Phase 3
- iMessage (Sendblue) — v2; SMS via Twilio for MVP
- Apple Health — iOS only, never in scope for server-side
- Real-time grade/submission access — FERPA non-starter; Canvas iCal only

## Context

- **Canvas via iCal** — student pastes their iCal URL during onboarding; no institutional approval, no FERPA exposure. Synced every 60 min. Rate limit: 120 req/min, must cache + backoff.
- **SMS first, app second** — Twilio for MVP, Sendblue (iMessage) for v2. UI is secondary to the data pipeline.
- **Normalized data model** — all integrations map to `Task`, `CalendarEvent`, `Message`. UI never touches external APIs directly.
- **Claude model tiering** — Opus for syllabus parsing + study gap analysis; Sonnet for briefings + conversational replies; Haiku for deadline classification + Spotify pattern analysis.
- **Google OAuth** — one OAuth 2.0 client (Web application) covers both Calendar and Gmail scopes. Tokens expire in 1 hour; always refresh before API calls. Refresh tokens encrypted at rest.
- **Backend-first build order** — pipeline must work end-to-end before Seb starts UI work.
- **Build order:** Canvas iCal → Google Calendar → Twilio SMS → Syllabus parsing → Weekly briefing → Deadline alerts.

## Constraints

- **Timeline**: MVP March 19, 2026 — backend pipeline and Twilio SMS must be working day 1
- **Compliance**: FERPA — Canvas iCal only, never grades/submissions/enrollment. TCPA — SMS opt-in consent, STOP/PAUSE handling, max 3 unsolicited/day.
- **Security**: OAuth tokens AES-256 encrypted at rest, phone numbers hashed in logs, HTTPS/TLS 1.3 only, user data deleted within 30 days of account deletion.
- **Tech stack**: Next.js 14 App Router + FastAPI for AI jobs; Supabase; Twilio; Claude API (Anthropic); Celery + Redis; Vercel + Railway.
- **Claude context**: Pass only last 14 days of deadlines + 7 days of calendar per request.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Canvas via iCal (not API) | No institutional approval needed, no FERPA risk | — Pending |
| SMS via Twilio (not iMessage) | No native iMessage API; Twilio is TCPA-compliant | — Pending |
| Supabase over Firebase | Relational schema fits the data model better long-term | — Pending |
| FastAPI for AI jobs (alongside Next.js) | Python ecosystem for Celery, better for AI workloads | — Pending |
| Backend-first build order | Pipeline must work before UI makes sense | — Pending |
| Single Google OAuth client | Calendar + Gmail share same client; reduces setup complexity | — Pending |

---
*Last updated: 2026-03-18 after initialization*
