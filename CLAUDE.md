# Aria — Claude Development Guide

> Read this file at the start of every session. This is the single source of truth for architecture, ownership, and how to work on this codebase.

---

## Project Overview

Aria is a proactive AI personal assistant built for college students. It unifies a student's academic life — Canvas deadlines, syllabus topics, personal tasks, and schedule — into one intelligent layer that communicates via SMS. No new app to open. Just a smart assistant that lives in their messages.

**Builders:** Josh Shin (backend) & Sebastian Alvaro Cuervo (frontend)
**Project Started:** March 18, 2026
**Target users:** Yale students (closed beta → 50 users in 30 days)

---

## MVP Scope (Phase 1 — Josh solo, backend first)

Build the data pipeline before the UI. In this order:

1. **Canvas iCal sync** — fetch assignments/exams, diff for changes, store in DB
2. **Gmail integration** — OAuth, monitor professor emails for deadline changes
3. **Google Calendar** — OAuth, read/write events, push notifications
4. **Twilio SMS** — outbound briefings, inbound reply handling
5. **Syllabus PDF parsing** — Claude parses uploaded PDFs, stores structured data
6. **Daily briefing generation** — Claude synthesizes all data into a daily morning SMS
7. **Deadline change alerts** — detect Canvas diffs + Gmail signals, fire alert within 15 min

**Frontend UI (Seb joins):** comes after the data pipeline is working end-to-end.

### Save for Phase 2
- Todoist integration
- Spotify focus session automation
- iMessage via Sendblue (SMS via Twilio for MVP)
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
| Frontend | Next.js 15.2 (App Router), TypeScript, Tailwind CSS |
| Backend | Next.js API routes + FastAPI (Python) for AI jobs |
| Database | Supabase (PostgreSQL) |
| Vector DB | pgvector via Supabase (syllabus embeddings — Chroma dropped, unnecessary complexity for MVP) |
| Auth | Supabase Auth + Google OAuth 2.0 |
| SMS | Twilio Messaging API |
| AI | Claude API (Anthropic) — see model breakdown below |
| Job scheduling | Celery + Redis (background sync jobs) |
| Deployment | Vercel (frontend) + Railway (backend jobs) |

### Claude Model Breakdown
| Task | Model |
|---|---|
| Syllabus parsing | claude-opus-4-6 |
| Daily briefing generation | claude-sonnet-4-6 |
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
├── WORK.md                     ← active work state — read before every session
├── FEATURES.md                 ← feature checklist, updated after every push
├── docs/
│   ├── history/                ← archive: original build phases, old handoffs, old progress log
│   ├── plans/                  ← implementation plans
│   └── specs/                  ← design specs
├── README.md
├── .env.local                  ← never commit
├── .claude/
│   └── settings.json           ← safety guardrails
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
│   │   │   ├── briefing.ts     ← daily briefing generator
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

