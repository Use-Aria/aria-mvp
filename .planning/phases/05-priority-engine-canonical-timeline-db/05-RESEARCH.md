# Phase 5: Priority Engine + Canonical Timeline DB - Research

**Researched:** 2026-03-19
**Domain:** PostgreSQL schema design, priority scoring engine, Celery task patterns, TCPA delivery routing
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Canonical Store Architecture**
- New `canonical_events` table — not an extension of `deadlines`
- `deadlines` table is kept as Canvas-specific source-of-truth; canvas sync continues writing there
- A backfill job copies existing Canvas deadline rows into `canonical_events` on Phase 5 deploy
- `ai/db.py` briefing queries switch to read from `canonical_events` going forward
- `canonical_events` schema (Phase 5): `id`, `user_id`, `source` (canvas/gcal/gmail/todoist), `type`, `title`, `due_at`, `course_id`, `grade_weight`, `priority_score` (computed on ingestion), `delivery_status` (immediate/digest/silent)
- Phase 6+ adds its own columns via incremental migrations when those integrations land

**Priority Score Formula**
- Locked: `Priority = (grade_weight × 0.35) + (urgency × 0.45) + (source_authority × 0.20)`
- Source authority values (locked): Canvas = 1.0, professor email = 0.9, Todoist = 0.8
- Urgency function: `urgency = min(1.0, e^(-0.15 × days_remaining))` — aggressive decay
  - 14 days out → ~0.12 urgency; 7 days → ~0.35; 3 days → ~0.64; 1 day → ~0.86; 0 days → 1.0
  - Overdue (days_remaining < 0): clamped to urgency = 1.0

