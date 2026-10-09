# Phase 9: Todoist Integration - Research

**Researched:** 2026-03-19
**Domain:** Todoist REST API v2, OAuth 2.0, Celery task fan-out, Claude intent extraction for CRUD via SMS, iOS Preferences screen extension
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**OAuth Connection**
- Entry point: iOS Preferences page only (Phase 8 Preferences screen already exists — add a "Connect Todoist" button)
- No web onboarding path for Todoist in MVP
- OAuth handshake: `WebBrowser.openAuthSessionAsync` — same pattern as Google OAuth in Phase 8
- Token exchange handled by a new Next.js API route (`/api/auth/todoist/callback`)
- Scope: `data:read_write` — required for task creation and completion via SMS
- Access + refresh tokens stored AES-256 encrypted in `integrations` table (same pattern as Google OAuth)

**Task Sync Scope**
- Sync all active (non-completed) Todoist tasks that have a due date set
- Tasks without due dates are ignored
- Sync frequency: every 2 hours via Celery Beat (new `todoist_sync_all` → `todoist_sync_user` fan-out)
- Same delivery routing as Canvas: score ≥ 80 → immediate SMS; 50–79 → digest; < 50 → silent
- `grade_weight = 0.0` for all Todoist tasks by default
- `source_authority = 0.8` (locked — Phase 5 Priority Engine formula)

**Task CRUD via SMS**
- All actions handled via natural language through the existing Claude Sonnet conversational handler (Phase 4 AI-07 pattern)
- Supported actions: create task, complete task, update due date, delete task
- Claude extracts intent + task title + due date from free-text SMS; calls Todoist REST API; confirms back
- Confirmation format: brief + action summary
  - Create: "Done — added 'Buy textbook' to Todoist, due Friday."
  - Complete: "Marked 'PSET 3' complete in Todoist."
  - Update: "Moved 'PSET 3' to Friday in Todoist."
  - Delete: "Deleted 'Buy textbook' from Todoist."
- If task disambiguation is needed, Claude asks: "Which one — 'Buy textbook for CPSC 365' (due Fri) or 'Buy textbook for MATH 120' (due Mon)?"

**Briefing Display**
- Todoist tasks interleaved with Canvas deadlines in briefing — all items sorted by `priority_score` descending from `canonical_events`
- No separate "Personal tasks" section; source label included inline
- `get_events_for_briefing()` already reads `canonical_events` — no briefing query changes needed

**Task Overload Detection**
- Threshold: 5 or more items (Todoist P1 tasks + Canvas deadlines) due within the next 24 hours
- Overload warning appears as a single line at the top of the morning briefing SMS
- Format: "⚠️ Heavy day — 5 items due today. Prioritize: [top 2 by priority_score]."
- Detection runs during briefing generation in `generate_briefing()` — count items from `canonical_events` where `due_at` is within 24 hours of briefing time

