# Aria

## What This Is

Aria is a proactive AI personal assistant for students — college undergraduates, graduate students, working students, and ambitious high schoolers — that unifies academic life into one intelligent layer across two equal primary channels: SMS text messages for proactive alerts and briefings, and a native iOS app with a customizable card-based dashboard. Students get a smart assistant that knows their Canvas deadlines, syllabus topics, Google Calendar, Gmail, and personal tasks simultaneously — and surfaces what matters, when it matters, without requiring them to open yet another app.

**Builders:** Josh Shin (backend) & Sebastian Alvaro Cuervo (iOS app)
**Target users:** College students at US Canvas institutions — starting with Yale closed beta (50 users), expanding to 500 by Phase 2, 2,000+ by Phase 3
**Project started:** March 18, 2026

## Core Value

Students don't have a productivity problem — they have a fragmentation problem. Aria is the first layer that sees everything simultaneously and acts on it proactively.

## Requirements

### Validated

- [x] Canvas iCal sync — fetch assignments/exams, diff for changes, store in Supabase (Validated in Phase 2: canvas-ical-sync)
- [x] Twilio SMS layer — TCPA-compliant outbound guard, STOP/START/PAUSE/HELP keyword dispatch, signature-validated webhook, Celery inbound processing (Validated in Phase 3: twilio-sms-tcpa-compliance)

### Active

- [ ] Claude AI briefings — daily morning SMS, Monday extended briefing, conversational replies, task management, exam countdown
- [ ] Priority Engine — canonical event store, priority scoring formula, delivery router
- [ ] Google Calendar + Gmail — OAuth, real-time alerts, conflict detection, Monday briefing enrichment
- [ ] Syllabus parsing — Claude Opus extracts grade weights, topics; study gap analysis before exams
- [ ] iOS app — 4-zone card dashboard, in-app chat, voice input, card customization (Seb)
- [ ] Onboarding — phone capture, Canvas URL, Google OAuth, SMS verification, first briefing preview
- [ ] Todoist integration — OAuth, task read/write, tasks in briefings and priority scoring

### Out of Scope (v1)

- iMessage via Sendblue — v2; Twilio SMS for MVP
- Spotify focus session automation — v2
- Apple Health — iOS device-only, no server-side API
- Android app — iOS only for v1; Android is Phase 3+
- Canvas assignment submission (write access) — out of scope
- AI tutoring / content explanation — different product category
- Non-US university platforms — US Canvas institutions only for v1
- Multi-university expansion — Phase 3
- Grades/submissions/enrollment — FERPA non-starter; Canvas iCal only

## Context

- **Canvas via iCal** — student pastes their iCal URL during onboarding; no institutional approval, no FERPA exposure. Synced every 60 min. Rate limit: 120 req/min, must cache + backoff.
- **SMS + iOS equally primary** — both channels connect to the same Aria backend. SMS for proactive delivery; iOS app for visual command center. Twilio for MVP, Sendblue (iMessage) for v2.
- **6-layer intelligence pipeline** — Ingestion Workers → Event Normalizer → Canonical Timeline DB → Priority Engine → Intelligence Layer (Claude) → Output Router. All integrations write to the Canonical Store, not directly to integration-specific tables.
- **Priority scoring formula** — `Priority = (grade_weight × 0.35) + (urgency × 0.45) + (source_authority × 0.20)`. Canvas = 1.0, professor email = 0.9, Todoist = 0.8, Discord = 0.6. Score ≥ 80 = immediate SMS; 50–79 = next digest; < 50 = silent.
- **Normalized data model** — all integrations map to `Task`, `CalendarEvent`, `Message`. UI never touches external APIs directly.
- **Claude model tiering** — Opus for syllabus parsing + study gap analysis; Sonnet for briefings + conversational replies; Haiku for deadline classification + email relevance scoring.
- **Google OAuth** — one OAuth 2.0 client (Web application) covers both Calendar and Gmail scopes. Tokens expire in 1 hour; always refresh before API calls. Refresh tokens encrypted at rest.
- **Backend-first build order** — data pipeline must work end-to-end before iOS app delivers value. Seb starts Phase 8 (iOS) parallel with Phase 6 once Phase 4 APIs are stable.
- **In-app chat is a separate channel** — SMS thread and in-app chat are independent conversation streams connecting to the same Aria backend.
- **Gmail data privacy** — Gmail signals stored as metadata only (`gmail_flags` table: subject, sender, summary). Full email content never stored permanently.

## Constraints

- **Timeline**: Backend pipeline MVP targeting Yale beta (50 users); full iOS app in parallel
- **Compliance**: FERPA — Canvas iCal only, never grades/submissions/enrollment. TCPA — SMS opt-in consent, STOP/PAUSE handling, max 3 unsolicited/day, no more than 3 texts in any 10-minute window.
- **Security**: OAuth tokens AES-256 encrypted at rest, phone numbers hashed in logs, HTTPS/TLS 1.3 only, user data deleted within 30 days of account deletion. Gmail content never stored permanently.
- **Tech stack**: Next.js 15.2 App Router + FastAPI (Python) for AI jobs; Supabase (PostgreSQL + pgvector); Twilio; Claude API (Anthropic); Celery + Redis; Vercel + Railway.
- **Claude context**: Pass only last 14 days of deadlines + 7 days of calendar + last 5 conversation exchanges per request. No prompt exceeds 80% of model context limit.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Canvas via iCal (not API) | No institutional approval needed, no FERPA risk | Validated Phase 2 |
| SMS via Twilio (not iMessage) | No native iMessage API; Twilio is TCPA-compliant | Validated Phase 3 |
| Supabase over Firebase | Relational schema fits the data model better long-term | Active |
| FastAPI for AI jobs (alongside Next.js) | Python ecosystem for Celery, better for AI workloads | Active |
| Backend-first build order | Pipeline must work before iOS app delivers value | Active |
| Single Google OAuth client | Calendar + Gmail share same client; reduces setup complexity | Active |
| Priority Engine as dedicated phase | Canonical Store + scoring formula is the architectural foundation for all Phase 6+ intelligence | Active |
| iOS app = equal primary interface | SMS + app together; not SMS-only; Seb builds Phase 8 in parallel | Active |
| Gmail metadata only | Full email content never stored permanently — privacy + compliance | Active |

---
*Last updated: 2026-03-19 — PRD v1.1 alignment: 9-phase roadmap, iOS primary interface, Priority Engine phase, conflict detection and study gaps promoted to v1, Todoist v1*