**Delivery Router**
- Score ≥ 80: immediate SMS — fires within 60 seconds of ingestion
- Score 50–79: queued for next morning digest (always tomorrow's briefing, no same-night send)
- Score < 50: logged silently in `canonical_events`, visible in app only (Phase 8)

**Immediate Alerts + TCPA**
- Score ≥ 80 alerts bypass quiet hours (10pm–8am) — sent immediately regardless of time
- Score ≥ 80 alerts are exempt from the 3 unsolicited messages/day cap (treated as transactional, same logic as STOP confirmation using `send_sms_direct`)
- A new `send_sms_alert()` function wraps `send_sms_direct` with alert-specific logic (opt-out check still applies — never bypass STOP)
- TCPA note: Bypassing quiet hours requires explicit opt-in consent language in onboarding (Phase 8): "I agree to receive time-sensitive deadline alerts at any hour." Flag this for Seb's onboarding copy.

### Claude's Discretion
- Exact backfill job implementation (Celery task vs. migration script)
- Index strategy for `canonical_events` (covering index for delivery_status queries)
- How `delivery_status` is updated after a digest includes the event

### Deferred Ideas (OUT OF SCOPE)
- None — discussion stayed within phase scope
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| PRIO-01 | Canonical Timeline DB stores all normalized events from all integrations in a unified schema with source, type, title, due_at, course_id, and grade_weight | Migration 005 creates `canonical_events` table; backfill job populates from existing `deadlines` rows |
| PRIO-02 | Priority Engine scores every event: `Priority = (grade_weight × 0.35) + (urgency × 0.45) + (source_authority × 0.20)` where Canvas = 1.0, professor email = 0.9, Todoist = 0.8, Discord = 0.6 | Python `score_event()` function using `math.exp`; called in `ingest_canonical_event()` |
| PRIO-03 | Delivery router: score ≥ 80 triggers immediate SMS; score 50–79 queues for next digest; score < 50 logged silently (visible in app only) | `delivery_router()` checks score, calls `send_sms_alert()` for immediate or sets `delivery_status='digest'` |
</phase_requirements>

---

## Summary

Phase 5 introduces the `canonical_events` table as the unified event store for all future integrations, backfills existing Canvas deadlines into it, computes a deterministic priority score on ingestion, and wires a three-tier delivery router. The entire phase is internal infrastructure: no new external API credentials, no new OAuth flows, no frontend changes.

The technical surface of this phase is narrow and well-bounded by the locked decisions. The main implementation work is: one Supabase migration (005), one Python module for the priority engine (`celery_worker/priority/`), a shared `ingest_canonical_event()` function that Phase 6 will call, a `send_sms_alert()` function that bypasses quiet hours/cap while still checking opt-out, updates to `canvas_sync_user` to write to `canonical_events` after diffing, updates to `ai/db.py` to read from `canonical_events` for briefings, and a one-time backfill Celery task.

The score formula uses only Python's standard `math` module (no external ML libraries). The urgency decay is `e^(-0.15 × days_remaining)` — a pure floating-point calculation. The primary complexity is coordinating the delivery router correctly: immediate SMS fires within 60 seconds (Celery `.delay()` with no countdown), digest events update `delivery_status` to `'digest'`, and the morning briefing task must mark digest events as `'sent'` after including them.

**Primary recommendation:** Implement in a dedicated `celery_worker/priority/` module with three files — `engine.py` (scoring), `router.py` (delivery dispatch), `ingest.py` (shared entry point for all integrations). This keeps the priority logic self-contained and makes Phase 6 integration a single `from priority.ingest import ingest_canonical_event` import.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| supabase-py | Already installed (Phase 1–4) | `canonical_events` CRUD via service role | Same `_get_supabase()` pattern used across all modules |
| math (stdlib) | Python stdlib | `math.exp()` for urgency decay | No external dependency needed for formula |
| celery | Already installed | Async ingest + backfill tasks | All background jobs already use Celery |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| zoneinfo (stdlib) | Python 3.9+ stdlib | Timezone-aware `days_remaining` calculation | Computing urgency from `due_at` vs `datetime.now(tz)` |
| datetime (stdlib) | Python stdlib | Timedelta arithmetic for days_remaining | `(due_at - now).days` for urgency input |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Python `math.exp` | numpy/scipy | Overkill — single scalar computation; adds dependency for no gain |
| Celery task for backfill | SQL migration script | Celery task is safer: respects existing `_get_supabase()` pattern, can be retried, fan-out per user mirrors canvas_sync pattern |

**Installation:**
```bash
# No new dependencies required — all libraries already present in celery_worker/requirements.txt
```

---

## Architecture Patterns

### Recommended Project Structure
```
celery_worker/
├── priority/
│   ├── __init__.py
│   ├── engine.py        # score_event() — pure priority formula
│   ├── router.py        # route_event() — delivery dispatch logic
│   └── ingest.py        # ingest_canonical_event() — shared entry point
├── ai/
│   └── db.py            # get_deadlines_for_briefing() → switches to canonical_events
├── sms/
│   └── send.py          # add send_sms_alert() alongside send_sms_direct()
└── tasks.py             # add backfill_canonical_events task; wire canvas_sync_user
```

### Pattern 1: Separation of Engine, Router, and Ingest

**What:** Priority scoring (`engine.py`), delivery routing (`router.py`), and the canonical write path (`ingest.py`) are three separate concerns. `ingest.py` is the only public surface Phase 6 needs to call.

**When to use:** Always. This mirrors the existing pattern where `canvas/fetch.py`, `canvas/parse.py`, `canvas/diff.py`, and `canvas/db.py` each own exactly one concern.

**Example:**
```python
# celery_worker/priority/engine.py
import math

SOURCE_AUTHORITY = {
    "canvas": 1.0,
    "gmail": 0.9,   # professor email
    "todoist": 0.8,
    "discord": 0.6,
}

def compute_urgency(days_remaining: float) -> float:
    """Exponential urgency decay. Overdue events clamp to 1.0."""
    if days_remaining <= 0:
        return 1.0
    return min(1.0, math.exp(-0.15 * days_remaining))

def score_event(
    grade_weight: float,   # 0.0–1.0 normalized (e.g. 0.25 for 25%)
    days_remaining: float,
    source: str,
) -> float:
    """Compute priority score [0.0, ~1.0 raw → caller multiplies by 100].

    Formula: (grade_weight × 0.35) + (urgency × 0.45) + (source_authority × 0.20)
    """
    urgency = compute_urgency(days_remaining)
    authority = SOURCE_AUTHORITY.get(source, 0.5)
    return (grade_weight * 0.35) + (urgency * 0.45) + (authority * 0.20)
```

**Key detail:** The formula produces values in [0.0, 1.0] range. The delivery thresholds in the requirements (≥80, 50–79, <50) are on a 0–100 scale. The planner must multiply `score_event()` output by 100, OR store `priority_score` as the 0–100 integer directly. Recommendation: store as a 0–100 integer (multiply by 100, round) for cleaner DB queries.

### Pattern 2: ingest_canonical_event() as the Shared Entry Point

**What:** A single function that writes to `canonical_events`, computes and stores `priority_score`, sets `delivery_status`, and triggers the delivery router. Phase 6 GCal and Gmail ingestion tasks call this function — they never write to `canonical_events` directly.

**When to use:** Every time a new event enters the system (canvas sync, gcal sync, gmail flag, backfill).

```python
# celery_worker/priority/ingest.py
from priority.engine import score_event
from priority.router import route_event

def ingest_canonical_event(
    user_id: str,
    source: str,
    event_type: str,
    title: str,
    due_at: str,            # ISO 8601
    course_id: str | None,
    grade_weight: float,    # normalized 0.0–1.0
) -> dict:
    """Write event to canonical_events, score it, and route for delivery.

    Returns the inserted canonical_event dict including priority_score and delivery_status.
    Called by canvas_sync_user (after apply_diff), and by Phase 6 gcal/gmail ingest tasks.
    """
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    due_dt = datetime.fromisoformat(due_at)
    if due_dt.tzinfo is None:
        due_dt = due_dt.replace(tzinfo=timezone.utc)
    days_remaining = (due_dt - now).total_seconds() / 86400

    raw_score = score_event(grade_weight, days_remaining, source)
    priority_score = round(raw_score * 100)

    delivery_status = route_event(priority_score)  # returns 'immediate'/'digest'/'silent'

    client = _get_supabase()
    result = client.table("canonical_events").insert({
        "user_id": user_id,
        "source": source,
        "type": event_type,
        "title": title,
        "due_at": due_at,
        "course_id": course_id,
        "grade_weight": grade_weight,
        "priority_score": priority_score,
        "delivery_status": delivery_status,
    }).execute()

    event = result.data[0]

    if delivery_status == "immediate":
        from tasks import send_priority_alert
        send_priority_alert.delay(user_id, event["id"])

    return event
```

### Pattern 3: send_sms_alert() Follows send_sms_direct() Pattern

**What:** `send_sms_alert()` bypasses quiet hours and daily cap but still checks opt-out. This mirrors how `send_sms_direct()` bypasses all guards for STOP confirmation.

**When to use:** Exclusively for score ≥ 80 delivery. Never for briefings or conversational replies.

```python
# celery_worker/sms/send.py — add alongside send_sms_direct()

def send_sms_alert(user_id: str, to_phone: str, body: str) -> bool:
    """Send time-sensitive alert SMS bypassing quiet hours and daily cap.

    Still checks opt-out — never send to opted-out users regardless of score.
    Reserved for priority_score >= 80 events only.
    Requires explicit onboarding consent before Yale beta (TCPA — Phase 8 Seb task).

    Args:
        user_id: UUID of recipient (used for opt-out check and hashed logging).
        to_phone: Recipient E.164 phone number. Never logged in plaintext.
        body: Alert message body.

    Returns:
        True if sent, False if user is opted out.
    """
    user = _get_user_sms_state(user_id)
    hashed_id = hashlib.sha256(user_id.encode()).hexdigest()[:12]

    # Only guard: hard opt-out. Quiet hours, pause, and daily cap are bypassed.
    if user["sms_opted_out"]:
        _log_suppressed(hashed_id, "opted_out")
        return False

    # Send via Twilio — same call as send_sms_direct
    account_sid = os.environ["TWILIO_ACCOUNT_SID"]
    auth_token = os.environ["TWILIO_AUTH_TOKEN"]
    from_number = os.environ["TWILIO_PHONE_NUMBER"]
    client = Client(account_sid, auth_token)
    message = client.messages.create(from_=from_number, to=to_phone, body=body)
    logger.info(json.dumps({
        "event": "sms_alert_sent",
        "sid": message.sid,
        "uid": hashed_id,
    }))
    return True
```

### Pattern 4: Backfill as One-Shot Celery Task

**What:** A `backfill_canonical_events` Celery task fans out per user (same pattern as `canvas_sync_all` → `canvas_sync_user`). Called once on Phase 5 deploy via a management command or Railway one-off job.

**When to use:** Only on Phase 5 deploy. Idempotent — checks for existing `canonical_events` rows before inserting to avoid duplicates.

**Approach:** Fan out `backfill_canonical_events_user.delay(user_id)` for each user, which reads their `deadlines` rows and calls `ingest_canonical_event()` for each. The idempotency check uses a UNIQUE constraint on `(user_id, source, title, due_at)` with `ON CONFLICT DO NOTHING` in the migration.

### Pattern 5: briefing reads from canonical_events

**What:** `get_deadlines_for_briefing()` in `ai/db.py` switches to query `canonical_events` instead of `deadlines`. The filter logic is the same (active, non-snoozed, within `days_ahead` window), with one addition: filter to `delivery_status IN ('digest', 'immediate')` — silent events never appear in briefings.

**Key concern:** `canonical_events` uses `due_at` (not `due_date`), `course_id` (not `course`), and has no `snoozed_until` or `deleted_at` columns. The migration must add these columns OR the briefing query adjusts. **Recommendation:** Add `snoozed_until TIMESTAMPTZ` and `deleted_at TIMESTAMPTZ` to `canonical_events` in migration 005 — this preserves the existing briefing query logic and enables Phase 4 snooze commands to work on canonical events.

### Anti-Patterns to Avoid

- **Writing directly to `canonical_events` outside of `ingest_canonical_event()`:** Phase 6 tasks must import and call `ingest_canonical_event()` — never insert rows manually. This ensures scoring always runs.
- **Storing priority_score as a float:** Store as `INTEGER` (0–100). Avoids float comparison edge cases in delivery routing SQL queries.
- **Recomputing urgency at briefing time:** Urgency is computed at ingest. Do not recalculate at query time — `priority_score` is the stored, immutable score from when the event was ingested.
- **Sending alert SMS inline in ingest_canonical_event():** Always dispatch via `send_priority_alert.delay()` — never call Twilio synchronously in the ingest path. This ensures the 60-second window is a Celery worker concern, not a blocking DB write concern.
- **Using `send_sms_safe()` for alerts:** `send_sms_safe()` will suppress the alert during quiet hours. Use `send_sms_alert()` which bypasses quiet hours/cap but retains opt-out check.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Exponential urgency decay | Custom approximation | `math.exp()` from Python stdlib | One-liner, numerically correct, already available |
| Per-user task fan-out | Custom loop with error trapping | Celery `.delay()` pattern from existing `canvas_sync_all` → `canvas_sync_user` | Existing pattern already handles worker isolation and retry |
| Opt-out check in alert path | Re-implement guard logic | `_get_user_sms_state()` + existing `sms_opted_out` check | Already battle-tested in `send_sms_safe()` |
| Idempotent backfill | Python-side dedup | `ON CONFLICT DO NOTHING` in migration's UNIQUE constraint | DB-level atomicity beats application-level dedup |

**Key insight:** This phase adds one new module (`priority/`) but every pattern — DB writes, task fan-out, SMS dispatch, service role Supabase access — already exists in phases 1–4. The correct approach is to follow existing patterns exactly, not invent new ones.

---

## Common Pitfalls

### Pitfall 1: grade_weight Normalization
**What goes wrong:** Canvas deadlines store `grade_weight` as a raw percentage (e.g. `25.0` for 25%). The formula expects a normalized value (0.0–1.0). Passing `25.0` directly gives a `score_event()` result of `(25.0 × 0.35) + ...` = wildly wrong scores above 1.0 after the ×100 multiply.
**Why it happens:** The `deadlines` table schema stores `grade_weight NUMERIC` without enforcing a 0–1 range. The Canvas iCal feed does not include grade weights; they come from syllabus parsing (Phase 7). Most existing rows have `grade_weight = NULL`.
**How to avoid:** In `ingest_canonical_event()`, normalize before scoring: `normalized = (grade_weight or 0) / 100.0 if grade_weight and grade_weight > 1 else (grade_weight or 0)`. Also store the normalized value in `canonical_events.grade_weight`.
**Warning signs:** Priority scores consistently near 100 for all Canvas events.

### Pitfall 2: NULL grade_weight
**What goes wrong:** Most deadlines have `grade_weight = NULL` (Phase 7 syllabus parsing not yet done). Passing `NULL` to the formula crashes or produces `None × 0.35 = TypeError`.
**Why it happens:** Syllabus PDF parsing is deferred to Phase 7. Phase 5 must handle the NULL case gracefully.
**How to avoid:** Default `grade_weight` to `0.0` when NULL: `gw = grade_weight or 0.0`. This means unweighted events score purely on urgency and source authority — correct behavior.

### Pitfall 3: days_remaining Sign and Timezone
**What goes wrong:** `(due_at - now)` produces a negative timedelta for overdue events. If `due_at` is a naive datetime and `now` is timezone-aware (or vice versa), Python raises `TypeError: can't subtract offset-naive and offset-aware datetimes`.
**Why it happens:** Canvas iCal all-day events are stored as `23:59:59Z` (UTC). `datetime.fromisoformat()` on Postgres TIMESTAMPTZ output may or may not include timezone info depending on the supabase-py response format.
**How to avoid:** Always coerce `due_at` to UTC: if `due_dt.tzinfo is None: due_dt = due_dt.replace(tzinfo=timezone.utc)`. Use `datetime.now(timezone.utc)` for `now`. The urgency clamp (`if days_remaining <= 0: return 1.0`) handles overdue correctly.

### Pitfall 4: Duplicate canonical_events on Backfill Re-run
**What goes wrong:** If the backfill task is accidentally triggered twice (Railway restart, manual re-run), all Canvas deadlines are duplicated in `canonical_events`, causing double alert SMS and duplicate briefing items.
**Why it happens:** Celery tasks are at-least-once by default. One-shot tasks have no idempotency guarantee.
**How to avoid:** Add `UNIQUE (user_id, source, title, due_at)` constraint to `canonical_events` in migration 005. Use `ON CONFLICT DO NOTHING` on the backfill insert. This makes the backfill task idempotent at zero extra application code cost.

### Pitfall 5: delivery_status Staleness After Digest Send
**What goes wrong:** An event with `delivery_status = 'digest'` appears in multiple briefings because the briefing task never marks it as sent.
**Why it happens:** `delivery_status` is set at ingest time. Nothing currently updates it after the briefing sends.
**How to avoid:** After `generate_briefing()` succeeds in `generate_daily_briefing_user`, update all `canonical_events` rows that were included: `UPDATE canonical_events SET delivery_status = 'sent' WHERE user_id = ? AND delivery_status = 'digest' AND due_at <= [cutoff]`. This is a Claude's Discretion item — implement as part of the briefing task update.

### Pitfall 6: Immediate Alert Fires During Backfill
**What goes wrong:** During the Phase 5 deploy backfill, every Canvas deadline that scores ≥ 80 fires an immediate SMS — potentially spamming users with dozens of alerts at 3am.
**Why it happens:** `ingest_canonical_event()` calls `send_priority_alert.delay()` unconditionally for `delivery_status = 'immediate'`. Backfill re-ingests events that were already known.
**How to avoid:** The backfill task should pass a `skip_routing=True` flag to `ingest_canonical_event()`, or use a dedicated `backfill_ingest()` variant that writes to `canonical_events` without triggering the delivery router. Backfilled events should be marked `delivery_status = 'digest'` or `'silent'` rather than triggering immediate SMS for already-known events.

---

## Code Examples

### Score Computation (verified against locked formula)
```python
# Source: 05-CONTEXT.md locked decisions
import math

def compute_urgency(days_remaining: float) -> float:
    if days_remaining <= 0:
        return 1.0
    return min(1.0, math.exp(-0.15 * days_remaining))

# Spot checks from CONTEXT.md:
# 14 days: min(1.0, e^(-2.1)) = min(1.0, 0.122) = 0.12  ✓
# 7 days:  min(1.0, e^(-1.05)) = min(1.0, 0.350) = 0.35 ✓
# 3 days:  min(1.0, e^(-0.45)) = min(1.0, 0.638) = 0.64 ✓
# 1 day:   min(1.0, e^(-0.15)) = min(1.0, 0.861) = 0.86 ✓
# 0 days:  clamped to 1.0                                ✓
```

### Delivery Router
```python
# celery_worker/priority/router.py

def route_event(priority_score: int) -> str:
    """Map priority score to delivery_status string.

    Args:
        priority_score: Integer 0–100 (score_event() * 100, rounded).

    Returns:
        'immediate' | 'digest' | 'silent'
    """
    if priority_score >= 80:
        return "immediate"
    elif priority_score >= 50:
        return "digest"
    else:
        return "silent"
```

### Migration 005 — canonical_events table
```sql
-- supabase/migrations/005_canonical_events.sql
-- Phase 5: Canonical Timeline DB — unified event store for all integrations.
-- Canvas deadlines are backfilled into this table via Celery task on deploy.
-- IMPORTANT: Never run this migration without notifying the other developer first.

CREATE TABLE public.canonical_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('canvas', 'gcal', 'gmail', 'todoist')),
  type TEXT,
  title TEXT NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  course_id TEXT,
  grade_weight NUMERIC,      -- stored normalized 0.0–1.0
  priority_score INTEGER,    -- 0–100
  delivery_status TEXT NOT NULL DEFAULT 'silent'
    CHECK (delivery_status IN ('immediate', 'digest', 'silent', 'sent')),
  snoozed_until TIMESTAMPTZ, -- mirrors deadlines.snoozed_until for briefing compatibility
  deleted_at TIMESTAMPTZ,    -- mirrors deadlines.deleted_at for soft delete compatibility
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, source, title, due_at)  -- idempotent backfill
);

ALTER TABLE public.canonical_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "User-scoped" ON public.canonical_events FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- Covering index for briefing query (active digest events by user, ordered by due_at)
CREATE INDEX idx_canonical_events_briefing
  ON public.canonical_events (user_id, due_at)
  WHERE deleted_at IS NULL
    AND delivery_status IN ('digest', 'immediate');

-- Index for delivery routing check (find immediate events not yet sent)
CREATE INDEX idx_canonical_events_delivery
  ON public.canonical_events (user_id, delivery_status, created_at)
  WHERE delivery_status = 'immediate';
```

### canvas_sync_user integration point
```python
# In tasks.py canvas_sync_user, after apply_diff(user_id, diff):
# Write added/changed events to canonical_events and trigger priority routing.

from priority.ingest import ingest_canonical_event

for event in diff["added"] + diff["changed"]:
    ingest_canonical_event(
        user_id=user_id,
        source="canvas",
        event_type=event.get("type", "assignment"),
        title=event["title"],
        due_at=event["due_date"],
        course_id=event.get("course"),
        grade_weight=event.get("grade_weight"),  # may be None — ingest handles it
    )
```

### Updated briefing query
```python
# celery_worker/ai/db.py — replacement for get_deadlines_for_briefing()

def get_events_for_briefing(user_id: str, days_ahead: int = 7) -> list[dict]:
    """Fetch active digest/immediate events from canonical_events for briefing.

    Replaces get_deadlines_for_briefing() — reads canonical_events going forward.
    """
    client = _get_supabase()
    now = datetime.now(timezone.utc)
    cutoff = (now + timedelta(days=days_ahead)).isoformat()
    result = (
        client.table("canonical_events")
        .select("id, title, due_at, course_id, type, grade_weight, priority_score, delivery_status, snoozed_until")
        .eq("user_id", user_id)
        .is_("deleted_at", "null")
        .in_("delivery_status", ["digest", "immediate"])
        .lte("due_at", cutoff)
        .order("due_at", desc=False)
        .execute()
    )
    # Filter snoozed in Python (same pattern as existing deadlines query)
    active = []
    for e in result.data:
        snoozed = e.get("snoozed_until")
        if snoozed:
            snooze_dt = datetime.fromisoformat(str(snoozed))
            if now < snooze_dt:
                continue
        active.append(e)
    return active
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| briefing reads from `deadlines` | briefing reads from `canonical_events` | Phase 5 | Single query path for all event sources; Phase 6 events appear in briefings automatically |
| canvas_sync writes only to `deadlines` | canvas_sync writes to `deadlines` (source truth) AND `canonical_events` (unified store) | Phase 5 | `deadlines` stays as Canvas-specific audit log; canonical_events is what the AI layer reads |
| No delivery routing | Three-tier router (immediate/digest/silent) | Phase 5 | High-priority events bypass briefing queue and arrive within 60 seconds |

**Deprecated/outdated after Phase 5:**
- `get_deadlines_for_briefing()` in `ai/db.py`: replaced by `get_events_for_briefing()`. Keep the old function but add a deprecation comment — do not delete until Phase 6 confirms canonical_events has full coverage.

---

## Open Questions

1. **delivery_status after alert is sent**
   - What we know: `send_priority_alert` Celery task sends the SMS via `send_sms_alert()`.
   - What's unclear: Should `delivery_status` update from `'immediate'` to `'sent'` after the SMS fires? If not, the `idx_canonical_events_delivery` index will include already-sent events indefinitely.
   - Recommendation: Update `delivery_status = 'sent'` in `send_priority_alert` task after confirmed SMS send. This mirrors how digest events are marked `'sent'` after the briefing runs.

2. **Priority re-scoring on Canvas diff (changed events)**
   - What we know: `canvas_sync_user` calls `ingest_canonical_event()` for both `diff["added"]` and `diff["changed"]`.
   - What's unclear: When a `changed` event already exists in `canonical_events` (via the UNIQUE constraint), should the priority score be re-computed (UPDATE) or silently skipped (ON CONFLICT DO NOTHING)?
   - Recommendation: Use `ON CONFLICT (user_id, source, title, due_at) DO UPDATE SET priority_score = EXCLUDED.priority_score, delivery_status = EXCLUDED.delivery_status` for changed events, but only if `due_at` actually changed (which is the only diff that triggers `changed` per the Phase 2 diff sensitivity decision). Simpler alternative: DELETE the old row and INSERT the new one in `ingest_canonical_event()` for `source='canvas'` changed events.

3. **TCPA consent flag for Seb**
   - What we know: Bypassing quiet hours for score ≥ 80 requires explicit "time-sensitive deadline alerts at any hour" consent language in onboarding.
   - What's unclear: This is a Phase 8 UI task, but the backend must not ship to beta users without it.
   - Recommendation: Add a `has_alert_consent BOOLEAN DEFAULT false` column to `users` table (or `preferences_json`) and have `send_sms_alert()` check it. When `false`, fall back to `send_sms_safe()`. Flag this as a dependency for Phase 8 / Yale beta.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | pytest (version per celery_worker/requirements-dev.txt) |
| Config file | `celery_worker/pytest.ini` — `testpaths = tests` |
| Quick run command | `cd celery_worker && python -m pytest tests/priority/ -x -q` |
| Full suite command | `cd celery_worker && python -m pytest tests/ -q` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| PRIO-01 | `canonical_events` schema accepts source/type/title/due_at/course_id/grade_weight | unit (mock Supabase) | `pytest tests/priority/test_ingest.py::test_canonical_insert -x` | Wave 0 |
| PRIO-01 | Backfill task copies all `deadlines` rows to `canonical_events` | unit (mock Supabase) | `pytest tests/priority/test_ingest.py::test_backfill_per_user -x` | Wave 0 |
| PRIO-02 | `score_event()` returns correct values for spot-check inputs from CONTEXT.md | unit (pure Python) | `pytest tests/priority/test_engine.py -x` | Wave 0 |
| PRIO-02 | NULL `grade_weight` defaults to 0.0, does not raise | unit | `pytest tests/priority/test_engine.py::test_null_grade_weight -x` | Wave 0 |
| PRIO-02 | Overdue events (days_remaining < 0) clamp urgency to 1.0 | unit | `pytest tests/priority/test_engine.py::test_overdue_urgency -x` | Wave 0 |
| PRIO-03 | `route_event(82)` returns `'immediate'`, `route_event(65)` returns `'digest'`, `route_event(30)` returns `'silent'` | unit | `pytest tests/priority/test_router.py -x` | Wave 0 |
| PRIO-03 | `send_sms_alert()` sends when user is active, returns False when opted out | unit (mock Twilio) | `pytest tests/sms/test_send.py::test_send_sms_alert -x` | Wave 0 |
| PRIO-03 | `send_sms_alert()` ignores quiet hours and daily cap | unit (mock) | `pytest tests/sms/test_send.py::test_alert_bypasses_guards -x` | Wave 0 |

### Sampling Rate
- **Per task commit:** `cd celery_worker && python -m pytest tests/priority/ -x -q`
- **Per wave merge:** `cd celery_worker && python -m pytest tests/ -q`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `celery_worker/tests/priority/__init__.py` — package marker
- [ ] `celery_worker/tests/priority/test_engine.py` — covers PRIO-02 (score_event, compute_urgency, spot checks)
- [ ] `celery_worker/tests/priority/test_router.py` — covers PRIO-03 routing thresholds
- [ ] `celery_worker/tests/priority/test_ingest.py` — covers PRIO-01 (canonical write, backfill idempotency)
- [ ] `celery_worker/tests/sms/test_send.py` additions — `test_send_sms_alert`, `test_alert_bypasses_guards` (new test functions in existing file)
- [ ] `celery_worker/priority/__init__.py` — package marker
- [ ] `celery_worker/priority/engine.py`, `router.py`, `ingest.py` — source module stubs

---

## Sources

### Primary (HIGH confidence)
- Direct codebase inspection: `celery_worker/sms/send.py` — `send_sms_direct()` pattern confirmed; `send_sms_alert()` follows same structure
- Direct codebase inspection: `celery_worker/ai/db.py` — `get_deadlines_for_briefing()` filter logic; confirmed `snoozed_until` Python post-filter pattern
- Direct codebase inspection: `celery_worker/tasks.py` — `canvas_sync_all` → `canvas_sync_user` fan-out pattern; `apply_diff` integration point
- Direct codebase inspection: `supabase/migrations/001–004` — existing schema; UNIQUE constraint pattern not yet used (opportunity)
- `05-CONTEXT.md` — all formulas, thresholds, and architecture decisions locked and verified
- Python stdlib `math` module documentation — `math.exp()` confirmed available

### Secondary (MEDIUM confidence)
- Celery task retry patterns: confirmed by existing `canvas_sync_user` (autoretry_for, retry_backoff, max_retries) — same pattern applies to `send_priority_alert`
- PostgreSQL `ON CONFLICT DO NOTHING` with UNIQUE constraint — standard SQL, confirmed by existing migration patterns in this codebase

### Tertiary (LOW confidence)
- None — all claims grounded in direct codebase inspection or locked CONTEXT.md decisions

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new dependencies; all libraries already installed and used
- Architecture: HIGH — all patterns are direct extensions of existing Phase 1–4 code
- Pitfalls: HIGH — identified from direct schema inspection (NULL grade_weight, timezone issues) and existing codebase patterns
- Formula correctness: HIGH — spot-checked against CONTEXT.md locked values using `math.exp(-0.15 × n)`

**Research date:** 2026-03-19
**Valid until:** 2026-04-19 (stable domain — no external API changes affect this phase)