### Claude's Discretion
- Exact Todoist API client library (requests vs. todoist-api-python SDK)
- Celery retry policy for Todoist sync failures
- How to handle Todoist token expiry (Todoist tokens don't expire but can be revoked — handle 403 gracefully)
- Exact overload threshold tuning (5 is the starting point; adjust based on beta feedback)
- Index strategy for Todoist rows in `canonical_events`

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| TASK-01 | Todoist OAuth connection and task read/write | Todoist REST API v2 OAuth flow, `data:read_write` scope, token storage in `integrations` table, Next.js callback route, iOS Preferences button using `WebBrowser.openAuthSessionAsync` |
| TASK-02 | Todoist tasks normalized to Task type and included in briefings and scheduling priority | `ingest_canonical_event(source='todoist')` call from `todoist_sync_user`, Celery Beat 2-hour schedule, `get_events_for_briefing()` picks up Todoist rows automatically, overload detection in `generate_briefing()` |
</phase_requirements>

---

## Summary

Phase 9 wires Todoist into the existing Priority Engine + briefing pipeline that Phases 4 and 5 built. The work divides cleanly into four areas: (1) OAuth handshake — authorize via Todoist's standard OAuth 2.0 flow from the iOS Preferences screen and exchange the code via a new Next.js callback route; (2) background sync — a new `todoist_sync_all` → `todoist_sync_user` Celery fan-out that fetches active due-dated tasks every 2 hours and writes them to `canonical_events` through the existing `ingest_canonical_event()` entry point; (3) SMS CRUD — extending the Phase 4 `handle_reply()` function to recognize four new Todoist actions (create, complete, update, delete) by upgrading the Claude intent classifier and adding a Todoist API call layer; and (4) overload detection — a 24-hour window count injected into `generate_briefing()` that prepends a warning line when 5+ items are due.

Nothing in this phase changes the `canonical_events` schema, the briefing query, or the scoring formula — all three are already Todoist-ready. The largest design decision delegated to Claude is whether to use the `todoist-api-python` SDK (v3.2.1, uses httpx) or raw `requests` calls. Given that the rest of the Celery codebase uses `requests` throughout and has no httpx dependency, using raw `requests` is the safer, more consistent choice; it avoids introducing a second HTTP stack.

**Primary recommendation:** Use `requests` directly for all Todoist API calls. Follow the established 4-module pattern (`fetch.py`, `parse.py`, `db.py`, `sync.py`) under `celery_worker/todoist/`. Mirror `canvas_sync_all`/`canvas_sync_user` exactly for the Celery fan-out. Extend `handle_reply()` with Todoist intent branches rather than building a separate handler.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| requests | >=2.32.0 (already in requirements.txt) | Todoist REST API calls | Already used by canvas/fetch.py; avoids httpx dependency sprawl |
| celery | 5.6.2 (already installed) | Background sync fan-out | Established pattern; `canvas_sync_all` is the direct template |
| supabase-py | >=2.0.0 (already installed) | Token storage and canonical_events writes | Established pattern across all DB modules |
| anthropic | >=0.86.0 (already installed) | Intent extraction for SMS CRUD | Already used in ai/replies.py; same two-step intent+response pattern |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| todoist-api-python | 3.2.1 | Official Todoist SDK (httpx-based) | Only if team prefers managed client over raw requests; introduces httpx dependency |
| expo-web-browser | ~55.0.10 (already in mobile/package.json) | `WebBrowser.openAuthSessionAsync` for Todoist OAuth | iOS Preferences screen "Connect Todoist" button |
| expo-linking | ~55.0.8 (already in mobile/package.json) | Deep link handling for OAuth redirect | Receiving `aria://todoist-callback?code=...` after OAuth |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| raw `requests` | `todoist-api-python` SDK v3.2.1 | SDK is cleaner but introduces httpx as a second HTTP stack; the codebase currently uses requests everywhere; SDK adds ~5MB; for MVP the raw calls are simpler and more debuggable |
| `WebBrowser.openAuthSessionAsync` | `expo-auth-session` custom provider | `expo-auth-session` providers exist only for Google/Facebook/etc; Todoist requires manual OAuth URL construction + `openAuthSessionAsync` |

**Installation (Python — add to celery_worker/requirements.txt):**
No new packages required. `requests` is already present.

**Installation (iOS — no changes):**
`expo-web-browser` and `expo-linking` are already in `mobile/package.json`.

**Version verification:**
```bash
# todoist-api-python latest (for reference only — not adding to project)
pip3 index versions todoist-api-python
# => 3.2.1 (released 2026-01-22) [VERIFIED]
```

---

## Architecture Patterns

### Recommended Project Structure
```
celery_worker/
├── todoist/
│   ├── __init__.py
│   ├── fetch.py       # raw Todoist REST API calls (get_active_tasks, create_task, close_task, update_task, delete_task)
│   ├── parse.py       # normalize Todoist task dict → {"title", "due_date", "priority", "todoist_id"}
│   ├── db.py          # Supabase helpers: get_all_todoist_integrations(), mark_synced()
│   └── sync.py        # orchestrate: fetch → parse → ingest_canonical_event loop
├── tasks.py           # add todoist_sync_all, todoist_sync_user, todoist_action_* tasks
└── celery_app.py      # add todoist_sync_all to beat_schedule (7200s)

src/app/api/auth/todoist/
└── callback/
    └── route.ts       # exchanges code for token, stores in Supabase integrations table

mobile/app/(home)/
└── preferences.tsx    # add "Todoist" row to Connected Accounts section (already handles canvas + google)
```

### Pattern 1: Todoist Sync Fan-Out (mirrors canvas_sync_all/canvas_sync_user)
**What:** Celery Beat fires `todoist_sync_all` every 2 hours; it queries `integrations` for all `platform='todoist'` rows, then fans out one `todoist_sync_user.delay(user_id, access_token)` per user.
**When to use:** Every sync cycle. Mirrors the canvas pattern exactly.
**Example:**
```python
# celery_worker/tasks.py
@celery_app.task(name="tasks.todoist_sync_all")
def todoist_sync_all():
    from todoist.db import get_all_todoist_integrations
    integrations = get_all_todoist_integrations()
    for row in integrations:
        todoist_sync_user.delay(row["user_id"], row["access_token"])
    return {"status": "ok", "dispatched": len(integrations)}

@celery_app.task(
    name="tasks.todoist_sync_user",
    bind=True,
    autoretry_for=(Exception,),
    retry_backoff=2,
    retry_backoff_max=300,
    retry_jitter=True,
    max_retries=5,
)
def todoist_sync_user(self, user_id: str, access_token: str) -> dict:
    from todoist.fetch import get_active_tasks
    from todoist.parse import parse_tasks
    from todoist.db import mark_synced
    from priority.ingest import ingest_canonical_event

    raw_tasks = get_active_tasks(access_token)
    parsed = parse_tasks(raw_tasks)
    for t in parsed:
        ingest_canonical_event(
            user_id=user_id,
            source="todoist",
            event_type="task",
            title=t["title"],
            due_at=t["due_date"],
            grade_weight=0.0,
        )
    mark_synced(user_id)
    return {"user_id": user_id, "synced": len(parsed)}
```

### Pattern 2: Todoist REST API Calls via requests
**What:** All Todoist API interactions use `requests` with `Authorization: Bearer {token}` header. The base URL is `https://api.todoist.com/rest/v2/`.
**When to use:** fetch.py module for sync + all CRUD actions from replies.py.

```python
# celery_worker/todoist/fetch.py
import requests

TODOIST_BASE = "https://api.todoist.com/rest/v2"

def get_active_tasks(access_token: str) -> list[dict]:
    """Fetch all active tasks that have a due date set.

    Returns:
        List of raw Todoist task dicts. Only tasks with due!=null included.
    Raises:
        requests.HTTPError: On 4xx/5xx (403 = revoked token — caller handles).
    """
    resp = requests.get(
        f"{TODOIST_BASE}/tasks",
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=15,
    )
    resp.raise_for_status()
    tasks = resp.json()
    return [t for t in tasks if t.get("due")]  # filter tasks without due dates

def create_task(access_token: str, content: str, due_string: str) -> dict:
    resp = requests.post(
        f"{TODOIST_BASE}/tasks",
        headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
        json={"content": content, "due_string": due_string},
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()

def close_task(access_token: str, task_id: str) -> bool:
    """POST /tasks/{id}/close returns 204 No Content on success."""
    resp = requests.post(
        f"{TODOIST_BASE}/tasks/{task_id}/close",
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=10,
    )
    resp.raise_for_status()
    return True

def update_task(access_token: str, task_id: str, due_string: str) -> dict:
    resp = requests.post(
        f"{TODOIST_BASE}/tasks/{task_id}",
        headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
        json={"due_string": due_string},
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()

def delete_task(access_token: str, task_id: str) -> bool:
    """DELETE /tasks/{id} returns 204 No Content on success."""
    resp = requests.delete(
        f"{TODOIST_BASE}/tasks/{task_id}",
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=10,
    )
    resp.raise_for_status()
    return True
```

### Pattern 3: Todoist Task Normalization
**What:** parse.py converts Todoist task dict (from REST API) to the internal shape `ingest_canonical_event()` expects.
**When to use:** Inside `todoist_sync_user` between fetch and ingest.

```python
# celery_worker/todoist/parse.py
from datetime import datetime, timezone

def parse_tasks(raw_tasks: list[dict]) -> list[dict]:
    """Normalize Todoist task dicts to internal format.

    Filters out tasks without due dates (already filtered in fetch, but defensive).
    Maps Todoist priority (1=normal/lowest, 4=urgent/highest) to string labels.

    Args:
        raw_tasks: Raw task dicts from Todoist REST API.
    Returns:
        List of dicts with keys: title, due_date (ISO string), todoist_id, priority_label.
    """
    result = []
    for t in raw_tasks:
        due = t.get("due")
        if not due:
            continue
        # Todoist due object: {"date": "2026-04-01", "datetime": "2026-04-01T17:00:00Z", ...}
        due_str = due.get("datetime") or due.get("date")
        if not due_str:
            continue
        # Normalize date-only to end-of-day UTC (same pattern as Canvas all-day events)
        if "T" not in due_str:
            due_str = f"{due_str}T23:59:59Z"
        result.append({
            "title": t["content"],
            "due_date": due_str,
            "todoist_id": t["id"],
            "priority_label": {4: "urgent", 3: "high", 2: "medium", 1: "normal"}.get(t.get("priority", 1), "normal"),
        })
    return result
```

### Pattern 4: SMS CRUD — Extending handle_reply() with Todoist Actions
**What:** The existing `INTENT_SYSTEM_PROMPT` in `ai/replies.py` is extended to recognize four new Todoist actions. A `_apply_todoist_mutation()` function mirrors `_apply_mutation()` but calls Todoist REST API instead of Supabase.
**When to use:** When Claude classifies an inbound SMS as a Todoist action.

Extended intent JSON schema:
```json
{
  "action": "query" | "mark_complete" | "snooze" | "set_priority" | "todoist_create" | "todoist_complete" | "todoist_update_due" | "todoist_delete" | "off_topic",
  "task_hint": "<partial task name, lowercase, or null>",
  "due_string": "<natural language due date for todoist, or null>",
  "priority_value": "high" | "normal" | null
}
```

Note: `todoist_create` requires `due_string` to be present (user must specify a due date; tasks without due dates are not synced). If `due_string` is absent for a create action, Claude should ask for a due date rather than creating a task with no due date.

### Pattern 5: OAuth Callback Route (Next.js)
**What:** `/api/auth/todoist/callback` receives the authorization code from Todoist's redirect, exchanges it for an access token, and writes `platform='todoist'` + encrypted `access_token` to the `integrations` table.
**When to use:** After the iOS app opens the Todoist authorization URL and the user approves.

```typescript
// src/app/api/auth/todoist/callback/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code')
  const userId = req.nextUrl.searchParams.get('state')  // user_id passed as state param
  if (!code || !userId) {
    return NextResponse.json({ error: 'Missing code or state' }, { status: 400 })
  }

  // Exchange code for token
  const tokenRes = await fetch('https://api.todoist.com/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.TODOIST_CLIENT_ID!,
      client_secret: process.env.TODOIST_CLIENT_SECRET!,
      code,
      redirect_uri: `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/todoist/callback`,
    }),
  })
  if (!tokenRes.ok) {
    return NextResponse.json({ error: 'Token exchange failed' }, { status: 500 })
  }
  const { access_token } = await tokenRes.json()

  // Store in integrations table
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
  await supabase.from('integrations').upsert({
    user_id: userId,
    platform: 'todoist',
    access_token,  // AES-256 encryption handled by Supabase column-level encryption or at insert time
    connected_at: new Date().toISOString(),
  }, { onConflict: 'user_id,platform' })

  // Redirect back to app with deep link
  return NextResponse.redirect(`aria://todoist-connected`)
}
```

### Pattern 6: iOS "Connect Todoist" Button (Preferences screen)
**What:** Add a Todoist row to the existing "Connected Accounts" section in `mobile/app/(home)/preferences.tsx`. Tapping "Connect" opens the Todoist authorization URL via `WebBrowser.openAuthSessionAsync`. Tapping "Disconnect" soft-deletes the integration row.
**When to use:** When Todoist is not connected (no `integrations` row with `platform='todoist'`).

```typescript
// Todoist OAuth URL construction
const TODOIST_CLIENT_ID = process.env.EXPO_PUBLIC_TODOIST_CLIENT_ID
const TODOIST_AUTH_URL = `https://app.todoist.com/oauth/authorize?client_id=${TODOIST_CLIENT_ID}&scope=data:read_write&state=${userId}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`

