# Architecture Research

**Domain:** Student AI SMS assistant — multi-source data pipeline + background jobs + conversational AI
**Researched:** 2026-03-18
**Confidence:** HIGH (all components are well-established; patterns based on official docs and stable architectural conventions)

---

## Standard Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        INBOUND TRIGGERS                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ Twilio SMS   │  │ GCal Push    │  │ Celery Beat (cron)       │  │
│  │ Webhook POST │  │ Webhook POST │  │ Canvas every 60 min      │  │
│  │ /api/sms/    │  │ /api/sync/   │  │ Daily briefing 8am       │  │
│  │  webhook     │  │  gcal        │  └──────────────────────────┘  │
│  └──────┬───────┘  └──────┬───────┘                                │
└─────────┼─────────────────┼──────────────────────────────────────--┘
          │                 │
┌─────────▼─────────────────▼─────────────────────────────────────────┐
│                     NEXT.JS API LAYER (Vercel)                      │
│  ┌──────────────────┐  ┌──────────────────┐  ┌───────────────────┐ │
│  │ /api/sms/webhook │  │ /api/sync/gcal   │  │ /api/sync/canvas  │ │
│  │ /api/sync/canvas │  │ /api/upload/     │  │ /api/auth/*       │ │
│  │                  │  │   syllabus       │  │                   │ │
│  └────────┬─────────┘  └────────┬─────────┘  └──────────────────-┘ │
└───────────┼────────────────────-┼────────────────────────────-------┘
            │                     │
            │   Enqueue Task      │   Direct Call
            ▼                     ▼
┌───────────────────────────────────────────────────────────────────--┐
│                  REDIS TASK QUEUE                                    │
│                  (Railway-hosted)                                    │
└───────────────────────────┬──────────────────────────────────────---┘
                             │
                             ▼
┌────────────────────────────────────────────────────────────────────-┐
│               FASTAPI + CELERY WORKER LAYER (Railway)               │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Workers                                                     │   │
│  │  ┌─────────────────┐  ┌──────────────────┐                  │   │
│  │  │ canvas_sync     │  │ briefing_generate │                  │   │
│  │  │ - Fetch iCal    │  │ - Gather context  │                  │   │
│  │  │ - Diff vs DB    │  │ - Call Claude     │                  │   │
│  │  │ - Fire alerts   │  │ - Send via Twilio │                  │   │
│  │  └─────────────────┘  └──────────────────┘                  │   │
│  │  ┌─────────────────┐  ┌──────────────────┐                  │   │
│  │  │ sms_reply       │  │ syllabus_parse   │                  │   │
│  │  │ - Load context  │  │ - Extract text   │                  │   │
│  │  │ - Call Claude   │  │ - Call Claude    │                  │   │
│  │  │ - Send response │  │ - Store JSON     │                  │   │
│  │  └─────────────────┘  └──────────────────┘                  │   │
│  └─────────────────────────────────────────────────────────────┘   │
└──────────────────────────────┬──────────────────────────────────----┘
                                │
          ┌─────────────────────┼──────────────────────┐
          ▼                     ▼                       ▼
┌──────────────────┐  ┌──────────────────┐  ┌────────────────────────┐
│  SUPABASE (PG)   │  │  ANTHROPIC API   │  │  EXTERNAL SERVICES     │
│  - users         │  │  Claude Opus     │  │  - Canvas iCal URL     │
│  - deadlines     │  │  Claude Sonnet   │  │  - Google Calendar API │
│  - calendar_     │  │  Claude Haiku    │  │  - Gmail API           │
│    events        │  └──────────────────┘  │  - Twilio API          │
│  - syllabi       │                        └────────────────────────┘
│  - integrations  │
│  - messages      │
└──────────────────┘
       │
       ▼
┌──────────────────┐
│  CHROMA          │
│  (Vector DB)     │
│  - Syllabus      │
│    embeddings    │
└──────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Communicates With |
|-----------|----------------|-------------------|
| Next.js API routes (Vercel) | Receive webhooks, trigger syncs, handle file uploads, auth callbacks | Redis (enqueue jobs), Supabase (direct reads), Twilio (validate inbound) |
| Celery Beat (scheduler) | Cron: Canvas sync every 60 min, daily briefing at 8am per user timezone | Redis (task queue) |
| Celery Worker (FastAPI) | Execute async jobs: sync, parse, generate, send | Supabase, Claude API, Twilio API, Google APIs |
| Supabase (PostgreSQL) | All persistent state — users, deadlines, events, messages, tokens | Next.js, Celery workers |
| Redis | Task queue broker + result backend for Celery | Next.js (enqueue), Celery (consume) |
| Chroma | Semantic search over syllabus content | Celery workers (query during briefing generation) |
| Claude API | AI inference — briefings, parsing, replies, classification | Celery workers only (never called from Next.js API routes directly) |
| Twilio | SMS send/receive | Next.js webhook, Celery workers (send) |
| Google OAuth | Calendar + Gmail access | Next.js auth routes (exchange code), Celery workers (use tokens) |

---

## Recommended Project Structure

The structure already defined in CLAUDE.md is correct. Here is the rationale layer added on top:

```
src/
├── types/
│   └── index.ts                 # Task, CalendarEvent, Message — the normalization contract
├── lib/
│   ├── integrations/            # ONE FILE PER EXTERNAL SERVICE
│   │   ├── canvas.ts            # iCal fetch → Task[]
│   │   ├── gcal.ts              # Google Calendar OAuth + events → CalendarEvent[]
│   │   └── gmail.ts             # Gmail OAuth + thread monitoring → Message[]
│   ├── sync/                    # DIFF + CACHE + ALERT LOGIC
│   │   ├── canvas-sync.ts       # Compare new Tasks vs stored, detect changes
│   │   └── gcal-sync.ts         # Handle GCal push notification payloads
│   ├── ai/                      # CLAUDE CALLS — one file per concern
│   │   ├── briefing.ts          # Assemble context window, call Sonnet, return SMS text
│   │   ├── syllabus.ts          # Extract text from PDF, call Opus, return structured JSON
│   │   └── replies.ts           # Conversational handler, call Sonnet with message history
│   └── sms/
│       └── twilio.ts            # send(to, body) and validateInbound(req)
├── app/
│   └── api/
│       ├── sync/                # HTTP trigger endpoints (called by Celery Beat or manual)
│       │   ├── canvas/route.ts
│       │   └── gcal/route.ts
│       ├── sms/
│       │   └── webhook/route.ts # Twilio POSTs here on inbound SMS
│       ├── upload/
│       │   └── syllabus/route.ts
│       └── auth/
│           └── google/          # OAuth callback handler
├── workers/                     # Celery task definitions (Python / FastAPI side)
│   ├── canvas_worker.py
│   ├── briefing_worker.py
│   ├── sms_worker.py
│   └── syllabus_worker.py
└── supabase/
    └── migrations/              # Versioned SQL — never edit without coordination
```

### Structure Rationale

- **`lib/integrations/`:** Raw API adapters. Each file owns one external service and returns normalized types. No business logic here — just fetch + transform.
- **`lib/sync/`:** The diff engine. Reads from the external source (via integrations), compares to Supabase state, enqueues alerts. This is where "did something change?" lives.
- **`lib/ai/`:** Context assembly + Claude calls. Knows what to put in the prompt and what model to use. Never called from the browser — only from workers or API routes.
- **`workers/`:** Python Celery tasks that wire together integrations + AI + SMS. The actual workflow orchestration lives here.

---

## Architectural Patterns

### Pattern 1: Integration Adapter (Normalization Layer)

**What:** Every external data source has an adapter that converts raw API responses into the three shared types (`Task`, `CalendarEvent`, `Message`). The rest of the system only ever works with these types — never raw Canvas objects or Google event JSON.

**When to use:** Always. Every integration, no exceptions.

**Trade-offs:** Adding a new integration requires mapping to existing types, which can be lossy (e.g., Canvas grade weights don't fit cleanly into `Task`). The `weight` and `course` optional fields handle this, but resist expanding the shared types to be too integration-specific.

**Example:**
```typescript
// lib/integrations/canvas.ts
export async function fetchCanvasDeadlines(icalUrl: string): Promise<Task[]> {
  const raw = await fetchIcal(icalUrl)
  return raw.events.map(event => ({
    id: event.uid,
    title: event.summary,
    due_date: event.dtstart.toISOString(),
    source: 'canvas',
    status: isPast(event.dtstart) ? 'overdue' : 'upcoming',
    course: extractCourseFromSummary(event.summary),
    url: event.url ?? undefined,
  }))
}
```

### Pattern 2: Enqueue-Don't-Block (Async Job Handoff)

**What:** Next.js API routes are synchronous HTTP handlers on Vercel's edge. They must respond in <30 seconds (Vercel timeout). Any work that might take longer — Claude inference, GCal sync, SMS delivery — must be handed off to a Celery worker via Redis and return 202 Accepted immediately.

**When to use:** Any operation involving Claude API calls, external OAuth API calls, or PDF processing. Essentially any non-trivial work.

**Trade-offs:** Adds operational complexity (Redis + Celery infra). For MVP at 50 users, a simple async queue suffices — don't over-engineer with priority lanes or retries until needed. The upside is the Next.js layer stays fast and never blocks on AI inference.

**Example:**
```typescript
// app/api/sms/webhook/route.ts
export async function POST(req: Request) {
  const body = await req.formData()
  const from = body.get('From') as string
  const text = body.get('Body') as string

  // Validate Twilio signature (MEDIUM confidence: standard Twilio pattern)
  validateTwilioSignature(req)

  // Enqueue — do NOT call Claude here
  await enqueueTask('sms_reply', { from, text, timestamp: Date.now() })

  // Return TwiML immediately (empty response = no auto-reply)
  return new Response('<Response></Response>', {
    headers: { 'Content-Type': 'text/xml' }
  })
}
```

### Pattern 3: Diff-and-Alert (Canvas Sync Engine)

**What:** The Canvas sync worker fetches the current iCal feed, loads the stored deadlines from Supabase, and diffs them by `canvas_uid`. Any new UIDs or changed `due_date` values trigger an alert job. Old UIDs that disappeared (assignment removed) are flagged but not deleted — they're marked stale.

**When to use:** Canvas sync, and any polling-based integration where you need to detect changes without webhooks.

**Trade-offs:** Requires reliable UID identity from Canvas iCal, which the spec guarantees via `VEVENT.UID`. The 60-minute poll interval means changes can be up to 60 minutes late to detect — acceptable for academic deadlines but not real-time. The requirement for "within 15 min" on critical alerts may require a more aggressive poll (e.g., 10 minutes) for the deadline alert feature specifically.

**Example:**
```python
# workers/canvas_worker.py
def canvas_sync(user_id: str):
    user = db.get_user(user_id)
    fresh_tasks = fetch_canvas_ical(user.ical_url)
    stored = db.get_deadlines(user_id)
    stored_by_uid = {d.canvas_uid: d for d in stored}

    for task in fresh_tasks:
        existing = stored_by_uid.get(task.canvas_uid)
        if existing is None:
            db.insert_deadline(user_id, task)
            # new assignment — no alert (normal course of business)
        elif existing.due_date != task.due_date:
            db.update_deadline(user_id, task)
            enqueue_task('deadline_alert', {
                'user_id': user_id,
                'task': task,
                'old_due_date': existing.due_date,
            })
```

### Pattern 4: Context Window Assembly

**What:** Before any Claude call, the worker assembles a bounded context window. The rule in CLAUDE.md is "last 14 days of deadlines + 7 days of calendar." This is assembled in the worker, not passed from the API layer, because the worker has direct Supabase access and controls latency.

**When to use:** Every Claude call — briefing generation, conversational replies, and syllabus-informed classification.

**Trade-offs:** Hardcoding the 14-day window means near-term deadlines are always included. The risk is a student with 30+ assignments in 2 weeks overflowing the context. The mitigating pattern is to sort by due date, truncate to the most urgent N items, and include a summary count ("and 8 more next week").

---

## Data Flow

### Flow 1: Daily Briefing (Scheduled, Outbound)

```
Celery Beat (cron: 8am per user timezone)
    ↓ enqueue briefing_generate task
Redis Queue
    ↓ worker picks up
Celery Worker
    ├── Query Supabase: deadlines (next 14 days) for user
    ├── Query Supabase: calendar_events (next 7 days) for user
    ├── Query Supabase: syllabi (grade weights for upcoming deadlines)
    ├── Query Chroma: any relevant syllabus context
    ├── Assemble context window
    ├── POST to Anthropic API (claude-sonnet-4-6)
    ├── Receive briefing text
    ├── POST to Twilio API (send SMS to user.phone)
    └── INSERT into messages table (direction='out', trigger_type='briefing')
```

### Flow 2: Inbound SMS Reply (Real-time, Bidirectional)

```
Student sends SMS
    ↓ Twilio receives
    ↓ POST to /api/sms/webhook (Next.js, Vercel)
Next.js Route
    ├── Validate Twilio signature
    ├── Extract From, Body from form data
    ├── Enqueue sms_reply task with {from, body}
    └── Return <Response></Response> (200, no auto-reply yet)

Redis Queue
    ↓ worker picks up within seconds
Celery Worker
    ├── Lookup user by phone number
    ├── Load last 10 messages from messages table (conversation history)
    ├── Load upcoming deadlines (next 14 days)
    ├── POST to Anthropic API (claude-sonnet-4-6)
    ├── Receive reply text
    ├── POST to Twilio API (send response SMS)
    ├── INSERT inbound message (direction='in')
    └── INSERT outbound reply (direction='out', trigger_type='reply')
```

### Flow 3: Canvas Deadline Change Alert (Polling-based, Outbound)

```
Celery Beat (cron: every 60 min, or every 10 min for alert-tier users)
    ↓ enqueue canvas_sync for each active user
Redis Queue
    ↓ worker picks up
Celery Worker
    ├── Fetch user.ical_url → iCal feed (HTTP GET)
    ├── Parse VEVENT list
    ├── Query Supabase: deadlines table for user
    ├── Diff: find changed due_dates by canvas_uid
    ├── For each change: UPDATE deadlines table
    └── For each change: enqueue deadline_alert task

deadline_alert worker:
    ├── Classify change severity (claude-haiku — is this urgent?)
    ├── Compose alert SMS
    ├── POST to Twilio API
    └── INSERT into messages table (trigger_type='deadline_alert')
```

### Flow 4: Google Calendar Push Notification (Real-time, Inbound)

```
Google Calendar API (sends push when calendar changes)
    ↓ POST to /api/sync/gcal (Next.js, Vercel)
    NOTE: requires a registered channel with a public HTTPS URL
          Channel expires every 7 days — must re-register via cron

Next.js Route
    ├── Validate X-Goog-Channel-Token header
    ├── Extract X-Goog-Resource-State (sync | exists)
    ├── If 'sync': initial handshake, return 200 immediately
    ├── If 'exists': calendar changed
    │   ├── Enqueue gcal_sync task
    │   └── Return 200 immediately (Google requires fast response)

Celery Worker (gcal_sync)
    ├── Load user's stored access token from Supabase
    ├── Refresh token if expired (Google tokens expire in 1 hour)
    ├── Call Google Calendar API: list events since last sync
    ├── Normalize to CalendarEvent[]
    ├── UPSERT into calendar_events table
    └── Update integrations.synced_at
```

### Flow 5: Syllabus Upload + Parse (On-demand, User-initiated)

```
User uploads PDF via frontend
    ↓ POST to /api/upload/syllabus (Next.js, Vercel)
Next.js Route
    ├── Validate file type (PDF only)
    ├── Store raw PDF in Supabase Storage (or local temp)
    ├── INSERT stub into syllabi table (raw_text=null, parsed_json=null)
    ├── Enqueue syllabus_parse task with {syllabus_id, file_path}
    └── Return {status: 'processing', syllabus_id}

Celery Worker (syllabus_parse)
    ├── Extract text from PDF (pypdf2 or pdfminer)
    ├── POST to Anthropic API (claude-opus-4-6)
    │   Prompt: extract course name, assignments, due dates,
    │            grade weights, exam dates → structured JSON
    ├── Receive structured JSON
    ├── UPDATE syllabi table (raw_text, parsed_json)
    ├── For each deadline in parsed JSON:
    │   └── UPSERT into deadlines table (source='syllabus', grade_weight set)
    └── Generate and store Chroma embeddings for semantic search
```

---

## Build Order and Dependencies

This is the most critical architectural insight: the components have hard dependencies. Building in the wrong order means you can't test anything end-to-end.

```
Layer 0: Infrastructure (must come first — everything else depends on it)
  Supabase schema (all tables)
  Redis instance (Railway)
  Celery worker skeleton (FastAPI + Celery, no tasks yet)
  Twilio phone number provisioned
  Vercel project connected

Layer 1: Canvas iCal Sync (no auth dependency — just a URL)
  canvas.ts integration (fetch + normalize)
  canvas-sync.ts (diff logic)
  /api/sync/canvas route
  canvas_worker.py Celery task
  Celery Beat schedule (60 min)
  ← CAN BE TESTED IN ISOLATION with any Canvas iCal URL

Layer 2: Twilio SMS (depends on: Layer 0 + users table)
  twilio.ts send/receive
  /api/sms/webhook route
  sms_worker.py (basic echo reply)
  ngrok tunnel for local dev
  ← CAN BE TESTED: send a text, get an echo back

Layer 3: Claude AI Integration (depends on: Layer 1 + Layer 2)
  briefing.ts context assembly
  replies.ts conversational handler
  briefing_worker.py + sms_worker.py fully wired
  ← END-TO-END TEST: Canvas data → Claude → SMS briefing

Layer 4: Google OAuth + Calendar (depends on: Layer 0 auth)
  gcal.ts integration
  gcal-sync.ts push handler
  /api/sync/gcal route
  /api/auth/google route
  GCal push channel registration + renewal cron
  ← REQUIRES: public HTTPS URL (deploy to Vercel or use ngrok)

Layer 5: Syllabus Parsing (depends on: Layer 3)
  syllabus.ts Claude Opus integration
  /api/upload/syllabus route
  syllabus_worker.py
  Chroma embedding storage
  ← TEST: upload PDF, verify structured JSON + Chroma storage

Layer 6: Deadline Alerts (depends on: Layer 1 + Layer 2 + Layer 3)
  Alert classification via Haiku
  deadline_alert_worker.py
  ← TEST: simulate due_date change in DB, verify SMS fires within 15 min
```

**Critical dependency note:** Gmail integration is in scope but sits at Layer 4 alongside GCal — both require Google OAuth. The shared OAuth client (one Google Cloud project, both scopes) means they should be built together or GCal first to establish the OAuth plumbing, then Gmail reuses the same token flow.

---

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| 0–50 users (MVP beta) | Single Celery worker process on Railway. One Redis instance. Sync all users sequentially. |
| 50–500 users | Increase Celery worker concurrency. Add a dedicated alert queue (high priority) vs. sync queue (low priority). Consider per-user sync windows staggered across the hour. |
| 500–5000 users | Horizontal Celery workers. Redis Sentinel for HA. Rate-limit Canvas fetches per user (already at 120 req/min limit). Consider switching from polling to iCal diff caching with ETag headers if Canvas supports them. |

### Scaling Priorities

1. **First bottleneck at MVP scale:** Claude API rate limits. At 50 users with daily briefings all running at 8am, that's 50 near-simultaneous Opus/Sonnet calls. Stagger send times by +/- a few minutes per user to avoid burst. Tier rate: claude-sonnet-4-6 Sonnet is faster and cheaper for briefings — Opus reserved for syllabus parsing only.

2. **Second bottleneck at 500 users:** Twilio SMS throughput. Long code numbers (non-toll-free) are rate-limited to 1 message/second. At 500 users, a daily briefing blast takes ~8 minutes. This is acceptable for briefings but not for alerts. Solution: use a Twilio Messaging Service with multiple numbers (load balanced) or upgrade to short code.

---

## Anti-Patterns

### Anti-Pattern 1: Calling Claude from Next.js API Routes

**What people do:** Put `anthropic.messages.create()` directly inside a Next.js route handler because it's "simpler."

**Why it's wrong:** Vercel functions have a 30-second timeout (10 seconds on hobby plan). Claude Opus calls can take 15–45 seconds for long documents. The request will timeout, the user gets an error, and the job is lost. Also, you can't retry a failed webhook delivery if the work happened synchronously.

**Do this instead:** Next.js route receives the trigger, validates it, enqueues the Celery task, returns 202 Accepted. Worker handles the Claude call asynchronously.

### Anti-Pattern 2: Direct UI Access to External APIs

**What people do:** Call the Canvas iCal URL or Google Calendar API directly from browser-side code to avoid writing a backend route.

**Why it's wrong:** Exposes OAuth tokens in the browser. No caching layer means every page load re-fetches from Canvas. CORS issues with Canvas. Rate limits hit per-user instead of per-server. Breaks the normalized data model.

**Do this instead:** All external API calls go through `src/lib/integrations/`. The UI only ever reads from Supabase (via Next.js server components or API routes).

### Anti-Pattern 3: Storing Raw Google Access Tokens Without Refresh Logic

**What people do:** Store the `access_token` from Google OAuth and use it until it breaks.

**Why it's wrong:** Google access tokens expire in exactly 3600 seconds. The worker will start failing silently 1 hour after the user connects. At night when briefings run, all tokens are stale.

**Do this instead:** Store both `access_token` and `refresh_token`. Before every Google API call in a worker, check `expires_at` from the `integrations` table. If within 60 seconds of expiry or already expired, use the refresh token to get a new access token, update both tokens in Supabase, then proceed.

### Anti-Pattern 4: Polling Canvas More Frequently Than 60 Minutes

**What people do:** Try to achieve "real-time" Canvas updates by polling every 5 minutes.

**Why it's wrong:** Canvas iCal is a polling endpoint with a 120 req/min rate limit per OAuth token. For 50 users polling every 5 minutes, that's 10 requests/min — fine. But at 500 users polling every 5 minutes, you hit 100 req/min — dangerously close to the limit and you'll get throttled, which silently breaks sync for all users.

**Do this instead:** Stick to 60-minute polling. For the "within 15 min" alert requirement, consider a separate fast-poll only for users who just modified their Canvas settings or are within 24 hours of a known deadline — not for all users constantly.

### Anti-Pattern 5: GCal Push Channel Expiry Not Handled

**What people do:** Register a Google Calendar push notification channel once during OAuth and forget about it.

**Why it's wrong:** GCal push channels expire every 7 days (maximum TTL). After 7 days, Google stops sending push notifications and you have no real-time GCal sync. The failure is silent — no error, no log, just missing events.

**Do this instead:** Store `channel_expiry` in the `integrations` table. Run a Celery Beat task daily that finds channels expiring within 24 hours and re-registers them via `calendar.events.watch()`.

---

## Integration Points

### External Services

| Service | Integration Pattern | Key Notes |
|---------|---------------------|-----------|
| Canvas iCal | HTTP GET, no auth (URL is secret) | Parse with ical.js (Node) or icalendar (Python). Rate limit: 120 req/min. Cache with `synced_at`. |
| Google Calendar API | OAuth 2.0 Authorization Code flow. Tokens stored in `integrations` table. | Refresh tokens before every call. Register push channels. Scope: `calendar`. |
| Gmail API | Same Google OAuth client as Calendar. Separate scope: `gmail.readonly`. | Use `history.list` with a `startHistoryId` to get incremental changes — do NOT use `messages.list` for polling, it's too expensive. |
| Twilio SMS | Outbound: REST API POST to messages endpoint. Inbound: webhook POST to `/api/sms/webhook`. | Validate webhook signature with `twilio-node` `validateRequest()`. Use TwiML for inbound response. |
| Anthropic Claude | REST API, no SDK required but `@anthropic-ai/sdk` (Node) or `anthropic` (Python) recommended. | Use model tiering from CLAUDE.md. Always set `max_tokens`. Pass only bounded context (14 days deadlines, 7 days calendar). |
| Supabase | `@supabase/supabase-js` for Next.js. `supabase-py` for FastAPI workers. | Use service role key in workers (elevated access). Use anon key in frontend. Row-level security for user data isolation. |
| Chroma | Python client (`chromadb`). Run as a sidecar on Railway or embedded in FastAPI process. | Collections per user for syllabus isolation. |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| Next.js API routes ↔ Celery workers | Redis task queue (enqueue/consume). No direct HTTP calls between them. | Next.js enqueues with `celery.send_task()` via a thin Python bridge, or via an HTTP POST to a FastAPI `/enqueue` endpoint that internally calls Celery. The HTTP bridge is simpler for the Next.js side. |
| Celery workers ↔ Supabase | Direct `supabase-py` client calls from Python workers. | Workers use the service role key — they operate with full DB access. This is correct since workers are trusted server-side processes. |
| Next.js (Seb's UI) ↔ Supabase | Via `@supabase/supabase-js` with anon key + RLS policies. | UI never reads from workers directly — it reads from Supabase, which workers write to. This is the correct decoupling. |
| `lib/integrations/` ↔ `lib/sync/` | Direct TypeScript imports. | Integrations are pure functions — they don't import from sync. Sync imports from integrations. Unidirectional dependency. |
| `lib/ai/` ↔ everything | AI modules import from integrations (for context data) and are called by workers. | AI modules must never import from `app/api/` or `lib/sms/`. Keep the dependency graph acyclic. |

---

## Architectural Risks

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Next.js on Vercel, workers on Railway — two separate deploy targets | Medium | Shared secrets via environment variables on both. Keep API contracts simple (JSON over HTTP or task queues). Document deployment steps clearly. |
| GCal push channels expire silently | High | Must implement renewal cron from day one. See Anti-Pattern 5. |
| Google OAuth token refresh not implemented before first outage | High | Build token refresh into the first `gcal.ts` implementation, not as a later enhancement. |
| Celery Beat timezone handling for per-user 8am briefings | Medium | Celery Beat schedules in UTC. Worker must convert user's stored timezone to UTC offset and schedule accordingly. Use `pytz` or `zoneinfo`. Consider: one daily cron that queries "which users have 8am right now?" rather than per-user scheduled tasks. |
| Canvas iCal URL changes when student resets it | Low | User must re-paste URL. Build a health check that flags stale iCal URLs (HTTP 404 or 401) and alerts the user via SMS. |
| Twilio webhook endpoint not publicly accessible in dev | Medium | Use ngrok from day one. Add `TWILIO_WEBHOOK_URL` to environment variables so it can be updated without code changes. |
| Chroma not supported well on Railway as persistent storage | Low | Use Chroma in embedded mode with a persistent volume mount on Railway. For MVP scale, this is fine. Evaluate hosted Chroma or Pinecone if Railway volume constraints become an issue. |

---

## Sources

- Canvas iCal format: RFC 5545 iCalendar spec. Canvas iCal URLs are standard VCALENDAR/VEVENT format. (HIGH confidence — well-established standard)
- Google Calendar push notifications: `https://developers.google.com/calendar/api/guides/push` — 7-day channel expiry is documented there. (HIGH confidence from training data, consistent with stable Google API behavior)
- Google OAuth token expiry (3600 seconds): `https://developers.google.com/identity/protocols/oauth2` — documented. (HIGH confidence)
- Twilio webhook validation pattern: `https://www.twilio.com/docs/usage/security` — X-Twilio-Signature header validation. (HIGH confidence)
- Celery + Redis architecture: `https://docs.celeryq.dev/en/stable/getting-started/backends-and-brokers/redis.html` — standard pattern. (HIGH confidence)
- Anthropic API token limits and context window behavior: training data + CLAUDE.md constraints. (MEDIUM confidence — verify max_tokens behavior per model in current docs)
- Vercel function timeout (30 seconds for Pro, 10 seconds for Hobby): training data. (MEDIUM confidence — verify current limits at `https://vercel.com/docs/functions/runtimes`)

---

*Architecture research for: Student AI SMS assistant (Aria)*
*Researched: 2026-03-18*
