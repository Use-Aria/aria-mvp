# Phase 07: Syllabus Parsing + Study Gap Detection - Research

**Researched:** 2026-03-20
**Domain:** PDF text extraction, Claude Opus structured extraction, Celery async processing, Next.js multipart upload
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**PDF Upload Pathway:**
- Upload endpoint: `POST /api/upload/syllabus` multipart (already in CLAUDE.md file structure)
- File size limit: 4MB client-side validation (Vercel Hobby multipart cap is ~4.5MB; 4MB gives buffer; typical syllabi are 100KB–2MB)
- Raw PDF is NOT stored permanently — parse immediately via Celery, discard PDF bytes after enqueue
- Next.js route enqueues Celery task and returns HTTP 202; user gets SMS confirmation when parsing completes
- Processing is fully async (Claude Opus calls take 5–20s — synchronous route would timeout)

**Parsed JSON Schema:**
Structure stored in `syllabi.parsed_json`:
```json
{
  "course_name": "BIOL 201",
  "exams": [
    {"title": "Midterm", "date_str": "2026-03-15", "topics": ["Krebs cycle", "glycolysis", "ATP synthesis"], "weight_pct": 25}
  ],
  "assignments": [
    {"type": "Problem Set", "weight_pct": 15}
  ],
  "total_tracked_weight_pct": 75
}
```
- Topics are flat string lists per exam (not nested)
- `date_str` is raw string as extracted by Claude Opus; downstream normalizes to ISO date
- Multiple syllabi per user: one per course, upsert on `(user_id, course_name)` — re-upload replaces
- Downstream consumers (briefing, gap analysis) read directly from `syllabi.parsed_json` — no secondary table

**Study Gap Analysis Delivery:**
- Trigger: T-5 days before exam (locked)
- "Covered material" definition: time-elapsed proxy — topics from exams scheduled more than 5 days prior are assumed covered; topics for the upcoming exam are gap candidates
- SMS format: "Gap alert for [Course] exam in 5 days: [topic 1], [topic 2], [topic 3] (worth ~X%). Review these first." — under 800 chars, top 3 topics by weight_pct descending
- Delivery: routes through existing `send_priority_alert` → batch queue (SMS-10/SMS-11 compliant)
- Beat task: daily scan, same `renew_watch_channels` pattern

**Briefing Enrichment Scope:**
- `grade_weight` already flows through `canonical_events` → `generate_briefing` (Phase 5 shim — no change needed)
- New enrichment: if exam is within 7 days AND `syllabi.parsed_json` exists for that course → append top-3 uncovered topic hint to Claude prompt
- Monday extended briefing: include exam topic coverage summary for all exams in next 14 days
- Enrichment gated: graceful degradation if no syllabus uploaded — briefing still works without it
- Enrichment follows same `is_monday` gating pattern as `gcal_context`

### Claude's Discretion
- Exact Claude Opus prompt for PDF parsing (structure it to extract reliably; handle edge cases like combined midterm/final sections)
- How to handle syllabi where grade weights don't sum to 100% (partial syllabi)
- Error handling when Opus extracts malformed or empty JSON
- Beat task scheduling (daily at what time — pick a low-traffic window)

### Deferred Ideas (OUT OF SCOPE)
- Manual topic coverage tracking (student marks topics as "covered") — Phase 9+
- Lecture note upload for more precise gap detection — future phase
- Re-parse trigger when syllabus is re-uploaded — could be Phase 9 polish
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| AI-01 | User can upload syllabus PDF via web UI | Next.js App Router `req.formData()` pattern confirmed; 4MB limit maps to Vercel Hobby cap |
| AI-02 | Claude Opus parses syllabus PDF and extracts exams, assignments, topics, and grade weights | Anthropic document block API (base64 PDF) confirmed for claude-opus-4-6; structured JSON extraction via explicit schema prompt |
| AI-03 | Parsed syllabus data stored as structured JSON in Supabase `syllabi` table | `syllabi` table exists in migration 001 with `id, user_id, course_name, raw_text, parsed_json, uploaded_at`; upsert on `(user_id, course_name)` needed |
| AI-10 | Study gap analysis generated at T-5 days before exam, cross-referencing syllabus topics against covered material | `get_exam_touchpoints()` already identifies T-5; Beat task pattern from `renew_watch_channels`; `enqueue_alert` → batch queue already in place |
| INTEL-01 | Study gap detection — cross-reference syllabus topics with covered material; surface gaps before exams | Time-elapsed proxy: topics from past exams (>5 days prior) assumed covered; upstream exam topics are gap candidates; top-3 by weight_pct |
</phase_requirements>