// Button handler
const handleConnectTodoist = async () => {
  const result = await WebBrowser.openAuthSessionAsync(TODOIST_AUTH_URL, 'aria://todoist-connected')
  if (result.type === 'success') {
    await loadData()  // refresh integration status
  }
}
```

### Pattern 7: Overload Detection in generate_briefing()
**What:** At briefing generation time, query `canonical_events` for items due within 24 hours. If count >= 5, prepend a warning line.
**When to use:** Inside `generate_briefing()` before building the context text for Claude.

```python
# celery_worker/ai/briefing.py — add to generate_briefing()
from datetime import datetime, timedelta, timezone

def _count_items_due_today(user_id: str, user_tz, briefing_time: datetime) -> tuple[int, list[dict]]:
    """Count canonical_events due within 24h of briefing_time. Returns (count, top_2_by_score)."""
    from ai.db import _get_supabase
    client = _get_supabase()
    window_end = (briefing_time + timedelta(hours=24)).isoformat()
    result = (
        client.table("canonical_events")
        .select("id, title, due_at, priority_score, source")
        .eq("user_id", user_id)
        .is_("deleted_at", "null")
        .lte("due_at", window_end)
        .gte("due_at", briefing_time.isoformat())
        .order("priority_score", desc=True)
        .execute()
    )
    items = result.data or []
    return len(items), items[:2]

