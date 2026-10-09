# Phase 2: Canvas iCal Sync - Research

**Researched:** 2026-03-18
**Domain:** Python iCal parsing, Celery periodic tasks, Supabase upsert, diff engine
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **Python only** — all iCal fetching, VEVENT parsing, diffing, and Supabase writes happen inside the Celery task in `celery_worker/`. No TypeScript iCal parsing — one implementation, one language.
- **Next.js API route** at `src/app/api/sync/canvas/route.ts` is a thin trigger only (manual trigger / health check). It does NOT parse iCal or write to DB.
- **Diff sensitivity** — only `due_date` changes count as a "changed" deadline. Title-only changes do not trigger a diff event.
- **Diff engine** compares `canvas_uid` (stable iCal UID) to detect: added, due_date-changed, and removed deadlines.
- **Soft-delete** on removal — add `deleted_at TIMESTAMPTZ` column (or `is_deleted BOOLEAN`) to `deadlines` table. Never hard-delete.
- **UTC storage** — always store `due_date` as UTC `TIMESTAMPTZ`. Parse `DTSTART` + `TZID` and convert to UTC on ingest. User-local conversion happens at read time (Phase 4/5).
- **Canvas URL bootstrapping** for Phase 2 testing — manually insert iCal URL into `integrations` table via Supabase table editor (`platform = 'canvas'`, `ical_url = <url>`, `user_id = <uuid>`). No onboarding UI until Phase 7.

### Claude's Discretion

