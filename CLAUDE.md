# Aria — Claude Development Guide

> Read this file at the start of every session. This is the single source of truth for architecture, ownership, and how to work on this codebase.

---

## Project Overview

Aria is a proactive AI personal assistant built for college students. It unifies a student's academic life — Canvas deadlines, syllabus topics, personal tasks, and schedule — into one intelligent layer that communicates via SMS. No new app to open. Just a smart assistant that lives in their messages.

**Builders:** Josh Shin (backend) & Sebastian Alvaro Cuervo (frontend)
**MVP Date:** March 19, 2026
**Target users:** Yale students (closed beta → 50 users in 30 days)

---

## MVP Scope (Phase 1 — Josh solo, backend first)

Build the data pipeline before the UI. In this order:

1. **Canvas iCal sync** — fetch assignments/exams, diff for changes, store in DB
2. **Google Calendar** — OAuth, read/write events, push notifications
3. **Twilio SMS** — outbound briefings, inbound reply handling
4. **Syllabus PDF parsing** — Claude parses uploaded PDFs, stores structured data
5. **Weekly briefing generation** — Claude synthesizes all data into Monday 8am SMS
6. **Deadline change alerts** — detect Canvas diffs, fire alert within 15 min

**Frontend UI (Seb joins):** comes after the data pipeline is working end-to-end.

### Save for Phase 2
- Todoist integration
- Spotify focus session automation
- Gmail monitoring for professor emails
- Study gap detection
- Exam countdown scheduling

### Save for Phase 3
- Web dashboard
- iOS app shell
- Multi-university expansion
- Apple Music, Zoom integrations

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 14 (App Router), TypeScript, Tailwind CSS |
| Backend | Next.js API routes + FastAPI (Python) for AI jobs |
| Database | Supabase (PostgreSQL) |
| Vector DB | Chroma (syllabus embeddings) |
| Auth | Supabase Auth + Google OAuth 2.0 |
| SMS | Twilio Messaging API |
| AI | Claude API (Anthropic) — see model breakdown below |
| Job scheduling | Celery + Redis (background sync jobs) |
| Deployment | Vercel (frontend) + Railway (backend jobs) |

### Claude Model Breakdown
| Task | Model |
|---|---|
| Syllabus parsing | claude-opus-4-6 |
| Weekly briefing generation | claude-sonnet-4-6 |
| Conversational SMS replies | claude-sonnet-4-6 |
| Deadline change classification | claude-haiku-4-5-20251001 |
| Study gap analysis | claude-opus-4-6 |
| Spotify session pattern analysis | claude-haiku-4-5-20251001 |

---

## Architecture Decisions

- **Canvas via iCal** — student pastes their Canvas iCal URL (no institutional approval needed, no FERPA issues). Synced every 60 min via background job.
- **iMessage is not possible natively** — no Apple API. Use **Sendblue** for iMessage (v2) or **Twilio** for SMS (MVP).
- **All external data normalized** to three shared types: `Task`, `CalendarEvent`, `Message`. UI never cares about the source.
- **Canvas API rate limit: 120 req/min** — always cache, always use exponential backoff.
- **Apple Health never leaves the device** — iOS only, out of scope for MVP.
- **Google OAuth tokens expire** — always implement refresh token rotation. Store refresh tokens encrypted in Supabase.
- **Supabase over Firebase** — relational schema is correct for this data model. Better long-term.
- **Never commit `.env.local`** — all secrets via environment variables only.

---

## Normalized Data Model

All integrations map their data to these three types:

```typescript
// src/types/index.ts

export type Task = {
  id: string
  title: string
  due_date: string          // ISO 8601
  source: 'canvas' | 'todoist' | 'reminders'
  status: 'upcoming' | 'overdue' | 'completed'
  course?: string
  weight?: number           // grade percentage, from syllabus
  url?: string
}

export type CalendarEvent = {
  id: string
  title: string
  start_time: string        // ISO 8601
  end_time: string
  source: 'gcal' | 'canvas'
  type: 'class' | 'study' | 'personal' | 'exam'
  location?: string
}

export type Message = {
  id: string
  from: string
  preview: string
  source: 'gmail' | 'slack' | 'imessage'
  timestamp: string
  is_read: boolean
}
```