# End of every task
git add -p                    # review each change, never git add .
git commit -m "feat: descriptive message"
git push origin main
```

**Never use `git add .`. Never `git push --force`.**

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
cd celery_worker && pytest   # worker test suite
cd mobile && npx jest        # mobile test suite
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

**Session start and "wrap up" are handled by the Session Protocol below.**

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

### Implementation Gotchas

> Lessons learned while building. These will bite again. Add a row during "wrap up" whenever you discover a new one.

| Gotcha | Rule |
|---|---|
| Course matching | `syllabi.course_name` vs `canonical_events.course_id` — always use ILIKE |
| Windows strftime | `%-I` fails on Windows; use `%I` + `.lstrip("0").lower()` |
| Lazy import patching | Patch at the SOURCE module, never the importing module |
| Token encryption boundary | Next.js callback NEVER writes tokens to Supabase directly |
| GCal/Gmail watch expiry | Watch channels expire every 7 days — `renew-watch-channels` Beat task runs every 6h |
| Google OAuth verification | Gmail readonly is sensitive scope — app verification takes 1–6 weeks |
| PDF bytes | Never persisted — only base64 passes through Redis queue |
| Re-parse guard | `check_existing_syllabus()` skips Claude call if `parsed_json` already exists |
| On-demand scheduling flow | Redis pending state (5-min TTL) bridges two-message confirm flow |
| conftest autouse | `tests/ai/conftest.py` stubs Redis intercepts — new schedule tests must patch `sms.schedule.*` directly |
| Expo winter runtime in Jest | Pre-define `structuredClone` + `__ExpoImportMetaRegistry` as non-configurable in `jest.globals.js` (see `mobile/jest.globals.js`) |
| PhoneInput test input | `fireEvent.changeText` with RAW DIGITS only (e.g. `'5551234567'`), not formatted string. Formatted string double-counts the `+1` country code. |
| PinInput testID | `PinInput` accepts `testID` prop forwarded to root View with `onComplete` — `fireEvent(el, 'complete', code)` works |
| Phone in profile route | Since pivot: phone is NOT in request body — backend reads `user.phone` from Supabase JWT session |
| getSession() mock in tests | The test mock returns a plain object (not Promise). Use `await supabase.auth.getSession()` pattern, NOT `.then()` — awaiting a non-promise returns the value directly |
| Text.disabled for testing | RN `Text` has a `disabled` prop explicitly for testing. Pass `disabled={condition}` to `<Text>` to make `getByText(...).parent?.props.disabled` work in test renderer. Neither `TouchableOpacity` nor `Pressable` exposes `disabled` on their rendered host element. |
| Supabase phone auth Twilio field | Supabase wants a **Messaging Service SID** (`MG...`), NOT the raw phone number and NOT the Verify Service SID (`VA...`). Create in Twilio Console → Messaging → Services. |
| Mobile API auth | Mobile app sends `Authorization: Bearer <jwt>`. Next.js API routes must read JWT from `Authorization` header using `adminClient.auth.getUser(jwt)` — NOT from cookies (`createClient()` reads cookies, not Bearer tokens). |
| react-native-url-polyfill | Must be imported as FIRST import in `mobile/app/_layout.tsx` — without it, Supabase network requests fail intermittently with `Network request failed` (status 0) |
| EXPO_PUBLIC_DEMO_MODE | Set to `false` in `mobile/.env` for real auth testing. `true` injects fake session and skips all auth/onboarding. |
| Onboarding routing | `_layout.tsx` checks `onboarding_completed_at` from `public.users` to decide routing. Three cases: (1) no session → welcome, (2) session + done → home, (3) session + not done + not in onboarding → tcpa |
| Back navigation in onboarding | `router.replace()` clears stack — `router.back()` throws `GO_BACK not handled`. Use explicit `router.replace('/(onboarding)/[screen]')` for all back buttons. |
| Next.js dev server required | Mobile app calls Next.js API routes at `EXPO_PUBLIC_API_URL`. Must run `npm run dev` in `aria-mvp` root during local testing. In production, set `EXPO_PUBLIC_API_URL` to Vercel URL. |
| /api/onboarding/complete Redis | Route tries to connect to Redis at `redis://localhost:6379/0` to enqueue welcome SMS. Redis must be running (Docker) for this to succeed. If Redis not running, route will hang/error. |
| Simulator spinner hang on launch | If app shows spinner forever with Metro bundled and no requests hitting Next.js: stale/expired Supabase session in SecureStore is causing `getSession()` to attempt a token refresh that hangs. Fix: **Device → Erase All Content and Settings** in simulator, then reinstall via Metro. Do this at the start of every fresh simulator test session. |
| Celery enqueue from Next.js | Never hand-build Celery messages. Always use `enqueueCeleryTask()` in `src/lib/celery/enqueue.ts`; hand-built envelopes were silently dropped by kombu until 2026-09-24 |
| V2: build orchestration | Master plan `docs/plans/2026-10-10-v2-master-plan.md` wins over branch plans; frozen contract files (§1.0) change only via the orchestrator; read `docs/plans/2026-10-10-v2-orchestrator-notes.md` before any V2 task |
| V2: scripts outside Next | `import "server-only"` throws outside the Next runtime — run TS scripts with `npx tsx --conditions=react-server --env-file=.env.local <file>` |
| V2: Jest env | Jest does not load `.env.local`; tests needing crypto set a throwaway `APP_ENCRYPTION_KEY`. Smoke tests target the local Supabase stack (`supabase start`, Docker) |
| V2: magic-link redeem | Never set `Referrer-Policy: no-referrer` site-wide — browsers then send `Origin: null` on form POSTs and the redeem Origin check fails. Use `same-origin` |
| V2: headless screenshots | Headless Chrome enforces a 500px minimum window width — "mobile" shots at 390px are clipped artifacts; check at 500px or use device emulation |
| V2: Next 16 dev files | `next dev` rewrites `next-env.d.ts` and (re)creates `AGENTS.md` (points agents at `node_modules/next/dist/docs/`) — commit them, don't fight them |
| V2: Anthropic structured output | Very large JSON schemas are rejected ("compiled grammar is too large"); keep model-facing schemas flat (V2-08 parser) and strip `$schema` before `zodOutputFormat`. Sonnet 5.5 rejects `thinking: {type: "disabled"}` |
| V2: strict tool grammar | The API caps the *compiled grammar* of all strict tools + the reply format together; `strictBudget` (counts) can't see it. Never mark a nested-schema tool `strict` (`propose_preference` isn't). After any tool-schema change run `SMOKE_LLM=1 npm run smoke -- tests/smoke/llm-grammar.smoke.test.ts` |
| V2: llm_calls cleanup | `llm_calls.user_id` is nulled (not cascaded) on user delete — smoke/eval/live-check cleanup must delete those rows explicitly |
| V2: deterministic ordering | Never break `order()` ties on a uuid `id` alone — it's random, so same-timestamp rows (e.g. two all-day deadlines) flip between runs. Add a meaningful tie-break first (`timeline/store.ts#queryRange`: anchor, title, id) |
| V2: smoke tests + real key | Exporting `ANTHROPIC_API_KEY` (for the grammar smoke) makes every smoke that reaches a model path call real Haiku. Smoke files that assume no model `delete process.env.ANTHROPIC_API_KEY` up front; run the full suite with `env -u ANTHROPIC_API_KEY npm run smoke` |

