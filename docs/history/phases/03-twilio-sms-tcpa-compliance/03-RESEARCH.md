# Phase 3: Twilio SMS + TCPA Compliance - Research

**Researched:** 2026-03-19
**Domain:** Twilio Messaging API (Python SDK + Node.js SDK), TCPA/10DLC compliance, Celery task architecture, Next.js webhook security
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**TCPA enforcement architecture**
- Centralized guard: a single `send_sms_safe()` function in Python (`celery_worker/sms/`) that all senders call. Opt-out check, quiet hours check, and daily cap check happen in one place.
- When blocked (opted out, quiet hours, or cap hit): drop silently + write a structured log entry (reason, hashed user_id, timestamp). No retry. No DB record for suppressed messages.
- The actual Twilio REST API call is wrapped inside `send_sms_safe()` — callers never import the Twilio client directly.

**TCPA state storage**
- Dedicated columns on `users` table (new migration): `sms_opted_out`, `sms_opted_out_at`, `daily_sms_count`, `daily_sms_date`, `quiet_hours_start`, `quiet_hours_end`
- NOT in `preferences_json` — these fields are queried on every send, must be indexable without JSON parsing.
- User timezone stored in `preferences_json` (already exists) — used to evaluate quiet hours and daily count reset.

**Daily proactive message cap**
- Cap covers proactive/unsolicited messages only (briefings, alerts). Replies to user-initiated texts are uncapped.
- `daily_sms_count` tracks proactive sends only.
- Count resets at midnight in user's local timezone. Compare `daily_sms_date` to today's local date on each send.
- Cap limit: 3 proactive messages/day per user.

**Opt-out and re-opt-in commands**
- STOP: set `sms_opted_out=true`, `sms_opted_out_at=now()`. Send one final confirmation SMS. Then silence.
- START: set `sms_opted_out=false`, clear `sms_opted_out_at`. Send confirmation.
- PAUSE: set `sms_paused_until TIMESTAMPTZ` column (24 hours from now).
- HELP: reply with command list in a single SMS.
- All keyword matching is case-insensitive, exact match on trimmed message body.

**Inbound webhook (upgrade from Phase 1 stub)**
- Location: `src/app/api/sms/webhook/route.ts` (upgrade in place)
- Twilio signature validation: strict in production, bypassed in dev via `TWILIO_DEV_BYPASS=true`
- Invalid signature in production: return HTTP 403 + log warning
- Always return HTTP 200 to legitimate Twilio requests (even on processing errors)
- On valid inbound: return 200 immediately, enqueue Celery task. Never call Claude inline.
- Inbound message logged to `messages` table with `direction='in'` before enqueueing.

**Python SMS module structure**
- New module: `celery_worker/sms/` parallel to `celery_worker/canvas/`
  - `celery_worker/sms/send.py` — `send_sms_safe()` guard + Twilio REST call
  - `celery_worker/sms/commands.py` — keyword detection and command dispatch
- New Celery task: `tasks.process_inbound_sms(message_sid, body, from_hash)`

### Claude's Discretion

- Exact Twilio RequestValidator implementation details
- `sms_paused_until` column type and index (add to same migration as other TCPA columns)
- HELP reply message copy
- Logging format for suppressed messages (structured JSON recommended)
- Whether to use `twilio-python` SDK or raw REST calls (SDK recommended)

### Deferred Ideas (OUT OF SCOPE)