---

## Database Schema (Core Tables)

```sql
-- users
id, name, phone, university, graduation_year, preferences_json, created_at

-- integrations
user_id, platform, access_token, refresh_token, ical_url, connected_at, synced_at

-- deadlines
id, user_id, canvas_uid, title, due_date, course, type, grade_weight, last_synced

-- syllabi
id, user_id, course_name, raw_text, parsed_json, uploaded_at

-- calendar_events
id, user_id, google_event_id, title, start_time, end_time, type

-- tasks
id, user_id, todoist_id, title, due_date, priority, completed

-- messages
id, user_id, direction (in/out), body, sent_at, trigger_type

-- spotify_sessions
id, user_id, playlist_uri, started_at, ended_at, duration_minutes
```

---

## File Structure

```
aria-mvp/
├── CLAUDE.md                   ← you are here
├── FEATURES.md                 ← feature checklist, updated after every push
├── README.md
├── .env.local                  ← never commit
├── .claude/
│   ├── settings.json           ← safety guardrails
│   └── commands/
│       ├── start.md            ← /project:start
│       └── done.md             ← /project:done
├── src/
│   ├── types/
│   │   └── index.ts            ← Task, CalendarEvent, Message types
│   ├── lib/
│   │   ├── integrations/
│   │   │   ├── canvas.ts       ← iCal fetch + normalize to Task[]
│   │   │   ├── gcal.ts         ← Google Calendar OAuth + normalize
│   │   │   ├── todoist.ts      ← Todoist OAuth + normalize
│   │   │   └── spotify.ts      ← Spotify OAuth + playback control
│   │   ├── sync/
│   │   │   ├── canvas-sync.ts  ← diff + alert logic
│   │   │   └── gcal-sync.ts    ← push notification handler
│   │   ├── ai/
│   │   │   ├── briefing.ts     ← weekly briefing generator
│   │   │   ├── syllabus.ts     ← PDF parser via Claude
│   │   │   └── replies.ts      ← conversational SMS handler
│   │   └── sms/
│   │       └── twilio.ts       ← send/receive SMS
│   ├── app/
│   │   ├── api/
│   │   │   ├── sync/
│   │   │   │   ├── canvas/route.ts
│   │   │   │   └── gcal/route.ts
│   │   │   ├── sms/
│   │   │   │   └── webhook/route.ts   ← Twilio inbound
│   │   │   └── upload/
│   │   │       └── syllabus/route.ts
│   │   └── (frontend pages — Seb owns this)
│   └── components/             ← Seb owns this
├── supabase/
│   └── migrations/             ← SQL migration files
└── tests/
```

---

## Integration Patterns

Every integration follows this exact structure — no exceptions:

```
src/lib/integrations/[service].ts     → raw API calls, returns raw data
src/lib/sync/[service]-sync.ts        → fetch + normalize to our types + cache
src/app/api/sync/[service]/route.ts   → Next.js API route that triggers sync
```

Cache all results in Supabase with a `synced_at` timestamp. Return `Task[]`, `CalendarEvent[]`, or `Message[]`. Never let the UI hit an external API directly.

---

## Google OAuth Scopes

```
Gmail (Phase 2):     https://www.googleapis.com/auth/gmail.readonly
Google Calendar:     https://www.googleapis.com/auth/calendar
```

Create one OAuth 2.0 client in Google Cloud Console (Web application type). Both scopes can share the same client.

---

## Environment Variables

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Google OAuth
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=

# Twilio
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=

# Claude / Anthropic
ANTHROPIC_API_KEY=

# Spotify (Phase 2)
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=