---

## Two-Developer Collaboration Protocol

**The problem:** Josh and Seb each run their own Claude Code session. Without coordination, two Claudes can touch the same files at the same time and create conflicts or duplicate work.

**The solution:** `WORK.md` is the single source of truth for active work. Read it before every session. Update it when you start and finish.

### Session Protocol (Claude follows this automatically)

**At session start** (the first message of a session, or "let's start" / "where were we"):
1. `git pull origin main`, always starting from latest
2. Read `WORK.md`: Currently In Progress, Up Next, and the latest Handoff Notes
3. Orient in 3 lines: **Current task**, **Last thing done**, **Next action**
4. Before writing code, **claim** an unclaimed task: add a row to "Currently In Progress" and push `WORK.md` to main (ask first)

**On "wrap up"** (or "save", "done for today", "let's stop", "checkpoint", or similar), and before calling any task finished:
1. Run `npm run lint` and `npm run build`. If `celery_worker/` was touched, also run `cd celery_worker && pytest`; if `mobile/` was touched, run `cd mobile && npx jest`. There is no root `npm test`. Report failures honestly.
2. Update `WORK.md`: the In Progress table, checked-off Up Next items, and any new items discovered
3. Prepend a Handoff Note to `WORK.md` with the date, who, what was done, what's open, and anything the next person must know
4. Keep only the **3 most recent** Handoff Notes in `WORK.md`. Move older ones to the top of `docs/history/handoffs.md`.
5. If a new permanent lesson came up, add a row to *Implementation Gotchas* above
6. Update `FEATURES.md` if a feature changed status
7. **Commit and push automatically.** Stage only the files this session changed (never `git add .`), commit with a conventional message (`feat:`, `fix:`, `docs:`, `chore:`), push to `main`, and report the commit hash. **Stop and ask instead** if any check failed, if the diff contains changes this session didn't make, or if `supabase/migrations/` or `src/types/index.ts` changed (tell the other developers first).

Memory lives in git so all three developers share it. Use `CLAUDE.md` for permanent facts, `WORK.md` for live state, and `docs/history/` for the archive (original build phases, old handoffs, old progress log). Don't create other state files.

### What WORK.md contains:
- **🔒 Currently In Progress** — tasks that are actively claimed (do not touch these)
- **🎯 Up Next** — prioritized queue of available work
- **✅ Completed** — finished features with context
- **📋 Handoff Notes**: the 3 latest notes from other developers, which you need to read (older ones are in `docs/history/handoffs.md`)

### Ownership enforcement (enforced by Claude, not just a suggestion):
| Developer | Owns | Never touches |
|-----------|------|---------------|
| Josh | `src/lib/`, `src/app/api/`, `supabase/` | `src/app/(pages)/`, `src/components/` |
| Seb | `src/app/(pages)/`, `src/components/` | `src/lib/`, `src/app/api/`, `supabase/` |
| Both | `src/types/index.ts` | (sync before every change) |

### Hard rules:
- Never claim a task already in "Currently In Progress"
- Never modify the other developer's ownership area
- Never change `src/types/index.ts` or `supabase/migrations/` without calling the other person
- Always post a Handoff Note when pushing — the other developer reads this before starting

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