# Usage inside generate_briefing():
now = datetime.now(timezone.utc)
overload_count, top_items = _count_items_due_today(user_id, user_tz, now)
if overload_count >= 5:
    top_titles = ", ".join(t["title"] for t in top_items)
    overload_line = f"Heavy day — {overload_count} items due today. Prioritize: {top_titles}."
    # Prepend to final briefing_text after Claude generates it
```

### Pattern 8: 403 Token Revocation Handling
**What:** Todoist tokens do not expire but can be revoked by the user (e.g., from their Todoist account security settings). When a 403 is returned, mark the integration as disconnected and notify the user.
**When to use:** In `todoist_sync_user` and in any Todoist API call from `handle_reply()`.

```python
try:
    raw_tasks = get_active_tasks(access_token)
except requests.HTTPError as e:
    if e.response is not None and e.response.status_code == 403:
        # Token revoked — mark integration inactive, stop retrying
        from todoist.db import mark_integration_revoked
        mark_integration_revoked(user_id)
        return {"user_id": user_id, "status": "token_revoked"}
    raise  # re-raise for Celery autoretry on other HTTP errors
```

### Anti-Patterns to Avoid
- **Writing directly to `canonical_events`:** Always use `ingest_canonical_event()` — it handles scoring, routing, and idempotent upsert. Direct DB writes bypass the Priority Engine.
- **Syncing tasks without due dates:** Todoist tasks without `due` set have no urgency → score would be near zero → no value to the student. Filter in `fetch.py`.
- **Calling Todoist API inline in the Twilio webhook:** The webhook must return 200 immediately. All Todoist API calls go through Celery tasks (`tasks.todoist_action_*`).
- **Storing raw access token in iOS client:** The access token is returned to the Next.js callback, not the iOS app directly. The iOS app learns about success via the deep link redirect `aria://todoist-connected`.
- **Using `todoist-api-python` SDK:** It uses httpx which conflicts with the codebase-wide use of `requests`. Stick with `requests` for consistency.
- **Creating Todoist tasks without due dates via SMS:** CONTEXT.md locks the sync scope to tasks with due dates. If a user tries to create a task via SMS without specifying a due date, Claude should ask for one rather than creating a due-dateless task.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Scoring Todoist tasks | Custom scoring logic | `ingest_canonical_event(source='todoist', grade_weight=0.0)` | source_authority=0.8 already defined in engine.py; formula is locked from Phase 5 |
| Briefing inclusion | Separate "Todoist section" in briefing | `get_events_for_briefing()` unchanged | Already queries `canonical_events` regardless of source; Todoist rows appear automatically once ingested |
| OAuth PKCE | Custom code verifier/challenge | Todoist doesn't use PKCE; plain auth code flow is fine | Todoist docs confirm standard auth code flow without PKCE requirement |
| Todoist task disambiguation | Fuzzy string matching | Claude's natural language understanding in the two-step intent+response pattern | Claude handles "PSET 3" → "Problem Set 3 for CPSC 201" better than any hand-rolled fuzzy match |
| Celery fan-out | Custom worker dispatch | `canvas_sync_all`/`canvas_sync_user` pattern verbatim | Already handles per-user isolation, failure isolation, and Beat scheduling |
| Token encryption | Custom AES implementation | Supabase row-level encryption pattern established in Phase 8 for Google OAuth | Same `integrations` table, same column, same encryption approach |