---

## Summary

Phase 7 is a backend intelligence upgrade that adds syllabus parsing and gap analysis to the existing Celery + Briefing + SMS stack. No new third-party integrations are required — everything builds on patterns established in Phases 3-6.

The core technical work is: (1) a multipart Next.js API route that reads a PDF buffer, base64-encodes it, and enqueues a Celery task; (2) a Python Celery task that sends the base64 PDF directly to Claude Opus via the document block API and extracts structured JSON; (3) a new Celery Beat daily scan task that identifies T-5 exams across all users and dispatches gap analysis SMS; and (4) additive enrichment of `generate_briefing()` with an optional `syllabus_context` parameter mirroring the existing `gcal_context` pattern.

The `syllabi` table already exists from the Phase 1 migration with all required columns (`id, user_id, course_name, raw_text, parsed_json, uploaded_at`). No new migration is required unless a unique constraint on `(user_id, course_name)` is missing — that must be verified before planning. The PDF bytes are never persisted: they flow from Next.js memory → Redis queue → Celery worker memory → discarded after Claude call.

**Primary recommendation:** Send PDF bytes directly to Claude Opus via the document block API (base64). Skip pdfplumber entirely — Claude's native PDF understanding is more robust for unstructured syllabus layouts than text extraction + LLM chain. Add pdfplumber only as a fallback if document block fails on a malformed PDF.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| anthropic | >=0.86.0 (already in requirements.txt) | Claude Opus document block API — send PDF bytes directly | Already installed; document block handles scanned/formatted PDFs without pre-extraction |
| pdfplumber | 0.11.9 | Fallback plain-text extraction when document block fails | Best Python PDF text accuracy for structured layouts; active maintenance (Jan 2026 release) |
| celery | 5.6.2 (already in requirements.txt) | Async task processing for parse_syllabus_task, gap_analysis_all_users | Already deployed; Beat scheduler for daily gap scan |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| ioredis | (already in Next.js package.json) | Enqueue Celery task from Next.js API route | Already used for gcal/gmail webhook task dispatch |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Claude document block (base64 PDF) | pdfplumber text → Claude text prompt | Document block handles scanned PDFs, tables, mixed layouts; text extraction loses column structure; document block is simpler |
| pdfplumber (fallback) | pymupdf / pypdf | pdfplumber has best table accuracy for structured syllabi; pymupdf faster but messier text for complex layouts |

**Installation:**
```bash
pip install pdfplumber==0.11.9
```

**Version verification:**
```bash
# pdfplumber 0.11.9 — confirmed PyPI, released January 5, 2026
# anthropic >=0.86.0 — already in requirements.txt, document block supported since 0.40+
```

---

## Architecture Patterns

### Recommended Project Structure (new files only)
```
celery_worker/
├── ai/
│   ├── syllabus.py          # parse_syllabus_pdf() — Claude Opus document block call + JSON extraction
│   └── briefing.py          # MODIFIED — add syllabus_context param to generate_briefing()
├── tests/
│   └── ai/
│       ├── test_syllabus.py  # unit tests for parse_syllabus_pdf, get_syllabus_context
│       └── test_briefing.py  # EXTENDED — add syllabus_context enrichment tests
src/app/api/upload/syllabus/
└── route.ts                  # NEW — multipart POST, enqueue parse_syllabus_task, return 202
supabase/migrations/
└── 007_syllabi_unique_constraint.sql  # IF NEEDED — add UNIQUE(user_id, course_name)
```

### Pattern 1: Claude Document Block for PDF Parsing
**What:** Send raw PDF bytes (base64-encoded) directly to Claude Opus as a `document` content block alongside a structured extraction prompt. Claude processes the visual layout of the PDF, not just extracted text.
**When to use:** Always as the primary path. The document block handles scanned PDFs, two-column layouts, and tables that confuse text extractors.