# Todoist (Phase 2)
TODOIST_CLIENT_ID=
TODOIST_CLIENT_SECRET=
```

---

## Team Ownership

| Area | Owner | Do Not Touch |
|---|---|---|
| `src/lib/integrations/` | Josh | Seb |
| `src/lib/sync/` | Josh | Seb |
| `src/lib/ai/` | Josh | Seb |
| `src/lib/sms/` | Josh | Seb |
| `src/app/api/` | Josh | Seb |
| `supabase/migrations/` | Josh (sync before changing) | Either alone |
| `src/types/index.ts` | Both (sync before changing) | Either alone |
| `src/app/(pages)/` | Seb | Josh |
| `src/components/` | Seb | Josh |

**Schema rule:** Never run a migration without telling the other person first.

---

## Git Workflow

```bash
# Start of every session
git checkout main && git pull origin main
git checkout -b feature/your-task-name

# Branch naming
feature/canvas-ical-sync
feature/twilio-webhook
feature/briefing-generator
fix/oauth-token-refresh

# End of every task
git add -p                      # review each change, never git add .
git commit -m "feat: descriptive message"
git push origin feature/your-task-name
# Open PR on GitHub, other person reviews
```

**Never push directly to `main`.** Never use `git add .`. Never `git push --force`.

---

## Code Style

- TypeScript strict mode always on
- `camelCase` for variables and functions
- `PascalCase` for components and types
- `snake_case` for database column names
- Always handle API errors with `try/catch` — log to console, return typed error
- No `any` types — if you're tempted to use `any`, define the type instead
- Every integration function must have a JSDoc comment describing input/output

---

## Build Commands

```bash
npm run dev          # dev server on localhost:3000
npm run build        # production build
npm run lint         # ESLint check — must pass before every commit
npm test             # Jest test suite
npx supabase db push # run migrations
```

---

## How to Prompt Claude Effectively in This Codebase

**Always reference existing files:**
```
Look at src/lib/integrations/canvas.ts as a reference pattern,
then build the same structure for Todoist in src/lib/integrations/todoist.ts
```

**Be specific about input/output contracts:**
```
Build fetchCanvasDeadlines(icalUrl: string): Promise<Task[]>
that fetches the iCal feed, parses it, and maps each VEVENT to our Task type
defined in src/types/index.ts. Cache results in Supabase deadlines table.
```

**Ask for tests alongside code:**
```
Also write a Jest test at tests/integrations/canvas.test.ts
that mocks the iCal response and verifies the Task mapping is correct.
```

**Use `/project:start` to begin each session and `/project:done` to finish.**

---

## Critical Gotchas

- **Canvas iCal rate limits** — cache aggressively, don't re-fetch more than once per hour
- **Google OAuth tokens expire in 1 hour** — always refresh before API calls
- **Twilio webhook must be publicly accessible** — use ngrok in dev
- **iMessage has no native API** — Sendblue for v2, Twilio SMS for MVP
- **Apple Health never leaves the device** — iOS only, not in MVP
- **Phone numbers must be hashed in logs** — never store in plaintext in log files
- **FERPA compliance** — never access grades, submissions, or enrollment records. Canvas iCal only.
- **Claude context limit** — pass only the last 14 days of deadlines + 7 days of calendar per request
- **Syllabus parsing** — use Claude Opus for accuracy, store structured JSON in Supabase, never re-parse the raw PDF

---

## Cowork / Claude (Seb's AI) Protocol

Seb works with Claude via Cowork (desktop AI). This Claude has access to:
- The `aria-mvp` GitHub repo (read/write via git)
- Seb's Notion workspace (read/write)
- Gmail MCP

When Seb's Claude makes a commit, the commit author will be `joshlnnn / alvaro.cuervo@yale.edu`.
Josh works with Claude Code directly in terminal.

**After every meaningful push, update `FEATURES.md`** — mark completed features, add notes, update next steps. This is how both developers stay in sync without needing to be online at the same time.

---

## Privacy & Legal

- All OAuth tokens encrypted at rest (AES-256)
- All API communication over HTTPS/TLS 1.3
- Phone numbers hashed in logs
- No third-party data sharing
- User data deleted within 30 days of account deletion
- Required before beta: Terms of Service, Privacy Policy, SMS opt-in consent (TCPA)