- Python iCal parsing library choice (`icalendar`, `ics.py`, or similar)
- Celery task retry count and backoff multiplier for rate limit errors (CANV-05 requires exponential backoff — implementation details are Claude's call)
- Whether to use Celery Beat for the 60-min schedule or a periodic task decorator
- Exact structure of the soft-delete migration (column name, index)

### Deferred Ideas (OUT OF SCOPE)

- None — discussion stayed within phase scope
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| CANV-01 | System fetches user's Canvas iCal feed and parses VEVENT records into Task type | `icalendar` 6.3.2 + `requests` for fetch; decoded `DTSTART`, `SUMMARY`, `UID` → Task fields |
| CANV-02 | Parsed Canvas deadlines stored in Supabase `deadlines` table with `synced_at` | `supabase-py` upsert with `on_conflict="canvas_uid,user_id"` covers insert + update; write `synced_at` to `integrations` on completion |
| CANV-03 | Canvas iCal feed synced every 60 minutes via background job | Celery Beat `beat_schedule` with `schedule=3600.0` per-user; separate `celery_beat` service in docker-compose |
| CANV-04 | Diff engine detects added, changed, and removed deadlines between syncs | Load current DB state keyed by `canvas_uid`; compare against parsed feed; soft-delete removed entries |
| CANV-05 | Canvas API rate limits handled with exponential backoff (max 120 req/min) | Celery `autoretry_for=(requests.HTTPError,)` + `retry_backoff=True` + `retry_backoff_max=300` + `max_retries=5`; check HTTP 429 status |
</phase_requirements>

---

## Summary

Phase 2 is a Python-only background job that reads Canvas iCal feeds from the `integrations` table, parses all VEVENT records, diffs against the current `deadlines` DB state, and writes changes back via Supabase. All work lives in `celery_worker/`.

The recommended Python iCal library is `icalendar` 6.3.2 (stable, RFC 5545 compliant, active maintenance, `zoneinfo`-based timezone handling). Version 7.x (released 2026-03-03) is available but requires Python 3.10+ — the project already uses Python 3.12 so it qualifies, but 6.3.2 is the most recent stable non-pre-release branch with full docs. The key parsing challenge is handling Canvas's two DTSTART formats: timezone-aware `DATETIME` (e.g., `DTSTART;TZID=America/New_York:20260401T235900`) and all-day `DATE` (e.g., `DTSTART;VALUE=DATE:20260401`). All-day events must be handled as `datetime.date` objects and normalized to end-of-day UTC before storing.

The 60-minute periodic schedule runs via Celery Beat. The current `docker-compose.yml` has only a `celery_worker` service — Phase 2 must add a `celery_beat` service alongside it. The beat schedule dispatches one `canvas_sync_user` task per user found in the `integrations` table with `platform = 'canvas'`. Celery's built-in `autoretry_for` + `retry_backoff=True` is the right tool for CANV-05 rate-limit handling — no custom retry loop needed.

**Primary recommendation:** Use `icalendar==6.3.2`, Celery Beat with `beat_schedule`, `autoretry_for=(requests.HTTPError,)` with `retry_backoff=True`, and `supabase-py` upsert with `on_conflict="canvas_uid,user_id"`.

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| icalendar | 6.3.2 | Parse `.ics` feeds, extract VEVENT records | RFC 5545 compliant, active maintenance, `zoneinfo` timezone support since v6, widely used |
| requests | 2.32.x | HTTP GET for iCal feed URL | Already standard Python HTTP; needed for iCal URL fetch with timeout + status check |
| supabase-py | >=2.0.0 (already pinned) | Write deadlines table, read integrations | Already in requirements.txt |
| celery | 5.6.2 (already pinned) | Task queue + Beat scheduler | Already in requirements.txt; Beat is bundled |
| python-dotenv | >=1.0.0 (already pinned) | Load env vars | Already in requirements.txt |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| zoneinfo | stdlib (Python 3.9+) | Convert TZID-aware datetimes to UTC | Used internally by `icalendar` 6.x; import for explicit conversions |
| datetime | stdlib | UTC normalization of all-day DATE values | Needed for `.date()` to end-of-day UTC conversion |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| icalendar 6.3.2 | ics.py 0.8.x | ics.py is higher-level but less RFC-complete; TZID handling is weaker; icalendar is better for Canvas feeds which use TZID |
| icalendar 6.3.2 | icalendar 7.0.3 | 7.x is latest but released 2026-03-03 (very new); 6.3.2 is the current stable branch with proven production track record |
| requests | httpx | httpx supports async; unnecessary complexity for a sync Celery task |
| Celery Beat | APScheduler | APScheduler requires its own process management; Beat is already bundled with Celery |

**Installation (add to `celery_worker/requirements.txt`):**
```bash
icalendar==6.3.2
requests>=2.32.0
```

**Version verification (confirmed against PyPI 2026-03-18):**
- `icalendar`: latest stable = 6.3.2 (2025-11-05), 7.0.3 (2026-03-03) — recommend 6.3.2 (stable track)
- `requests`: latest = 2.32.3

---

## Architecture Patterns

### Recommended Project Structure

```
celery_worker/
├── celery_app.py           # Celery app config — add beat_schedule here
├── tasks.py                # ping() task (existing) — add canvas_sync_all here
├── canvas/
│   ├── __init__.py
│   ├── fetch.py            # HTTP fetch of iCal URL → raw bytes
│   ├── parse.py            # icalendar parsing → list of dicts
│   ├── diff.py             # diff against DB state → added/changed/deleted sets
│   └── db.py               # supabase-py reads/writes for deadlines + integrations
└── requirements.txt        # add icalendar==6.3.2, requests>=2.32.0

supabase/migrations/
└── 002_deadlines_soft_delete.sql  # add deleted_at TIMESTAMPTZ + index

src/app/api/sync/canvas/
└── route.ts                # thin trigger only — POST → enqueue canvas_sync_all
```

### Pattern 1: Celery Beat Schedule (per-user fan-out)

**What:** A single beat task `canvas_sync_all` runs every 60 minutes. It queries all users with `platform='canvas'` integrations and dispatches one `canvas_sync_user` task per user.

**When to use:** When you need per-user isolation (one user's rate-limit error doesn't block another) while keeping scheduling simple (one beat entry, not N dynamic entries).

**Example:**
```python
# celery_app.py — add to conf.update block
# Source: https://docs.celeryq.dev/en/stable/userguide/periodic-tasks.html

celery_app.conf.beat_schedule = {
    "canvas-sync-all-60min": {
        "task": "tasks.canvas_sync_all",
        "schedule": 3600.0,  # 60 minutes in seconds
    },
}
```

```python
# tasks.py — orchestrator task (not retried; just fans out)
@celery_app.task(name="tasks.canvas_sync_all")
def canvas_sync_all():
    """Query all canvas integrations and dispatch one sync task per user."""
    from canvas.db import get_all_canvas_integrations
    integrations = get_all_canvas_integrations()
    for row in integrations:
        canvas_sync_user.delay(row["user_id"], row["ical_url"])
    return {"dispatched": len(integrations)}
```

### Pattern 2: Per-User Sync Task with Exponential Backoff

**What:** `canvas_sync_user` fetches one iCal URL, parses it, diffs, and writes. Uses Celery's built-in `autoretry_for` + `retry_backoff` for rate-limit errors.

**When to use:** For any external HTTP call that can return 429 or transient errors.

**Example:**
```python
# tasks.py
# Source: https://docs.celeryq.dev/en/stable/userguide/tasks.html (autoretry_for)

@celery_app.task(
    name="tasks.canvas_sync_user",
    bind=True,
    autoretry_for=(requests.HTTPError,),
    retry_backoff=2,          # delay doubles each retry: 2s, 4s, 8s, 16s, 32s
    retry_backoff_max=300,    # cap at 5 minutes between retries
    retry_jitter=True,        # add randomness to prevent thundering herd
    max_retries=5,
)
def canvas_sync_user(self, user_id: str, ical_url: str) -> dict:
    """Fetch, parse, diff, and persist one user's Canvas deadlines."""
    from canvas.fetch import fetch_ical
    from canvas.parse import parse_vevents
    from canvas.diff import compute_diff
    from canvas.db import load_current_deadlines, apply_diff, mark_synced

    raw = fetch_ical(ical_url)          # raises HTTPError on 429
    events = parse_vevents(raw)
    current = load_current_deadlines(user_id)
    diff = compute_diff(current, events)
    apply_diff(user_id, diff)
    mark_synced(user_id)
    return {"user_id": user_id, "added": len(diff["added"]), ...}
```

### Pattern 3: iCal Parsing with UTC Normalization

**What:** Parse Canvas VEVENT records, handle both DATETIME+TZID and all-day DATE formats, convert to UTC.

**When to use:** Any time you process Canvas iCal DTSTART values.

**Example:**
```python
# canvas/parse.py
# Source: https://icalendar.readthedocs.io/en/stable/how-to/usage.html

from icalendar import Calendar
from datetime import datetime, timezone, time
from zoneinfo import ZoneInfo
import datetime as dt

def parse_vevents(raw_bytes: bytes) -> list[dict]:
    cal = Calendar.from_ical(raw_bytes)
    events = []
    for component in cal.walk():
        if component.name != "VEVENT":
            continue
        uid = str(component.get("UID", ""))
        summary = str(component.get("SUMMARY", ""))
        dtstart_prop = component.get("DTSTART")
        if dtstart_prop is None:
            continue
        dtstart_value = dtstart_prop.dt

        # Handle all-day DATE vs DATETIME
        if isinstance(dtstart_value, dt.date) and not isinstance(dtstart_value, dt.datetime):
            # All-day event: treat as end-of-day UTC (23:59:59)
            due_utc = datetime.combine(dtstart_value, time(23, 59, 59), tzinfo=timezone.utc)
        else:
            # Timezone-aware datetime — convert to UTC
            due_utc = dtstart_value.astimezone(timezone.utc)

        events.append({
            "canvas_uid": uid,
            "title": summary,
            "due_date": due_utc.isoformat(),
            "course": _extract_course(summary),
            "type": _infer_type(summary),
        })
    return events
```

### Pattern 4: Diff Engine (canvas_uid keyed comparison)

**What:** Compare fresh parsed events against DB state, keyed by `canvas_uid`. Detect added, due_date-changed, and removed.

**When to use:** Every sync cycle; diffing happens in-memory after loading both sets.

**Example:**
```python
# canvas/diff.py
def compute_diff(current: dict, fresh: list[dict]) -> dict:
    """
    current: {canvas_uid: {"due_date": ..., ...}} loaded from DB
    fresh:   list of parsed event dicts
    Returns: {"added": [...], "changed": [...], "removed": [canvas_uid, ...]}
    """
    fresh_by_uid = {e["canvas_uid"]: e for e in fresh}

    added = [e for uid, e in fresh_by_uid.items() if uid not in current]
    changed = [
        e for uid, e in fresh_by_uid.items()
        if uid in current and e["due_date"] != current[uid]["due_date"]
        # Title-only changes are intentionally ignored per CONTEXT.md
    ]
    removed_uids = [uid for uid in current if uid not in fresh_by_uid]

    return {"added": added, "changed": changed, "removed": removed_uids}
```

### Pattern 5: Supabase Upsert with Soft-Delete

**What:** Write added/changed deadlines via upsert; soft-delete removed deadlines by setting `deleted_at`.

**When to use:** Every `apply_diff` call.

**Example:**
```python
# canvas/db.py
# Source: https://supabase.com/docs/reference/python/upsert

def apply_diff(user_id: str, diff: dict, supabase_client) -> None:
    now = datetime.now(timezone.utc).isoformat()
    # Upsert added + changed
    for event in diff["added"] + diff["changed"]:
        supabase_client.table("deadlines").upsert(
            {
                "user_id": user_id,
                "canvas_uid": event["canvas_uid"],
                "title": event["title"],
                "due_date": event["due_date"],
                "course": event.get("course"),
                "type": event.get("type"),
                "last_synced": now,
                "deleted_at": None,  # clear any prior soft-delete
            },
            on_conflict="canvas_uid,user_id",
        ).execute()

    # Soft-delete removed deadlines
    for uid in diff["removed"]:
        supabase_client.table("deadlines").update(
            {"deleted_at": now}
        ).eq("user_id", user_id).eq("canvas_uid", uid).execute()
```

### Pattern 6: Celery Beat Docker Compose Service

**What:** Beat scheduler runs as a separate container — it must NOT run in the same process as the worker.

**When to use:** Adding a beat schedule to an existing worker-only docker-compose setup.

**Example:**
```yaml
# docker-compose.yml — add celery_beat service alongside celery_worker
celery_beat:
  build:
    context: ./celery_worker
    dockerfile: Dockerfile
  command: celery -A celery_app beat --loglevel=info
  environment:
    - REDIS_URL=redis://redis:6379/0
    - SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL}
    - SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY}
  depends_on:
    redis:
      condition: service_healthy
  volumes:
    - ./celery_worker:/app
```

### Anti-Patterns to Avoid

- **Running beat and worker in the same process:** `celery -A celery_app worker --beat` is only for dev/single-container — in production (Railway) always separate them. Mixing them causes scheduling drift.
- **Hard-deleting removed deadlines:** Phase 5 alerts and briefings need to know what was removed. Always soft-delete.
- **Storing DTSTART as a string before converting to UTC:** Parse and convert to UTC in the same step. Never store a local datetime string.
- **Assuming DTSTART is always timezone-aware:** Canvas all-day events emit `VALUE=DATE` (no time, no timezone). Must `isinstance` check before calling `.astimezone()`.
- **Triggering one beat entry per user:** Beat schedule is static; fan out to per-user tasks dynamically inside the orchestrator task.
- **Writing `synced_at` before the diff is complete:** Write `synced_at` on the `integrations` row only after `apply_diff` succeeds, not before.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| iCal parsing | Custom string/regex parser | `icalendar` library | RFC 5545 has edge cases: line folding, CRLF, VTIMEZONE blocks, RRULE, escaped characters. Hand-rolled parsers break on real Canvas feeds. |
| Exponential backoff | Custom retry loop with `time.sleep` | Celery `autoretry_for` + `retry_backoff=True` | Celery handles delay scheduling, jitter, max cap, and task state. Custom loops block the worker thread. |
| UTC conversion | Manual timezone string parsing | `icalendar.decoded("dtstart")` + `.astimezone(UTC)` | TZID parsing is handled by `zoneinfo`/`icalendar` — aliases like "Eastern Time" vs "America/New_York" are handled correctly. |
| Upsert logic | SELECT then INSERT/UPDATE in two calls | `supabase-py` `.upsert(on_conflict=...)` | Race condition between SELECT and INSERT; upsert is atomic. |

**Key insight:** iCal seems simple (it's just text) but RFC 5545 line folding, CRLF newlines, VTIMEZONE component nesting, and VALUE=DATE vs VALUE=DATE-TIME distinctions make a custom parser fragile within hours of touching real Canvas data.

---

## Common Pitfalls

### Pitfall 1: Canvas All-Day Events Have DATE, Not DATETIME

**What goes wrong:** Calling `.astimezone(timezone.utc)` on a `datetime.date` object raises `AttributeError: 'date' object has no attribute 'astimezone'`. Canvas emits assignment due dates as `DTSTART;VALUE=DATE:20260401` for assignments without a specific time.

**Why it happens:** The iCal spec allows DTSTART to be either DATE (date only) or DATE-TIME (date + time + optional timezone). Canvas uses DATE for some assignment types.

**How to avoid:** Always check `isinstance(dtstart.dt, datetime.datetime)` before calling `.astimezone()`. If `datetime.date`, convert to end-of-day UTC explicitly.

**Warning signs:** `AttributeError` in parse step on first real Canvas feed test.

### Pitfall 2: canvas_uid Uniqueness — Canvas Embeds the iCal URL Token in UIDs

**What goes wrong:** Canvas iCal UIDs contain the user's secret token (e.g., `event-assignment_123456@instructure.com`). The UID format is stable between syncs for the same user, but UIDs are NOT globally unique across users. The `deadlines` table `canvas_uid` column is NOT globally unique — it must always be scoped with `user_id`.

**Why it happens:** Canvas UIDs are unique per user feed, not globally unique.

**How to avoid:** All DB queries on `canvas_uid` must always include `.eq("user_id", user_id)`. The upsert `on_conflict` must be `"canvas_uid,user_id"` (composite), not just `"canvas_uid"`. The migration for the unique constraint must be on `(user_id, canvas_uid)`.

**Warning signs:** Incorrect data appearing for wrong users after first multi-user test.

### Pitfall 3: Celery Beat Writes a `celerybeat-schedule` File

**What goes wrong:** By default, Celery Beat persists its schedule to a local file `celerybeat-schedule` in the working directory. In Docker with a volume mount (`./celery_worker:/app`), this file gets written into your source tree and committed accidentally.

**Why it happens:** Default Beat scheduler uses a file-based persistence backend.

**How to avoid:** Add `celerybeat-schedule` to `.gitignore`. Optionally pass `--schedule=/tmp/celerybeat-schedule` in the Beat command.

**Warning signs:** A binary file `celerybeat-schedule` appearing in `git status`.

### Pitfall 4: Rate-Limit 429 from Canvas iCal Endpoint

**What goes wrong:** Canvas rate limits all authenticated requests at 120 req/min. With many users syncing simultaneously, the fan-out can exceed this. The iCal endpoint returns HTTP 429.

**Why it happens:** Canvas iCal URLs include a secret token but still count against the institutional rate limit per-IP (not per-user OAuth token). Multiple simultaneous syncs from one server IP may share quota.

**How to avoid:** `autoretry_for=(requests.HTTPError,)` with `retry_backoff=True` handles the retry. In the fetch layer, inspect `response.status_code == 429` and raise `requests.HTTPError` explicitly (since iCal is a GET that doesn't raise on 4xx by default — must call `response.raise_for_status()`).

**Warning signs:** Silent empty sync results (if not calling `raise_for_status()`).

### Pitfall 5: `integrations.synced_at` Not Updated on Error

**What goes wrong:** If `canvas_sync_user` fails mid-way (after partial DB writes), `synced_at` is still stale. The next sync has no way to know which records were written.

**Why it happens:** Not treating the sync as a unit.

**How to avoid:** Only write `synced_at` to the `integrations` table after `apply_diff` completes successfully. Wrap in try/finally — on failure, let Celery retry; do not update `synced_at`.

### Pitfall 6: Supabase Service Role Key Required from Celery Worker

**What goes wrong:** `supabase-py` initialized with the anon key fails all writes because RLS policies require `auth.uid()` which is not set in a server-side context.

**Why it happens:** RLS policies on `deadlines` and `integrations` are written for authenticated users. The Celery worker is not an authenticated user session.

**How to avoid:** Initialize `supabase-py` in the Celery worker with `SUPABASE_SERVICE_ROLE_KEY`, which bypasses RLS. This key is already injected via docker-compose `environment`. The pattern is already established from Phase 1.

---

## Code Examples

### Fetch iCal URL (with raise_for_status)

```python
# canvas/fetch.py
import requests

def fetch_ical(ical_url: str, timeout: int = 30) -> bytes:
    """Fetch raw iCal bytes from Canvas iCal URL.

    Args:
        ical_url: Canvas calendar feed URL with embedded secret token
        timeout: Request timeout in seconds
    Returns:
        Raw iCal bytes
    Raises:
        requests.HTTPError: On 4xx/5xx responses (including 429 rate limit)
    """
    response = requests.get(ical_url, timeout=timeout)
    response.raise_for_status()  # CRITICAL: raises HTTPError for 429, 5xx
    return response.content
```

### Celery Beat Configuration (celery_app.py addition)

```python
# celery_app.py — add to celery_app.conf.update() block
# Source: https://docs.celeryq.dev/en/stable/userguide/periodic-tasks.html

celery_app.conf.beat_schedule = {
    "canvas-sync-all-users": {
        "task": "tasks.canvas_sync_all",
        "schedule": 3600.0,  # every 60 minutes
    },
}
```

### Soft-Delete Migration

```sql
-- supabase/migrations/002_deadlines_soft_delete.sql
-- Add soft-delete support to deadlines table.
-- Phase 5 uses deleted_at to alert users when a deadline disappears from Canvas.

ALTER TABLE public.deadlines
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Index for efficient filtering of active (non-deleted) deadlines
CREATE INDEX IF NOT EXISTS idx_deadlines_active
  ON public.deadlines (user_id, deleted_at)
  WHERE deleted_at IS NULL;

-- Unique constraint required for upsert on_conflict="canvas_uid,user_id"
ALTER TABLE public.deadlines
  ADD CONSTRAINT deadlines_canvas_uid_user_id_key
  UNIQUE (canvas_uid, user_id);
```

### Register New Task Module in celery_app.py

```python
# celery_app.py — update include list
celery_app = Celery(
    "aria",
    broker=REDIS_URL,
    backend=REDIS_URL,
    include=["tasks"],  # tasks.py is auto-discovered; canvas/ sub-module is imported from tasks.py
)
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `pytz` for timezone | `zoneinfo` (stdlib) | icalendar v6.0.0 (2024) | No extra dependency; zoneinfo is Python 3.9+ stdlib |
| `icalendar` 4.x (pytz-based) | `icalendar` 6.3.2 (zoneinfo-based) | 2024 | API compatible; timezone objects differ |
| `@periodic_task` decorator | `beat_schedule` config + `add_periodic_task()` | Celery 4+ | `@periodic_task` is removed in Celery 5 |
| Manual retry loops | `autoretry_for` + `retry_backoff` | Celery 4.2+ | Built-in; no custom sleep/retry code needed |

**Deprecated/outdated:**
- `@periodic_task` decorator: removed in Celery 5 — do not use
- `pytz` for timezone: replaced by `zoneinfo` in icalendar 6.x — do not add `pytz` as a dependency

---

## Open Questions

1. **Canvas iCal UID stability across course re-enrollments**
   - What we know: UIDs are in the format `event-assignment_{ID}@instructure.com` and are stable for the same assignment across syncs for a given user
   - What's unclear: Whether UIDs change if a student drops/re-adds a course, or if the institution re-issues the feed URL
   - Recommendation: Treat as stable within a feed; if UID changes, existing record is soft-deleted and a new one is inserted — acceptable behavior

2. **Canvas iCal feed size for heavy course loads**
   - What we know: Canvas includes all events (not just future ones) in the default feed; some student feeds can be 500+ events
   - What's unclear: Whether there is a pagination mechanism or a `startdate`/`enddate` query param on the iCal URL
   - Recommendation: Parse all VEVENT records on first sync; apply a date filter in the Task normalization step (e.g., only store deadlines within `now - 14 days` to `now + 180 days`) to keep DB size reasonable

3. **`on_conflict` constraint syntax in supabase-py**
   - What we know: `on_conflict` takes a string of comma-separated column names per official docs
   - What's unclear: Whether the `deadlines` table needs the UNIQUE constraint added before the upsert call (it does — migration 002 handles this)
   - Recommendation: Migration 002 must run before any canvas_sync task executes

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | pytest (not yet installed — Wave 0 gap) |
| Config file | `celery_worker/pytest.ini` — Wave 0 |
| Quick run command | `cd celery_worker && python -m pytest tests/ -x -q` |
| Full suite command | `cd celery_worker && python -m pytest tests/ -v` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CANV-01 | Parse VEVENT records into Task-compatible dicts | unit | `python -m pytest tests/canvas/test_parse.py -x` | ❌ Wave 0 |
| CANV-01 | All-day DATE events normalize to end-of-day UTC | unit | `python -m pytest tests/canvas/test_parse.py::test_allday_date_to_utc -x` | ❌ Wave 0 |
| CANV-01 | DATETIME+TZID events convert correctly to UTC | unit | `python -m pytest tests/canvas/test_parse.py::test_tz_aware_datetime_to_utc -x` | ❌ Wave 0 |
| CANV-02 | Deadlines written to DB with synced_at | integration | `python -m pytest tests/canvas/test_db.py::test_upsert_writes_synced_at -x` | ❌ Wave 0 |
| CANV-03 | beat_schedule entry exists at correct interval | unit | `python -m pytest tests/test_celery_app.py::test_beat_schedule_60min -x` | ❌ Wave 0 |
| CANV-04 | Diff detects added deadlines | unit | `python -m pytest tests/canvas/test_diff.py::test_detect_added -x` | ❌ Wave 0 |
| CANV-04 | Diff detects due_date-changed deadlines | unit | `python -m pytest tests/canvas/test_diff.py::test_detect_changed -x` | ❌ Wave 0 |
| CANV-04 | Diff detects removed deadlines (soft-delete) | unit | `python -m pytest tests/canvas/test_diff.py::test_detect_removed -x` | ❌ Wave 0 |
| CANV-04 | Title-only change does NOT appear in diff | unit | `python -m pytest tests/canvas/test_diff.py::test_title_only_no_diff -x` | ❌ Wave 0 |
| CANV-05 | HTTP 429 triggers retry with backoff | unit | `python -m pytest tests/canvas/test_fetch.py::test_429_raises_http_error -x` | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** `cd celery_worker && python -m pytest tests/canvas/ -x -q`
- **Per wave merge:** `cd celery_worker && python -m pytest tests/ -v`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `celery_worker/tests/__init__.py` — test package init
- [ ] `celery_worker/tests/canvas/__init__.py` — canvas test sub-package init
- [ ] `celery_worker/tests/canvas/test_parse.py` — covers CANV-01 (VEVENT parsing, DATE vs DATETIME, UTC conversion)
- [ ] `celery_worker/tests/canvas/test_diff.py` — covers CANV-04 (added/changed/removed detection, title-only no-op)
- [ ] `celery_worker/tests/canvas/test_fetch.py` — covers CANV-05 (429 raises HTTPError)
- [ ] `celery_worker/tests/canvas/test_db.py` — covers CANV-02 (upsert writes, soft-delete)
- [ ] `celery_worker/tests/test_celery_app.py` — covers CANV-03 (beat_schedule entry)
- [ ] `celery_worker/pytest.ini` — pytest configuration
- [ ] Framework install: `pip install pytest pytest-mock` (inside celery_worker Docker image / requirements-dev.txt)

---

## Sources

### Primary (HIGH confidence)
- `https://pypi.org/project/icalendar/` — confirmed version 6.3.2 (stable) and 7.0.3 (latest), Python 3.10+ requirement for 7.x
- `https://icalendar.readthedocs.io/en/stable/` — RFC 5545 parsing, zoneinfo usage, Calendar.from_ical(), VEVENT iteration, decoded() method
- `https://docs.celeryq.dev/en/stable/userguide/periodic-tasks.html` — beat_schedule, schedule=3600.0, add_periodic_task()
- `https://docs.celeryq.dev/en/stable/userguide/tasks.html` — autoretry_for, retry_backoff, retry_backoff_max, retry_jitter, max_retries
- `https://supabase.com/docs/reference/python/upsert` — upsert() with on_conflict parameter syntax
- `https://developerdocs.instructure.com/services/canvas/basics/file.throttling` — Canvas rate limiting: HTTP 429, X-Rate-Limit-Remaining header, retry advice

### Secondary (MEDIUM confidence)
- `https://icalendar.readthedocs.io/en/stable/how-to/usage.html` — Calendar.from_ical() parsing, event.decoded("dtstart") return type behavior
- `https://testdriven.io/blog/django-celery-periodic-tasks/` — separate celery_beat service in docker-compose pattern

### Tertiary (LOW confidence, flag for validation)
- Canvas iCal UID format (`event-assignment_{ID}@instructure.com`) — inferred from Canvas API controller source; not confirmed from official iCal documentation

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — versions confirmed against PyPI (2026-03-18); all libraries already have established usage in project
- Architecture: HIGH — Celery Beat, supabase-py upsert, and icalendar patterns all verified against official docs
- Pitfalls: HIGH (DATE vs DATETIME, canvas_uid scoping, raise_for_status) / MEDIUM (UID stability across re-enrollments — inferred)
- Test mapping: HIGH — all behaviors directly traceable to CANV-01 through CANV-05

**Research date:** 2026-03-18
**Valid until:** 2026-04-18 (icalendar and Celery are stable; supabase-py API may evolve faster)