```python
# Source: https://platform.claude.com/docs/en/build-with-claude/pdf-support
import base64
from anthropic import Anthropic

def parse_syllabus_pdf(pdf_bytes: bytes, course_hint: str | None = None) -> dict:
    """Parse syllabus PDF via Claude Opus document block.

    Args:
        pdf_bytes: Raw PDF file bytes (max 4MB for our use case, API limit is 32MB).
        course_hint: Optional course name hint from upload form field.

    Returns:
        Parsed JSON dict matching the syllabi.parsed_json schema, or empty dict on failure.
    """
    pdf_data = base64.standard_b64encode(pdf_bytes).decode("utf-8")
    client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

    response = client.messages.create(
        model="claude-opus-4-6",
        max_tokens=1024,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "document",
                        "source": {
                            "type": "base64",
                            "media_type": "application/pdf",
                            "data": pdf_data,
                        },
                    },
                    {
                        "type": "text",
                        "text": SYLLABUS_EXTRACTION_PROMPT,
                    },
                ],
            }
        ],
    )
    # Parse JSON from response — see prompt engineering section
```

### Pattern 2: Celery Task for Async PDF Parsing
**What:** Next.js route receives multipart upload, reads PDF bytes into memory, base64-encodes them, and enqueues a Celery task via Redis LPUSH. Returns 202 immediately. The Celery worker performs the Claude call and writes to `syllabi` table.
**When to use:** Always — Claude Opus calls take 5-20s; synchronous route would hit Vercel timeout.

```python
# celery_worker/tasks.py pattern — follows existing gcal_sync_user/gmail_process_notification
@celery_app.task(
    name="tasks.parse_syllabus_task",
    bind=True,
    autoretry_for=(Exception,),
    retry_backoff=2,
    max_retries=3,
)
def parse_syllabus_task(self, user_id: str, pdf_b64: str, course_name: str) -> dict:
    """Parse syllabus PDF bytes via Claude Opus. Upsert result into syllabi table."""
    from ai.syllabus import parse_syllabus_pdf, upsert_syllabus
    import base64

    pdf_bytes = base64.b64decode(pdf_b64)
    parsed = parse_syllabus_pdf(pdf_bytes, course_hint=course_name)

    if parsed:
        upsert_syllabus(user_id, course_name, parsed)
        # Send confirmation SMS
        from sms.send import _get_user_sms_state, send_sms_safe
        user = _get_user_sms_state(user_id)
        if user.get("phone"):
            send_sms_safe(user_id, user["phone"],
                f"Got it! I've parsed your {course_name} syllabus and I'm tracking exams and grade weights.",
                is_proactive=True)

    return {"user_id": user_id, "course_name": course_name, "parsed": bool(parsed)}
```

### Pattern 3: Next.js Multipart Upload Route
**What:** App Router API route reads FormData, validates file size, base64-encodes PDF bytes, enqueues Celery task via Redis, returns 202.
**When to use:** `POST /api/upload/syllabus` — follows existing gcal webhook Redis pattern.

```typescript
// Source: Next.js App Router — req.formData() is the standard approach
// Pattern mirrors src/app/api/gcal/webhook/route.ts Redis LPUSH structure
export async function POST(request: NextRequest): Promise<NextResponse> {
    const formData = await request.formData()
    const file = formData.get('file') as File | null
    const courseName = formData.get('course_name') as string | null

    if (!file || file.size > 4 * 1024 * 1024) {
        return NextResponse.json({ error: 'File missing or exceeds 4MB limit' }, { status: 400 })
    }

    const bytes = await file.arrayBuffer()
    const pdfB64 = Buffer.from(bytes).toString('base64')

    // Enqueue parse_syllabus_task via Redis (same pattern as gcal webhook)
    // ... Redis LPUSH with Celery message format ...
    return NextResponse.json({ status: 'queued' }, { status: 202 })
}
```

### Pattern 4: Briefing Enrichment via syllabus_context (mirrors gcal_context)
**What:** Add optional `syllabus_context` parameter to `generate_briefing()`. When provided, append top-3 uncovered exam topics to the Claude prompt. Gated by `is_monday` for depth, but daily briefings also get a brief hint when exam is within 7 days.
**When to use:** Called from `generate_daily_briefing_user` — fetch syllabus context before calling `generate_briefing()`, same as `gcal_context` is fetched.