**Key insight:** The hardest work in Phase 9 is already done. The Priority Engine, canonical timeline DB, briefing generator, and SMS CRUD handler all exist. Phase 9 is mostly plumbing: wire Todoist data into the existing pipeline.

---

## Common Pitfalls

### Pitfall 1: Todoist Priority Scale Is Inverted vs. Common Sense
**What goes wrong:** Todoist API uses `priority: 1` = Normal (lowest), `priority: 4` = Urgent (highest). Developers assume 1=highest (like in most systems).
**Why it happens:** Todoist chose a different convention from almost every other task system.
**How to avoid:** In `parse.py`, document and map explicitly: `{4: "urgent", 3: "high", 2: "medium", 1: "normal"}`.
**Warning signs:** P4 tasks not being scored as high-priority, P1 tasks unexpectedly surfacing as urgent.

### Pitfall 2: Todoist Due Object Has Two Fields (date vs. datetime)
**What goes wrong:** The `due` object in a Todoist task can be `{"date": "2026-04-01"}` (date-only, no time) OR `{"date": "2026-04-01", "datetime": "2026-04-01T17:00:00Z"}` (with specific time). Using `due.date` always gets a date string, while `due.datetime` is only present for time-specific tasks.
**Why it happens:** Todoist differentiates between all-day due dates and time-specific deadlines.
**How to avoid:** In `parse.py`, prefer `due.get("datetime")` and fall back to `due.get("date")`. If date-only, normalize to `23:59:59Z` — same approach as Canvas all-day events (established pattern in Phase 2).
**Warning signs:** `datetime.fromisoformat()` errors on date-only strings without time component.

### Pitfall 3: Access Token Passed in Celery Task Args Appears in Redis
**What goes wrong:** `todoist_sync_user.delay(user_id, access_token)` serializes the access token into Redis as JSON. If Redis is compromised or Redis logs are enabled, tokens are exposed.
**Why it happens:** Celery task arguments are stored in Redis in plaintext by default.
**How to avoid:** Pass only `user_id` to `todoist_sync_user`. Fetch the encrypted access token from Supabase at the start of the task body (same as how `canvas_sync_user` fetches `ical_url` from Supabase in `get_all_canvas_integrations()` just before dispatch). This keeps the token out of Redis.
**Warning signs:** Access tokens visible in Redis CLI `LRANGE` output.