- Natural-language opt-out ("turn off my messages") — Phase 4
- In-app toggle for SMS on/off — Phase 7 frontend
- Conversation reply abuse cap — consider for Phase 4 if needed
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| SMS-01 | System can send outbound SMS to user via Twilio | twilio-python `client.messages.create()` + `send_sms_safe()` wrapper |
| SMS-02 | Twilio inbound webhook returns 200 immediately and enqueues processing to Celery (never inline) | Next.js webhook upgrade: validate → log `messages` → `.delay()` → return 200 |
| SMS-03 | Inbound SMS routed to Claude Sonnet for conversational reply | Phase 4 stub in `process_inbound_sms` task; non-command path stubs handler |
| SMS-04 | Maximum 3 unsolicited SMS per day per user enforced | `daily_sms_count` + `daily_sms_date` columns in `users`; check in `send_sms_safe()` |
| SMS-05 | Quiet hours enforced (no SMS between 10pm–8am in user's timezone) | `zoneinfo` timezone conversion; `quiet_hours_start`/`quiet_hours_end` columns |
| SMS-06 | STOP command immediately opts user out and confirms with final SMS | `commands.py` dispatch; `sms_opted_out=true` update; confirmation via `send_sms_safe()` bypass |
| SMS-07 | PAUSE command suspends SMS for 24 hours | `sms_paused_until TIMESTAMPTZ` column; check in `send_sms_safe()` |
| SMS-08 | HELP command replies with list of commands | `commands.py` HELP branch; single SMS reply |
| SMS-09 | Opt-out status checked before every outbound SMS regardless of carrier-level blocking | Centralized `send_sms_safe()` reads `sms_opted_out` before every Twilio call |
| SYNC-02 | Canvas iCal sync job runs every 60 minutes per user | Already implemented in Phase 2; Beat schedule entry in `celery_app.py` already present — no new work unless verification needed |
</phase_requirements>

---

## Summary

Phase 3 builds the complete SMS pipeline: outbound sending, inbound webhook security, TCPA compliance enforcement, and keyword command handling. The architecture is entirely decided — the research task is to understand the exact APIs, integration patterns, and failure modes so the planner can produce concrete implementation tasks with no ambiguity.

The core abstraction is `send_sms_safe()` in Python. This function gates every outbound message through opt-out, pause, quiet-hours, and daily-cap checks before reaching the Twilio API. All future phases (4: briefings, 5: alerts) call this function — they never import the Twilio client directly. Getting this function right is the highest-risk item in the phase.

The inbound webhook in Next.js (`src/app/api/sms/webhook/route.ts`) is upgraded from its Phase 1 stub to perform Twilio signature validation using the `twilio` npm package's `validateRequest` function, write the inbound message to Supabase, and enqueue a Celery task — all before returning HTTP 200. The primary pitfall is URL reconstruction for signature validation: the URL passed to `validateRequest` must exactly match what Twilio used, including scheme (`https://`), host, and path. Behind a proxy or in local dev (ngrok), this requires care.

**Primary recommendation:** Add `twilio==9.10.3` to `celery_worker/requirements.txt` and `twilio` to `package.json` devDependencies. Build `send_sms_safe()` as the phase's first task because every subsequent task depends on it.

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| twilio (Python) | 9.10.3 | Twilio REST client + RequestValidator | Official SDK; provides `Client`, `messages.create()`, `RequestValidator` |
| twilio (npm) | latest (^5.x) | Webhook signature validation in Next.js route | Official Node.js SDK; `twilio.validateRequest()` function |
| zoneinfo (stdlib) | Python 3.9+ stdlib | IANA timezone conversion for quiet hours | Native Python 3.12; no extra dependency needed; replaces deprecated pytz |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| supabase-py | >=2.0.0 (already in requirements.txt) | DB reads/writes in Celery tasks | Already present; sms/db.py follows canvas/db.py pattern |
| pytest + pytest-mock | >=8.0.0 (already in requirements-dev.txt) | Unit tests mocking Twilio client and Supabase | Already present; all new SMS modules get test files |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| twilio Python SDK | Raw `requests` calls to Twilio REST API | SDK chosen per CONTEXT.md (Claude's discretion resolved to SDK) — avoids manual auth header construction |
| zoneinfo | pytz | pytz is deprecated in Python 3.9+; zoneinfo is stdlib, no install needed |
| Celery task queue | Synchronous processing in webhook | Never — CONTEXT.md locks async; Twilio retries on non-200 would cause duplicate processing |

**Installation:**
```bash
# Python (celery_worker/requirements.txt)
pip install "twilio==9.10.3"

# Node.js (package.json)
npm install twilio
```

**Version verification (confirmed against PyPI 2026-03-19):**
- `twilio` Python: 9.10.3 (released 2026-03-10) — confirmed via PyPI
- `twilio` npm: check `npm view twilio version` before writing package.json

---

## Architecture Patterns

### Recommended Project Structure

```
celery_worker/
├── sms/
│   ├── __init__.py
│   ├── send.py          # send_sms_safe() + Twilio client
│   └── commands.py      # STOP/START/PAUSE/HELP dispatch
├── canvas/              # existing — pattern to replicate
│   ├── fetch.py
│   ├── parse.py
│   ├── diff.py
│   └── db.py
└── tasks.py             # add process_inbound_sms task

celery_worker/tests/
└── sms/
    ├── __init__.py
    ├── test_send.py      # unit tests for send_sms_safe()
    └── test_commands.py  # unit tests for keyword dispatch

src/app/api/sms/
└── webhook/
    └── route.ts          # upgrade from stub — signature validate, DB write, enqueue
```

### Pattern 1: `send_sms_safe()` Guard Function

**What:** All outbound SMS funneled through a single function that checks opt-out, pause, quiet hours, and daily cap before calling the Twilio client.
**When to use:** Every outbound message in every phase. Import from `sms.send` — never import `twilio.rest.Client` directly in other modules.

```python
# Source: Twilio docs — client.messages.create() pattern
# celery_worker/sms/send.py

import os
import json
import logging
import hashlib
from datetime import datetime, timezone, time, date
from zoneinfo import ZoneInfo
from twilio.rest import Client

logger = logging.getLogger(__name__)

def send_sms_safe(
    user_id: str,
    to_phone: str,
    body: str,
    is_proactive: bool = True,
) -> bool:
    """
    Send an SMS through TCPA compliance guards.

    Args:
        user_id: UUID of the recipient user.
        to_phone: Recipient E.164 phone number.
        body: Message body text.
        is_proactive: True for briefings/alerts (counts toward daily cap).
                      False for replies to user-initiated messages (uncapped).

    Returns:
        True if sent, False if suppressed.
    """
    user = _get_user_sms_state(user_id)
    hashed_id = hashlib.sha256(user_id.encode()).hexdigest()[:12]

    # 1. Hard opt-out check
    if user["sms_opted_out"]:
        _log_suppressed(hashed_id, "opted_out")
        return False

    # 2. Pause check
    paused_until = user.get("sms_paused_until")
    if paused_until:
        paused_dt = datetime.fromisoformat(paused_until)
        if datetime.now(timezone.utc) < paused_dt:
            _log_suppressed(hashed_id, "paused")
            return False

    # 3. Quiet hours check (convert UTC now to user's local time)
    tz_name = (user.get("preferences_json") or {}).get("timezone", "America/New_York")
    user_tz = ZoneInfo(tz_name)
    local_now = datetime.now(user_tz)
    local_time = local_now.time()
    qs = time.fromisoformat(user["quiet_hours_start"])  # e.g. "22:00"
    qe = time.fromisoformat(user["quiet_hours_end"])    # e.g. "08:00"
    # Quiet window spans midnight: after 22:00 OR before 08:00
    in_quiet = (local_time >= qs) or (local_time < qe)
    if in_quiet:
        _log_suppressed(hashed_id, "quiet_hours")
        return False

    # 4. Daily cap check (proactive only)
    if is_proactive:
        local_date_str = local_now.date().isoformat()
        if user["daily_sms_date"] == local_date_str:
            if user["daily_sms_count"] >= 3:
                _log_suppressed(hashed_id, "daily_cap")
                return False
        # Reset or increment
        _increment_daily_count(user_id, local_date_str, user)

    # 5. Send via Twilio
    client = Client(
        os.environ["TWILIO_ACCOUNT_SID"],
        os.environ["TWILIO_AUTH_TOKEN"],
    )
    message = client.messages.create(
        from_=os.environ["TWILIO_PHONE_NUMBER"],
        to=to_phone,
        body=body,
    )
    logger.info(json.dumps({"event": "sms_sent", "sid": message.sid, "uid": hashed_id}))
    return True


def _log_suppressed(hashed_id: str, reason: str) -> None:
    logger.info(json.dumps({
        "event": "sms_suppressed",
        "reason": reason,
        "uid": hashed_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }))
```

### Pattern 2: Twilio Signature Validation in Next.js App Router

**What:** Validate `X-Twilio-Signature` using the `twilio` npm package's `validateRequest` function before processing any inbound webhook payload.
**When to use:** First check in the upgraded `route.ts` handler.

```typescript
// Source: Twilio Node.js docs — twilio.validateRequest pattern
// src/app/api/sms/webhook/route.ts (upgrade from stub)

import { NextRequest, NextResponse } from 'next/server'
import twilio from 'twilio'
import { createServiceClient } from '@/lib/supabase/service'

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.text()
    const params = Object.fromEntries(new URLSearchParams(body))

    // Skip signature validation in dev when bypass flag is set
    const isDev = process.env.TWILIO_DEV_BYPASS === 'true'
    if (!isDev) {
      const signature = request.headers.get('x-twilio-signature') ?? ''
      // CRITICAL: URL must match exactly what Twilio used — including https://
      const webhookUrl = process.env.TWILIO_WEBHOOK_URL!
      const isValid = twilio.validateRequest(
        process.env.TWILIO_AUTH_TOKEN!,
        signature,
        webhookUrl,
        params,
      )
      if (!isValid) {
        console.warn('[sms/webhook] invalid signature — possible spoof')
        return new NextResponse('Forbidden', { status: 403 })
      }
    }

    // Log inbound to messages table (direction='in') before enqueueing
    // ... Supabase insert ...

    // Enqueue Celery task via HTTP or Redis — never process inline
    // ... enqueue process_inbound_sms ...

    return new NextResponse('', { status: 200 })
  } catch (err) {
    console.error('[sms/webhook] error:', err)
    return new NextResponse('', { status: 200 }) // always 200 to prevent Twilio retry
  }
}
```

### Pattern 3: `process_inbound_sms` Celery Task

**What:** Processes one inbound message: dispatches to commands.py if keyword match, otherwise stubs Phase 4 Claude handler.
**When to use:** Enqueued by webhook route.

```python
# Source: Established canvas_sync_user pattern in tasks.py
# celery_worker/tasks.py — add alongside canvas tasks

@celery_app.task(name="tasks.process_inbound_sms", bind=True)
def process_inbound_sms(self, message_sid: str, body: str, from_hash: str) -> dict:
    """
    Process one inbound SMS. Dispatch to command handler or stub Claude (Phase 4).

    Args:
        message_sid: Twilio MessageSid for tracing.
        body: Message body text (raw, trimmed).
        from_hash: SHA-256 hash of sender phone number (never plaintext).
    """
    from sms.commands import dispatch_command

    normalized = body.strip().upper()
    dispatched = dispatch_command(normalized, from_hash)

    if not dispatched:
        # Phase 4: route to Claude conversational handler
        pass  # stub

    return {"message_sid": message_sid, "dispatched": dispatched}
```

### Pattern 4: Quiet Hours Logic — Midnight-Spanning Window

**What:** The quiet window (22:00–08:00) spans midnight, requiring special comparison logic.
**Why it matters:** A naive `qs <= time < qe` check fails when the window wraps across midnight.

```python
# Source: Standard Python pattern for overnight time windows
qs = time(22, 0)   # quiet start
qe = time(8, 0)    # quiet end
# Correct midnight-spanning check:
in_quiet = (local_time >= qs) or (local_time < qe)
# Wrong naive check (DO NOT USE):
# in_quiet = qs <= local_time < qe  # breaks for overnight windows
```

### Pattern 5: STOP Confirmation — Final SMS Bypass

**What:** The STOP confirmation SMS must bypass the `sms_opted_out` check because the user just set opt-out=true.
**How:** `commands.py` calls the Twilio client directly for the single confirmation SMS, not `send_sms_safe()`. After the confirmation, all future messages route through the guard.

```python
# celery_worker/sms/commands.py
def handle_stop(user_id: str, to_phone: str) -> None:
    _set_opted_out(user_id, True)
    # Bypass send_sms_safe() — user is opted out, guard would block this
    _send_direct("You've been unsubscribed from Aria. Text START to resubscribe.", to_phone)
```

### Anti-Patterns to Avoid

- **Importing `twilio.rest.Client` outside `sms/send.py`:** Creates bypass paths for TCPA guards. Future phases must always call `send_sms_safe()`.
- **Calling `send_sms_safe()` for STOP confirmation:** The guard reads `sms_opted_out=true` and blocks it. Confirmation must be sent via direct Twilio call after setting opt-out.
- **Naive time comparison for overnight quiet windows:** `22:00 <= time < 08:00` always evaluates False. Use OR logic for midnight-spanning windows.
- **Processing inline in the webhook:** Never call Claude or do DB-heavy work before returning 200. Twilio has a ~15s timeout and will retry on delay.
- **Logging phone numbers in any form:** `request.headers.get('x-twilio-signature')` is fine; never log `params['From']`. Use hashed `user_id` for observability.
- **Using `request.url` directly for RequestValidator in production:** Behind a proxy or Vercel, `request.url` may be an internal URL. Use the canonical public URL from `TWILIO_WEBHOOK_URL` env var.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| HMAC-SHA1 Twilio signature verification | Custom crypto verification | `twilio.validateRequest()` (npm) | Correct handling of parameter sorting, URL encoding, edge cases — Twilio-specified algorithm |
| Twilio REST API calls | `requests.post()` to Twilio API | `twilio.rest.Client.messages.create()` (Python) | SDK handles auth, retry, error parsing, and response object |
| Timezone conversion | Custom UTC offset math | `zoneinfo.ZoneInfo` + `datetime.astimezone()` | Handles DST transitions, historical IANA data automatically |
| Opt-out keyword handling | Custom regex | Exact-match on `body.strip().upper()` | TCPA/carrier standard is exact keyword match, not regex |

**Key insight:** The Twilio SDK's `validateRequest` encodes Twilio's exact signing algorithm including alphabetical parameter sorting. Any hand-rolled implementation that misses one detail (blank values, URL encoding, parameter order) silently fails — legitimate requests get rejected or spoofed requests get accepted.

---

## Common Pitfalls

### Pitfall 1: URL Mismatch in RequestValidator

**What goes wrong:** `validateRequest` returns `False` for every legitimate Twilio request — all inbound SMS rejected with 403.
**Why it happens:** The URL passed to `validateRequest` must be byte-for-byte identical to what Twilio recorded when the webhook was registered. Behind Vercel's edge network or behind ngrok in dev, `request.url` may be an internal URL (`http://...`) while Twilio used `https://your-domain.com/api/sms/webhook`.
**How to avoid:** Store the canonical webhook URL in `TWILIO_WEBHOOK_URL` env var. Use that env var in the validation call — never reconstruct from `request.url` or `request.headers.get('host')`.
**Warning signs:** All inbound SMS return 403 in production; validator works in dev but fails when deployed.

### Pitfall 2: Twilio Retry Loop on Non-200

**What goes wrong:** Twilio retries the webhook repeatedly, processing the same inbound message multiple times.
**Why it happens:** Any non-200 response from the webhook causes Twilio to retry. If an exception is thrown before the `return 200` line, the request gets retried up to 3 times over several minutes.
**How to avoid:** The outer `try/catch` in the webhook MUST return `new NextResponse('', { status: 200 })` in the `catch` block. This is already the Phase 1 pattern — do not break it when adding validation.
**Warning signs:** Duplicate rows in `messages` table; duplicate Celery tasks firing for one user action.

### Pitfall 3: STOP Confirmation Blocked by Guard

**What goes wrong:** The STOP confirmation SMS never arrives. User texts STOP, gets no confirmation, and wonders if it worked.
**Why it happens:** `handle_stop()` sets `sms_opted_out=true` first, then calls `send_sms_safe()` which immediately reads `opted_out=true` and suppresses the message.
**How to avoid:** `commands.py` sends the STOP confirmation directly via Twilio client (not through the guard) immediately after updating the DB, before returning.
**Warning signs:** No outbound record for STOP confirmation in `messages` table; user reports no response to STOP.

### Pitfall 4: Quiet Hours Midnight-Spanning Logic Failure

**What goes wrong:** SMS sent during quiet hours (e.g., 11pm) because the condition evaluates incorrectly.
**Why it happens:** Standard range check `22:00 <= time < 08:00` is always `False` when the window spans midnight, because no single time can satisfy both conditions simultaneously.
**How to avoid:** Use OR logic: `(local_time >= quiet_start) OR (local_time < quiet_end)`.
**Warning signs:** Users receive SMS at 11pm; quiet hours test cases with post-midnight times pass incorrectly.

### Pitfall 5: Daily Count Reset Race Condition

**What goes wrong:** Count resets happen inconsistently or are skipped, allowing more than 3 proactive messages.
**Why it happens:** Multiple Celery workers check `daily_sms_date` simultaneously. If two proactive messages are queued at midnight simultaneously, both see the old date, both reset the count to 0, and both succeed — potentially sending 6 messages.
**How to avoid:** Implement the count increment as a single atomic Supabase RPC (PostgreSQL transaction) that checks-and-increments in one query. Alternatively, use `UPDATE users SET daily_sms_count = CASE WHEN daily_sms_date = $1 THEN daily_sms_count + 1 ELSE 1 END, daily_sms_date = $1 WHERE id = $2 RETURNING daily_sms_count` and check the returned count. If count > 3, suppress and note it's over cap.
**Warning signs:** Users receive 4+ proactive messages per day; count column shows unexpected values.

### Pitfall 6: `celery_app.py` Missing `sms` Module in `include`

**What goes wrong:** `process_inbound_sms` task is never registered; calling `.delay()` raises `NotRegistered` error.
**Why it happens:** Celery only auto-discovers tasks in modules listed in the `include` parameter of `Celery()`.
**How to avoid:** Add `"sms"` (or the specific tasks module path) to the `include` list in `celery_app.py`. Current `include=["tasks"]` — update to also load sms module if tasks are defined there, or add `"sms.tasks"` if split.
**Warning signs:** `celery.exceptions.NotRegistered: 'tasks.process_inbound_sms'` in Celery worker logs.

---

## Code Examples

### Sending SMS (Python)

```python
# Source: https://www.twilio.com/docs/messaging/tutorials/how-to-send-sms-messages
from twilio.rest import Client

client = Client(
    os.environ["TWILIO_ACCOUNT_SID"],
    os.environ["TWILIO_AUTH_TOKEN"],
)
message = client.messages.create(
    from_=os.environ["TWILIO_PHONE_NUMBER"],
    to="+12025551234",
    body="Your briefing is ready.",
)
# message.sid — Twilio MessageSid for logging
```

### Validating Webhook Signature (Node.js/TypeScript)

```typescript
// Source: https://www.twilio.com/en-us/blog/how-to-secure-twilio-webhook-urls-in-nodejs
import twilio from 'twilio'

const isValid = twilio.validateRequest(
  process.env.TWILIO_AUTH_TOKEN!,          // Auth token
  request.headers.get('x-twilio-signature') ?? '',  // Signature header
  process.env.TWILIO_WEBHOOK_URL!,          // MUST be canonical public URL
  params,                                   // Parsed URLSearchParams as object
)
```

### Timezone-Aware Quiet Hours Check (Python)

```python
# Source: https://docs.python.org/3/library/zoneinfo.html
from datetime import datetime, time, timezone
from zoneinfo import ZoneInfo

def is_quiet_hours(tz_name: str, quiet_start: str, quiet_end: str) -> bool:
    """Returns True if current time in user's timezone is within quiet hours."""
    user_tz = ZoneInfo(tz_name)
    local_now = datetime.now(user_tz).time()
    qs = time.fromisoformat(quiet_start)  # "22:00"
    qe = time.fromisoformat(quiet_end)   # "08:00"
    # Midnight-spanning window: in quiet if AFTER start OR BEFORE end
    return (local_now >= qs) or (local_now < qe)
```

### RequestValidator Python (for Celery worker reference)

```python
# Source: https://www.twilio.com/en-us/blog/build-secure-twilio-webhook-python-fastapi
from twilio.request_validator import RequestValidator

validator = RequestValidator(os.environ["TWILIO_AUTH_TOKEN"])
is_valid = validator.validate(
    url,                          # Exact URL Twilio used
    form_params,                  # Dict of POST body params
    x_twilio_signature,           # Value of X-Twilio-Signature header
)
```

### Structured Log Entry for Suppressed SMS

```python
# Logging format — structured JSON, no PII
import json, logging, hashlib
logger = logging.getLogger(__name__)

logger.info(json.dumps({
    "event": "sms_suppressed",
    "reason": "opted_out",  # or "quiet_hours", "daily_cap", "paused"
    "uid": hashlib.sha256(user_id.encode()).hexdigest()[:12],
    "timestamp": datetime.now(timezone.utc).isoformat(),
}))
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `pytz` for timezone handling | `zoneinfo` (stdlib) | Python 3.9+ (deprecated pytz) | No extra install, handles DST correctly, no `.localize()` quirk |
| Custom HMAC-SHA1 verification | `twilio.validateRequest()` / `RequestValidator` | Always been best practice | Correct parameter sorting, no manual crypto |
| Process webhook inline | Return 200 immediately + async queue | 10DLC/carrier best practice | Prevents Twilio retry loops; required for <1s webhook response |

**Deprecated/outdated:**
- `pytz`: deprecated in favor of `zoneinfo`. Do not add `pytz` to requirements.
- `@supabase/auth-helpers`: deprecated — project already uses `@supabase/ssr` (established in Phase 1).

---

## Open Questions

1. **Celery task enqueueing mechanism from Next.js**
   - What we know: The webhook route (Node.js) must enqueue a Python Celery task. Canvas sync uses Beat schedule — there's no existing pattern for Next.js → Celery task dispatch.
   - What's unclear: How does the Next.js webhook route trigger `process_inbound_sms.delay()`? Options: (a) Next.js route publishes directly to Redis using `ioredis`, (b) internal HTTP call to a Celery HTTP API, (c) shared Supabase flag polled by Beat.
   - Recommendation: Use `ioredis` to push a Celery-formatted task directly to the Redis broker. This is the lowest-latency approach and matches how Celery expects tasks. Requires knowing the Celery task message format for direct Redis publish.

2. **`sms_paused_until` index**
   - What we know: Column is `TIMESTAMPTZ` nullable on `users` table.
   - What's unclear: Whether a partial index on `sms_paused_until IS NOT NULL` is needed at MVP scale.
   - Recommendation: Add a simple partial index in the migration: `CREATE INDEX idx_users_sms_paused ON users (id) WHERE sms_paused_until IS NOT NULL;` — negligible cost, useful if user table grows.

3. **Twilio webhook URL for local dev**
   - What we know: ngrok is the standard tool. `TWILIO_DEV_BYPASS=true` bypasses signature validation.
   - What's unclear: Whether the plan should include ngrok setup instructions.
   - Recommendation: Document the ngrok pattern in the plan's local dev setup task. Use `TWILIO_DEV_BYPASS=true` in `.env.local`; never hardcode bypass in production code.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | pytest 8.0.0 + pytest-mock 3.12.0 |
| Config file | `celery_worker/pytest.ini` (exists) |
| Quick run command | `cd celery_worker && pytest tests/sms/ -x -q` |
| Full suite command | `cd celery_worker && pytest -x -q` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SMS-01 | `send_sms_safe()` calls `client.messages.create()` with correct params | unit | `pytest tests/sms/test_send.py -x` | Wave 0 |
| SMS-02 | Webhook returns 200 immediately; Celery task enqueued | unit | `pytest tests/sms/test_webhook.py -x` (Next.js — needs Jest) | Wave 0 |
| SMS-04 | Daily cap blocks 4th proactive message, allows 4th reply | unit | `pytest tests/sms/test_send.py::test_daily_cap -x` | Wave 0 |
| SMS-05 | Quiet hours suppresses at 11pm, allows at 9am | unit | `pytest tests/sms/test_send.py::test_quiet_hours -x` | Wave 0 |
| SMS-06 | STOP sets `sms_opted_out=true`; confirmation sent directly | unit | `pytest tests/sms/test_commands.py::test_stop -x` | Wave 0 |
| SMS-07 | PAUSE sets `sms_paused_until = now + 24h`; guard blocks during pause | unit | `pytest tests/sms/test_commands.py::test_pause -x` | Wave 0 |
| SMS-08 | HELP returns command list SMS | unit | `pytest tests/sms/test_commands.py::test_help -x` | Wave 0 |
| SMS-09 | Opted-out user: `send_sms_safe()` returns False without calling Twilio | unit | `pytest tests/sms/test_send.py::test_opted_out -x` | Wave 0 |
| SYNC-02 | Beat schedule entry has `canvas-sync-all-users` at 3600s | unit | `pytest tests/test_celery_app.py -x` | EXISTS |

**Note on SMS-02 (webhook):** The Next.js route is TypeScript; Jest/ts-jest would be needed for unit tests. Given the project currently has no Jest config, the webhook validation is best covered by a manual smoke test (send a test SMS via Twilio console) rather than a new test framework. Mark as manual-only for this phase.

### Sampling Rate

- **Per task commit:** `cd celery_worker && pytest tests/sms/ -x -q`
- **Per wave merge:** `cd celery_worker && pytest -x -q`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `celery_worker/tests/sms/__init__.py` — package init
- [ ] `celery_worker/tests/sms/test_send.py` — covers SMS-01, SMS-04, SMS-05, SMS-09
- [ ] `celery_worker/tests/sms/test_commands.py` — covers SMS-06, SMS-07, SMS-08
- [ ] `celery_worker/sms/__init__.py` — module init
- [ ] Framework already installed (`pytest`, `pytest-mock` in requirements-dev.txt) — no new installs needed

---

## Sources

### Primary (HIGH confidence)
- `https://pypi.org/project/twilio/` — confirmed version 9.10.3 (released 2026-03-10)
- `https://www.twilio.com/docs/usage/webhooks/webhooks-security` — X-Twilio-Signature, HMAC-SHA1 algorithm
- `https://www.twilio.com/en-us/blog/build-secure-twilio-webhook-python-fastapi` — RequestValidator Python exact code
- `https://www.twilio.com/en-us/blog/how-to-secure-twilio-webhook-urls-in-nodejs` — `twilio.validateRequest()` Node.js exact code
- `https://www.twilio.com/docs/messaging/tutorials/how-to-send-sms-messages` — `client.messages.create()` pattern
- `https://docs.python.org/3/library/zoneinfo.html` — zoneinfo stdlib, Python 3.9+ replacement for pytz
- Existing codebase: `celery_worker/canvas/db.py`, `tasks.py`, `celery_app.py`, `tests/canvas/test_db.py` — established patterns replicated for SMS module

### Secondary (MEDIUM confidence)
- `https://www.twilio.com/docs/messaging/compliance/a2p-10dlc` — 10DLC requirements; STOP/START carrier requirement confirmed
- `https://activeprospect.com/blog/tcpa-text-messages/` — TCPA opt-out rules; April 2025 changes requiring 10-business-day opt-out honoring
- `https://github.com/twilio/twilio-node/issues/321` — Proxy HTTPS→HTTP URL mismatch pitfall confirmed via community issue

### Tertiary (LOW confidence)
- WebSearch results on TCPA daily message caps — no federal mandate for exact daily cap numbers found; project's 3/day cap is a product-level decision, not a legal requirement per research

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — confirmed via PyPI, official Twilio docs, existing project requirements.txt
- Architecture: HIGH — locked decisions in CONTEXT.md; code examples verified against official Twilio SDK documentation
- Pitfalls: HIGH (URL mismatch, retry loop, midnight-spanning window) verified via official docs and GitHub issues; MEDIUM (race condition) based on standard concurrency reasoning
- TCPA compliance details: MEDIUM — core STOP/START/quiet-hours requirements confirmed via official sources; specific 3/day cap is a product decision not a legal mandate

**Research date:** 2026-03-19
**Valid until:** 2026-04-19 (30 days; Twilio SDK and TCPA rules are stable)