```python
# celery_worker/ai/briefing.py — additive only, no existing code changes
def generate_briefing(
    user_id: str,
    deadlines: list[dict],
    is_monday: bool = False,
    is_welcome: bool = False,
    user_tz: ZoneInfo | None = None,
    gcal_context: dict | None = None,
    syllabus_context: dict | None = None,  # NEW — Phase 7
) -> str:
    ...
    # After gcal_context block:
    if syllabus_context:
        exam_hints = syllabus_context.get("exam_topic_hints") or []
        if exam_hints:
            context_parts.append("\nEXAM TOPIC HINTS (from syllabus):")
            for hint in exam_hints:
                context_parts.append(f"- {hint}")
        if is_monday:
            coverage_summaries = syllabus_context.get("coverage_summaries") or []
            for s in coverage_summaries:
                context_parts.append(f"  {s}")
```

### Pattern 5: Gap Analysis Beat Task (daily scan)
**What:** Daily Beat task that scans all users for T-5 exams, looks up syllabus topics for those courses, builds gap alert SMS body, and routes through `enqueue_alert` → batch queue.
**When to use:** Scheduled at a low-traffic window (03:00 UTC — avoids briefing generation overlap at 06:00-12:00 UTC).

```python
# celery_worker/tasks.py
@celery_app.task(name="tasks.gap_analysis_all_users")
def gap_analysis_all_users() -> dict:
    """Daily fan-out: find all T-5 exams across all users, dispatch gap analysis."""
    # Query canonical_events for type='exam' with due_at in 5 days
    # For each user+exam, dispatch run_gap_analysis_task
    ...

@celery_app.task(name="tasks.run_gap_analysis_task", bind=True, ...)
def run_gap_analysis_task(self, user_id: str, exam_event_id: str) -> dict:
    """Generate and send gap analysis SMS for one user's T-5 exam."""
    # Look up syllabi.parsed_json for course
    # Identify uncovered topics (time-elapsed proxy)
    # Format SMS <= 800 chars, top-3 topics
    # enqueue_alert(user_id, body, priority_score=75)
    ...
```

Beat schedule addition to `celery_app.py`:
```python
"gap-analysis-daily": {
    "task": "tasks.gap_analysis_all_users",
    "schedule": crontab(hour=3, minute=0),  # 03:00 UTC daily — avoids briefing window
},
```

### Anti-Patterns to Avoid
- **Storing PDF bytes in Supabase:** Never persist raw PDF — privacy risk, storage cost, no value once parsed. Parse immediately in Celery and discard.
- **Synchronous Claude Opus call in Next.js route:** Opus calls take 5-20s; Vercel serverless functions have execution limits. Always async via Celery.
- **Re-parsing on every briefing request:** `parsed_json` is the authoritative record. Check `parsed_json IS NOT NULL` before any Claude call. Never re-parse if data exists.
- **Text extraction → LLM chain:** Don't use pdfplumber to extract text and then send text to Claude. Send the raw document block directly — Claude reads the PDF layout natively.
- **Upsert without unique constraint:** Without `UNIQUE(user_id, course_name)` on `syllabi`, upsert will INSERT duplicates. Verify constraint exists before planning.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| PDF text extraction | Custom regex parser, page-layout reader | Claude document block (primary) + pdfplumber (fallback) | Syllabus layouts are wildly inconsistent — two-column, tables, mixed fonts; Claude's vision handles this natively |
| JSON schema enforcement | Parse response text manually | Explicit JSON schema in prompt + `json.loads()` with try/except | Claude Opus reliably outputs valid JSON when schema is in the prompt; structured outputs (beta) available as upgrade path |
| T-5 exam detection | New date math | `get_exam_touchpoints()` already returns T-5 exams — reuse directly | Already tested, timezone-aware, handles all-day event edge cases |
| SMS batch routing | New send path | `enqueue_alert()` + `flush_sms_batch` already implements SMS-10/SMS-11 | Gap alert is just another alert — same batch queue, same cap |