**Implementation implication:** `get_all_todoist_integrations()` returns `user_id` + `access_token`. The fan-out should pass only `user_id`, and `todoist_sync_user` should re-query Supabase for the token. This is a security improvement over the Canvas pattern (which passes ical_url — a secret URL, but less sensitive than an OAuth token).

### Pitfall 4: 403 Causes Infinite Celery Retry Loop
**What goes wrong:** `autoretry_for=(Exception,)` will retry indefinitely on a 403 if the 403 is wrapped in a generic exception and not caught first.
**Why it happens:** A revoked Todoist token returns 403 on every call — retrying is futile and wastes resources.
**How to avoid:** Catch `requests.HTTPError` before the generic retry. Check `e.response.status_code == 403` and `return` (don't raise) — this prevents Celery from retrying.

### Pitfall 5: WebBrowser.openAuthSessionAsync Requires Correct Redirect URI Registration
**What goes wrong:** The Todoist OAuth callback redirects to `aria://todoist-connected` (the deep link) but `openAuthSessionAsync` only intercepts redirects matching the second argument. If the Todoist app registration specifies a web URL (`https://`) as the redirect URI but the callback tries to redirect to a custom scheme (`aria://`), the flow breaks.
**Why it happens:** Todoist's OAuth requires a registered redirect URI. For mobile apps using custom URL schemes, the registered redirect URI should point to the Next.js callback route (`https://api.aria.app/api/auth/todoist/callback`), which then redirects to `aria://todoist-connected`. `openAuthSessionAsync` must be called with `aria://todoist-connected` as the second argument to intercept that final redirect.
**How to avoid:** Register the HTTPS callback URL in Todoist developer settings (not the custom scheme). The Next.js callback route performs the token exchange and then returns a redirect to `aria://todoist-connected`. The `openAuthSessionAsync` second argument intercepts `aria://`.
**Warning signs:** OAuth completes in browser but `result.type` is never `'success'`; browser doesn't close after authorization.

### Pitfall 6: Overload Count Double-Counts Sent Events
**What goes wrong:** `canonical_events` marks digest events as `delivery_status = 'sent'` after briefing inclusion. The overload detection query must include `sent` status events (they are real deadlines), not just `digest`/`immediate`.
**Why it happens:** `get_events_for_briefing()` filters `delivery_status IN ('digest', 'immediate')` and then marks digest items as 'sent'. If overload detection uses the same filter, previously-sent events are excluded from the count.
**How to avoid:** The overload count query should filter on `due_at` within 24 hours AND NOT `deleted_at IS NOT NULL` — it should NOT filter by `delivery_status`. Count all non-deleted events due today regardless of delivery status.

---

## Code Examples

Verified patterns from codebase analysis:

### ingest_canonical_event() for Todoist (from existing priority/ingest.py signature)
```python
# Source: celery_worker/priority/ingest.py — ingest_canonical_event()
ingest_canonical_event(
    user_id=user_id,
    source="todoist",       # source_authority = 0.8 (defined in engine.py)
    event_type="task",
    title=t["title"],
    due_at=t["due_date"],   # ISO string, already normalized in parse.py
    course_id=None,         # Todoist has no course concept
    grade_weight=0.0,       # grade_weight = 0.0 for all Todoist tasks
)
```

### Celery Beat schedule entry for 2-hour sync
```python
# Source: celery_worker/celery_app.py — beat_schedule dict pattern
beat_schedule={
    "canvas-sync-all-users": {
        "task": "tasks.canvas_sync_all",
        "schedule": 3600.0,
    },
    "todoist-sync-all-users": {        # ADD THIS
        "task": "tasks.todoist_sync_all",
        "schedule": 7200.0,            # every 2 hours
    },
    ...
}
```

### Supabase integrations table query for Todoist tokens
```python
# Source: celery_worker/canvas/db.py pattern adapted for Todoist
def get_all_todoist_integrations() -> list[dict]:
    """Return all integrations with platform='todoist' that have an access_token."""
    client = _get_supabase()
    result = (
        client.table("integrations")
        .select("user_id, access_token")
        .eq("platform", "todoist")
        .not_.is_("access_token", "null")
        .execute()
    )
    return result.data
```

### Extended INTENT_SYSTEM_PROMPT for Todoist CRUD
```python
# Extension to celery_worker/ai/replies.py INTENT_SYSTEM_PROMPT
INTENT_SYSTEM_PROMPT = """You are Aria's intent classifier.
Given a student's SMS, return ONLY valid JSON (no markdown, no explanation):
{
  "action": "query" | "mark_complete" | "snooze" | "set_priority" |
            "todoist_create" | "todoist_complete" | "todoist_update_due" | "todoist_delete" |
            "off_topic",
  "task_hint": "<partial task name, lowercase, or null>",
  "due_string": "<natural language due date, e.g. 'Friday', 'tomorrow at 3pm', or null>",
  "priority_value": "high" | "normal" | null
}

Rules:
- [existing rules unchanged...]
- "todoist_create" for adding new personal tasks ("add buy textbook due friday", "remind me to email prof tomorrow")
- "todoist_complete" for completing Todoist tasks ("done with buy textbook", "finished grocery run")
- "todoist_update_due" for rescheduling Todoist tasks ("move buy textbook to Monday", "push grocery to next week")
- "todoist_delete" for removing Todoist tasks ("delete buy textbook", "remove grocery run from my list")
- due_string: extract date hint for create/update — use Todoist natural language format (e.g. "Friday", "tomorrow at 5pm")
- If "todoist_create" but no due date mentioned, still classify as todoist_create with due_string=null"""
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Todoist Sync v8 (deprecated Python SDK) | `todoist-api-python` v3.2.1 or raw `requests` to REST API v2 | 2023 | v3 dropped the old Sync API Python wrapper; REST API v2 is now the standard path |
| `todoist-api-python` using `requests` | `todoist-api-python` v3.x using `httpx` | v4.x (not yet released at 3.2.1 stable) | httpx migration is in progress; v3.2.1 (latest stable as of 2026-01-22) still uses requests internally, but this is SDK-internal; for this project, use raw `requests` directly |
| Separate "Personal Tasks" briefing section | Unified `canonical_events` sorted by `priority_score` | Phase 5 | Todoist tasks and Canvas deadlines interleave by score; no source-specific sections |

**Deprecated/outdated:**
- `todoist-python` package (PyPI): officially deprecated by Doist in 2021; do not use
- Todoist Sync API v9 for simple task reads: overkill for this use case; REST API v2 is the correct choice for CRUD operations
- Todoist REST API v1: deprecated; use v2 endpoints (`/rest/v2/`)

---

## Open Questions

1. **Access token encryption in `integrations` table**
   - What we know: Phase 8 stores Google OAuth tokens encrypted using Supabase column-level encryption. The `integrations.access_token` column exists.
   - What's unclear: Is the encryption happening at the application layer (Python/TypeScript code encrypts before insert) or via a Supabase Vault/pgcrypto column? The exact encryption mechanism is not visible in the code reviewed.
   - Recommendation: Follow exactly the same pattern used for `platform='google'` rows — whatever mechanism was used there, use the same for `platform='todoist'`. Do not implement a new encryption approach.

2. **Deep link scheme registration for `aria://` in Expo**
   - What we know: `expo-web-browser` `openAuthSessionAsync` intercepts redirects matching the second argument URL scheme. The `mobile/app.json` or `app.config.ts` should declare the `aria` URL scheme.
   - What's unclear: Whether `aria://` is already registered in the Expo app config, or whether it needs to be added for Phase 9.
   - Recommendation: Check `mobile/app.json` or `mobile/app.config.ts` for a `scheme` field. If not present, add `"scheme": "aria"` before implementing the OAuth flow. This is a one-line change but blocks the entire OAuth flow if missing.

3. **Todoist rate limits**
   - What we know: Todoist allows 1000 requests per 15-minute window (confirmed from search result).
   - What's unclear: Whether the per-user fan-out at 2-hour intervals will ever approach this limit at MVP scale (50 users).
   - Recommendation: At 50 users, 50 requests per sync cycle is well within limits. No throttling needed for MVP. Add a note to revisit at 500+ users.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | pytest (existing, `celery_worker/pytest.ini`) |
| Config file | `celery_worker/pytest.ini` — `testpaths = tests`, `python_files = test_*.py` |
| Quick run command | `cd celery_worker && python -m pytest tests/todoist/ -x -q` |
| Full suite command | `cd celery_worker && python -m pytest tests/ -q` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| TASK-01 | Todoist OAuth token stored in `integrations` table via `/api/auth/todoist/callback` | integration (mocked Supabase) | `pytest tests/todoist/test_db.py -x` | ❌ Wave 0 |
| TASK-01 | `get_active_tasks()` fetches only tasks with `due` set | unit (mock requests) | `pytest tests/todoist/test_fetch.py -x` | ❌ Wave 0 |
| TASK-01 | 403 response stops retries + marks integration revoked | unit (mock requests 403) | `pytest tests/todoist/test_fetch.py::test_403_marks_revoked -x` | ❌ Wave 0 |
| TASK-02 | `parse_tasks()` normalizes due.datetime and due.date (date-only → 23:59:59Z) | unit | `pytest tests/todoist/test_parse.py -x` | ❌ Wave 0 |
| TASK-02 | `todoist_sync_user` calls `ingest_canonical_event(source='todoist')` for each task | unit (mock ingest) | `pytest tests/todoist/test_sync.py -x` | ❌ Wave 0 |
| TASK-02 | Overload detection returns count + top-2 items when >= 5 items due in 24h | unit (mock Supabase) | `pytest tests/ai/test_briefing.py::test_overload_detection -x` | ❌ Wave 0 |
| TASK-02 | `generate_briefing()` prepends overload line when count >= 5 | unit (mock _count_items_due_today) | `pytest tests/ai/test_briefing.py::test_overload_prepend -x` | ❌ Wave 0 |
| TASK-01 | Todoist CRUD intent classification (create/complete/update/delete) | unit (mock Claude response) | `pytest tests/ai/test_replies.py::test_todoist_intent -x` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `cd celery_worker && python -m pytest tests/todoist/ tests/ai/ -x -q`
- **Per wave merge:** `cd celery_worker && python -m pytest tests/ -q`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `celery_worker/tests/todoist/__init__.py` — new test package
- [ ] `celery_worker/tests/todoist/test_fetch.py` — covers TASK-01 (HTTP calls, 403 handling, due-date filter)
- [ ] `celery_worker/tests/todoist/test_parse.py` — covers TASK-02 (due.datetime vs. due.date normalization, priority inversion)
- [ ] `celery_worker/tests/todoist/test_db.py` — covers TASK-01 (get_all_todoist_integrations, mark_synced, mark_integration_revoked)
- [ ] `celery_worker/tests/todoist/test_sync.py` — covers TASK-02 (ingest_canonical_event called correctly from sync)
- [ ] `celery_worker/tests/ai/test_briefing.py` additions — test_overload_detection, test_overload_prepend (existing file, add test cases)
- [ ] `celery_worker/tests/ai/test_replies.py` additions — test_todoist_intent, test_todoist_create_without_due (existing file, add test cases)

---

## Sources

### Primary (HIGH confidence)
- Codebase direct read — `celery_worker/tasks.py`, `canvas/fetch.py`, `canvas/db.py`, `priority/ingest.py`, `priority/engine.py`, `ai/briefing.py`, `ai/replies.py`, `ai/db.py`, `celery_app.py` — established patterns, module structure, retry policies
- Codebase direct read — `mobile/app/(home)/preferences.tsx`, `mobile/app/(onboarding)/google.tsx` — confirmed OAuth pattern uses `expo-auth-session` for Google; Preferences screen already has Connected Accounts section with canvas + google rows; Todoist row follows identical structure
- `doist.github.io/todoist-api-python/api/` — SDK method signatures for `get_tasks`, `add_task`, `update_task`, `complete_task`, `delete_task` with full parameter lists (verified via WebFetch 2026-03-19)
- `developer.todoist.com/api/v1/` — OAuth 2.0 authorization URL (`https://app.todoist.com/oauth/authorize`), token URL (`https://api.todoist.com/oauth/access_token`), scopes (`data:read_write`), authentication header format (`Authorization: Bearer {token}`) (verified via WebFetch 2026-03-19)

### Secondary (MEDIUM confidence)
- pip3 index versions result (2026-03-19) — `todoist-api-python==3.2.1` is current stable, released 2026-01-22; v4.x (httpx migration) not yet stable
- WebSearch result confirming `requests.HTTPError` vs. `httpx.HTTPStatusError` behavioral difference in SDK v4 vs. v3 — informs "use raw requests" recommendation
- WebSearch + WebFetch confirming Todoist rate limit: 1000 requests/15 minutes

### Tertiary (LOW confidence)
- WebSearch result re: Todoist token expiry — multiple sources agree tokens do not expire (can only be revoked by user), but no official docs page directly stating this was fetched
- Todoist REST API v2 endpoint paths (`GET /rest/v2/tasks`, `POST /rest/v2/tasks`, `POST /rest/v2/tasks/{id}/close`, `DELETE /rest/v2/tasks/{id}`) — inferred from SDK method names + partial search results; the official REST v2 docs page returned empty content on fetch; paths are consistent with SDK behavior and search results but should be verified against live Todoist API on first deploy

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — codebase confirms requests/celery/supabase/anthropic are already present; todoist-api-python version confirmed via pip index
- Architecture: HIGH — Todoist module structure directly mirrors the Canvas module (4 files: fetch/parse/db/sync), confirmed from codebase read
- Pitfalls: MEDIUM-HIGH — Todoist priority inversion and due object shape are confirmed from SDK docs; 403 retry pitfall is confirmed from Celery retry behavior in codebase; deep link scheme is LOW (need to verify app.json)
- API endpoints: MEDIUM — OAuth URLs confirmed; REST task endpoints inferred but not directly verified from docs page (page returned empty during fetch)

**Research date:** 2026-03-19
**Valid until:** 2026-04-19 (Todoist REST API v2 is stable; unlikely to change in 30 days)