**Key insight:** The hardest part of this phase (reliable JSON from unstructured PDF) is solved by Claude's native document understanding, not custom parsing logic.

---

## Common Pitfalls

### Pitfall 1: Syllabus unique constraint missing
**What goes wrong:** `upsert_syllabus()` uses `ON CONFLICT(user_id, course_name)` but the constraint may not exist in migration 001 — the schema shows `course_name TEXT` but no unique constraint. Without it, every upload INSERTs a duplicate row and `ON CONFLICT` never fires.
**Why it happens:** Migration 001 defined the table schema but did not add a unique constraint (verified by reading the SQL). The `ON CONFLICT` clause requires a named constraint.
**How to avoid:** Migration 007 must add `ALTER TABLE public.syllabi ADD CONSTRAINT IF NOT EXISTS syllabi_user_course_unique UNIQUE (user_id, course_name);`
**Warning signs:** Multiple rows for the same user+course in the `syllabi` table.

### Pitfall 2: PDF bytes too large for Redis queue
**What goes wrong:** A 4MB PDF base64-encoded becomes ~5.5MB. Redis default `maxmemory` on Railway is low; large task messages may cause OOM errors or task rejection.
**Why it happens:** Base64 adds ~33% overhead. 4MB PDF → 5.5MB base64 string in the Celery task message.
**How to avoid:** Pass PDF bytes in the task args (acceptable for MVP at 4MB limit — Railway Redis should handle it). If this becomes a problem in Phase 8+, use Supabase Storage as a staging area and pass a storage key instead.
**Warning signs:** Redis OOM errors in Railway logs; Celery tasks silently dropped.

### Pitfall 3: Claude Opus returns non-JSON or partial JSON
**What goes wrong:** Parse task crashes on `json.loads()` or writes incomplete data.
**Why it happens:** Edge cases — syllabus has no grade weights, date formats are unusual (e.g., "Week 8" instead of a date), or PDF is a scanned image with poor OCR quality.
**How to avoid:** Wrap `json.loads()` in try/except; return empty dict on failure; log the raw response text for debugging; send error SMS to user ("I had trouble reading that syllabus — try uploading a text-based PDF if you have one"). Never crash the Celery task.
**Warning signs:** Celery task retries with `json.JSONDecodeError`; empty `parsed_json` in DB.

### Pitfall 4: Gap analysis firing for users without syllabus
**What goes wrong:** `gap_analysis_all_users` fans out to all users with T-5 exams, but many users have no uploaded syllabus — resulting in empty gap alerts or task failures.
**Why it happens:** The gap analysis query finds exams in `canonical_events` regardless of whether `syllabi` has a matching row.
**How to avoid:** In `run_gap_analysis_task`, query `syllabi` for the course first. If no row or `parsed_json IS NULL`, skip silently (no alert). This is the graceful degradation requirement.
**Warning signs:** Empty gap alert SMS ("Gap alert for BIOL 201 exam in 5 days: (no topics found)").

### Pitfall 5: course_id matching between canonical_events and syllabi
**What goes wrong:** `canonical_events.course_id` may not exactly match `syllabi.course_name` (e.g., "BIOL 201" vs "BIOL201" vs "Biology 201").
**Why it happens:** Canvas iCal stores course names in their own format; user types course name when uploading syllabus.
**How to avoid:** Use case-insensitive partial match (ILIKE) for the lookup. Alternatively, in the upload UI (Phase 8), pre-populate the course name field from the user's Canvas courses. For MVP, document that user should type course name to match Canvas exactly.
**Warning signs:** Gap analysis runs but always finds no matching syllabus despite syllabi existing.

---

## Code Examples

Verified patterns from official sources and existing codebase:

### Claude Document Block PDF Call
```python
# Source: https://platform.claude.com/docs/en/build-with-claude/pdf-support
import base64
import json
import os
from anthropic import Anthropic

SYLLABUS_EXTRACTION_PROMPT = """Extract course information from this syllabus. Return ONLY valid JSON matching this exact schema — no explanation, no markdown:

{
  "course_name": "string — course code and name e.g. BIOL 201",
  "exams": [
    {"title": "string", "date_str": "string — raw date text from syllabus", "topics": ["string"], "weight_pct": number_or_null}
  ],
  "assignments": [
    {"type": "string e.g. Problem Set", "weight_pct": number_or_null}
  ],
  "total_tracked_weight_pct": number_or_null
}

Rules:
- Include ALL exams (midterm, final, quizzes if >=10% weight)
- topics: list the exam topic names exactly as stated (e.g. "Chapter 3: Cell Division")
- date_str: copy raw text exactly (e.g. "March 15" or "Week 8") — do NOT convert to ISO date
- weight_pct: null if not stated; do NOT infer or guess weights
- total_tracked_weight_pct: sum of all weight_pct values that are not null
- If grade weights don't sum to 100%, that is fine — this is a partial syllabus
- Return empty arrays [] if no exams or assignments found"""

def parse_syllabus_pdf(pdf_bytes: bytes, course_hint: str | None = None) -> dict | None:
    """Parse syllabus via Claude Opus document block. Returns parsed_json or None."""
    pdf_data = base64.standard_b64encode(pdf_bytes).decode("utf-8")
    client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

    try:
        response = client.messages.create(
            model="claude-opus-4-6",
            max_tokens=1024,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": pdf_data}},
                    {"type": "text", "text": SYLLABUS_EXTRACTION_PROMPT},
                ],
            }],
        )
        text = response.content[0].text.strip()
        # Strip markdown code fences if present
        if text.startswith("```"):
            text = text.split("```")[1]
            if text.startswith("json"):
                text = text[4:]
        return json.loads(text)
    except Exception as e:
        logger.error("parse_syllabus_pdf failed: %s", e)
        return None
```

### Gap Analysis SMS Builder
```python
def build_gap_alert_body(course: str, days_until: int, exam_title: str,
                          topics: list[str], weight_pct: int | None) -> str:
    """Build gap alert SMS body <= 800 chars, top-3 topics.

    Output: "Gap alert for [Course] exam in 5 days: topic1, topic2, topic3 (worth ~X%). Review these first."
    """
    top_topics = topics[:3]
    topics_str = ", ".join(top_topics)
    weight_str = f" (worth ~{weight_pct}%)" if weight_pct else ""
    body = f"Gap alert for {course} exam in {days_until} days: {topics_str}{weight_str}. Review these first."
    if len(body) > 800:
        body = body[:797] + "..."
    return body
```

### Syllabus DB Upsert Pattern
```python
# Follows existing upsert pattern from calendar_events (Phase 6)
def upsert_syllabus(user_id: str, course_name: str, parsed_json: dict) -> None:
    """Upsert syllabus parsed_json. Idempotent on (user_id, course_name)."""
    from ai.db import _get_supabase
    client = _get_supabase()
    client.table("syllabi").upsert(
        {
            "user_id": user_id,
            "course_name": course_name,
            "parsed_json": parsed_json,
            "uploaded_at": datetime.now(timezone.utc).isoformat(),
        },
        on_conflict="user_id,course_name",  # requires UNIQUE constraint in migration 007
    ).execute()
```

### Next.js Upload Route (Redis Enqueue)
```typescript
// Source: mirrors src/app/api/gcal/webhook/route.ts Redis LPUSH pattern
// src/app/api/upload/syllabus/route.ts
import { NextRequest, NextResponse } from 'next/server'
import Redis from 'ioredis'

export async function POST(request: NextRequest): Promise<NextResponse> {
    const formData = await request.formData()
    const file = formData.get('file') as File | null
    const courseName = (formData.get('course_name') as string) || ''
    const userId = /* extract from Supabase session */ ''

    if (!file) return NextResponse.json({ error: 'No file' }, { status: 400 })
    if (file.size > 4 * 1024 * 1024) return NextResponse.json({ error: 'Exceeds 4MB limit' }, { status: 413 })

    const bytes = await file.arrayBuffer()
    const pdfB64 = Buffer.from(bytes).toString('base64')

    const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379/0')
    const taskId = crypto.randomUUID()
    const taskMessage = JSON.stringify({
        id: taskId, task: 'tasks.parse_syllabus_task',
        args: [userId, pdfB64, courseName], kwargs: {}, retries: 0,
    })
    await redis.lpush('celery', JSON.stringify({
        'content-type': 'application/json',
        'content-encoding': 'utf-8',
        headers: { id: taskId, task: 'tasks.parse_syllabus_task', lang: 'py', root_id: taskId, parent_id: null, group: null },
        properties: { correlation_id: taskId, reply_to: '', delivery_mode: 2, delivery_tag: taskId, body_encoding: 'utf-8' },
        body: Buffer.from(taskMessage).toString('base64'),
    }))
    await redis.quit()

    return NextResponse.json({ status: 'queued', taskId }, { status: 202 })
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Extract text then send to LLM | Send raw PDF via document block | Anthropic 2024 PDF support | Claude reads layout directly — no text extraction needed for primary path |
| Store uploaded files in object storage first | Process in memory, discard after parse | Phase 7 decision (locked) | No storage cost, simpler code, no cleanup needed |
| Separate pgvector similarity search for gap detection | Time-elapsed proxy (no vectors needed) | Phase 7 decision (MVP simplification) | Eliminates pgvector setup; accurate enough for MVP |

**Deprecated/outdated:**
- Chroma vector DB: Replaced by pgvector decision in project CLAUDE.md — but pgvector is NOT needed for Phase 7 gap analysis because the time-elapsed proxy requires no vector similarity.

---

## Open Questions

1. **Unique constraint on `syllabi(user_id, course_name)` — does it exist?**
   - What we know: Migration 001 created the `syllabi` table with `course_name TEXT` but no unique constraint is visible in the SQL.
   - What's unclear: Whether a later migration added one. Searched all 6 migrations — none add this constraint.
   - Recommendation: Migration 007 MUST add this constraint. Plan must include it as Wave 0.

2. **User authentication in `/api/upload/syllabus` route**
   - What we know: The user_id must come from a validated Supabase session; Phase 8 is when the full frontend auth flow ships.
   - What's unclear: How Phase 7 tests the upload endpoint without a logged-in user session (no onboarding UI until Phase 8).
   - Recommendation: Add a `user_id` query parameter as a temporary bypass for Phase 7 testing, same as how other routes handle pre-Phase-8 testing. Document as a Phase 8 security hardening item.

3. **`course_id` vs `course_name` matching for gap analysis**
   - What we know: `canonical_events.course_id` comes from Canvas iCal (e.g., "BIOL 201"). `syllabi.course_name` is typed by the user at upload time.
   - What's unclear: How consistently users type it.
   - Recommendation: Use `ILIKE '%{course_name}%'` for the match in gap analysis lookup. Document in SMS confirmation to user: "I've saved your [typed course name] syllabus. Make sure this matches your Canvas course name for gap alerts to work."

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | pytest (existing in celery_worker/) |
| Config file | `celery_worker/conftest.py` — adds celery_worker root to sys.path |
| Quick run command | `cd celery_worker && python -m pytest tests/ai/test_syllabus.py tests/test_tasks_ai.py -x -q` |
| Full suite command | `cd celery_worker && python -m pytest tests/ -x -q` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| AI-01 | POST /api/upload/syllabus returns 202 and enqueues task | unit (mock Redis) | `cd celery_worker && python -m pytest tests/test_tasks_syllabus.py::test_parse_syllabus_task_enqueues -x` | ❌ Wave 0 |
| AI-02 | parse_syllabus_pdf calls Claude Opus with document block, returns valid JSON | unit (mock Anthropic) | `cd celery_worker && python -m pytest tests/ai/test_syllabus.py::test_parse_syllabus_calls_opus -x` | ❌ Wave 0 |
| AI-02 | parse_syllabus_pdf returns None on malformed JSON (graceful failure) | unit | `cd celery_worker && python -m pytest tests/ai/test_syllabus.py::test_parse_syllabus_handles_bad_json -x` | ❌ Wave 0 |
| AI-03 | upsert_syllabus writes to syllabi table idempotently | unit (mock Supabase) | `cd celery_worker && python -m pytest tests/ai/test_syllabus.py::test_upsert_syllabus_idempotent -x` | ❌ Wave 0 |
| AI-03 | PDF is never re-parsed if parsed_json already exists | unit | `cd celery_worker && python -m pytest tests/ai/test_syllabus.py::test_skip_reparse_if_parsed_json_exists -x` | ❌ Wave 0 |
| AI-10 | run_gap_analysis_task builds correct SMS body (top-3 topics, under 800 chars) | unit | `cd celery_worker && python -m pytest tests/ai/test_syllabus.py::test_gap_alert_body_format -x` | ❌ Wave 0 |
| AI-10 | run_gap_analysis_task skips user when no syllabus found for course | unit | `cd celery_worker && python -m pytest tests/ai/test_syllabus.py::test_gap_analysis_skips_no_syllabus -x` | ❌ Wave 0 |
| AI-10 | gap_analysis_all_users fans out per user with T-5 exam | unit | `cd celery_worker && python -m pytest tests/test_tasks_syllabus.py::test_gap_analysis_all_users_dispatches -x` | ❌ Wave 0 |
| INTEL-01 | Time-elapsed proxy correctly classifies topics as covered/uncovered | unit | `cd celery_worker && python -m pytest tests/ai/test_syllabus.py::test_gap_topics_time_elapsed_proxy -x` | ❌ Wave 0 |
| AI-08 | generate_briefing includes syllabus_context topics in prompt when provided | unit (mock Anthropic) | `cd celery_worker && python -m pytest tests/ai/test_briefing.py::test_briefing_includes_syllabus_context -x` | ❌ Wave 0 |
| AI-08 | generate_briefing works without syllabus_context (backwards compatible) | unit | `cd celery_worker && python -m pytest tests/ai/test_briefing.py::test_briefing_no_syllabus_context_unchanged -x` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `cd celery_worker && python -m pytest tests/ai/test_syllabus.py -x -q`
- **Per wave merge:** `cd celery_worker && python -m pytest tests/ -x -q`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `celery_worker/tests/ai/test_syllabus.py` — covers AI-02, AI-03, AI-10, INTEL-01
- [ ] `celery_worker/tests/test_tasks_syllabus.py` — covers AI-01 task dispatch and gap fan-out
- [ ] `pdfplumber==0.11.9` install in `celery_worker/requirements.txt` — fallback extractor

---

## Sources

### Primary (HIGH confidence)
- Official Anthropic PDF support docs: https://platform.claude.com/docs/en/build-with-claude/pdf-support — document block structure, base64 encoding, model support confirmed
- `supabase/migrations/001_initial_schema.sql` (read directly) — `syllabi` table columns confirmed; unique constraint absence confirmed
- `celery_worker/ai/briefing.py` (read directly) — `generate_briefing()` signature, `gcal_context` pattern, `get_exam_touchpoints()` reuse confirmed
- `celery_worker/tasks.py` (read directly) — `renew_watch_channels`, `send_priority_alert`, `enqueue_alert` patterns confirmed
- `celery_worker/sms/batch.py` (read directly) — `enqueue_alert()` interface confirmed
- `celery_worker/celery_app.py` (read directly) — Beat schedule pattern confirmed, existing schedules documented
- `src/app/api/gcal/webhook/route.ts` (read directly) — Redis LPUSH Celery task dispatch pattern confirmed

### Secondary (MEDIUM confidence)
- PyPI pdfplumber 0.11.9: https://pypi.org/project/pdfplumber/ — latest version confirmed (January 5, 2026 release)
- DEV Community 2025 PDF extractor comparison: https://dev.to/onlyoneaman/i-tested-7-python-pdf-extractors-so-you-dont-have-to-2025-edition-akm — pdfplumber vs pymupdf accuracy comparison

### Tertiary (LOW confidence)
- WebSearch results on Claude structured JSON extraction — general patterns, not Claude-opus-4-6 specific; confidence increases because existing codebase already uses this model successfully

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — document block API and pdfplumber confirmed from official sources and PyPI
- Architecture: HIGH — all patterns read directly from existing codebase files; no assumptions
- Pitfalls: HIGH for database constraint issue (verified by reading migration SQL); MEDIUM for Redis size concern (theoretical, not observed)
- Test map: HIGH — mirrors existing test structure in celery_worker/tests/

**Research date:** 2026-03-20
**Valid until:** 2026-04-20 (30 days — stable libraries, no fast-moving dependencies)
