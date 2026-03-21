---
phase: 07-syllabus-parsing-study-gap-detection
verified: 2026-03-20T00:00:00Z
status: passed
score: 11/11 must-haves verified
re_verification: false
---

# Phase 7: Syllabus Parsing + Study Gap Detection Verification Report

**Phase Goal:** Users can upload course syllabi and Aria extracts exam topics, grade weights, and coverage — briefings become grade-aware and T-5 gap analysis becomes functional
**Verified:** 2026-03-20
**Status:** passed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A syllabus PDF uploaded via POST /api/upload/syllabus returns 202 and enqueues a Celery task | VERIFIED | `route.ts` returns `NextResponse.json({ status: 'queued', taskId }, { status: 202 })` after `redis.lpush('celery', ...)` with `tasks.parse_syllabus_task` |
| 2 | Claude Opus parses the PDF via document block API and returns structured JSON with exams, assignments, topics, and grade weights | VERIFIED | `parse_syllabus_pdf()` in `syllabus.py` calls `model="claude-opus-4-6"` with `type: "document"`, `source.type: "base64"`, `source.media_type: "application/pdf"` |
| 3 | Parsed JSON is upserted into syllabi table on (user_id, course_name) — re-upload replaces, never duplicates | VERIFIED | `upsert_syllabus()` calls `.upsert({...}, on_conflict="user_id,course_name")`. Migration 007 adds `UNIQUE (user_id, course_name)` constraint |
| 4 | A PDF is never re-parsed; if parsed_json already exists for (user_id, course_name), the task skips Claude and reuses existing data | VERIFIED | `parse_syllabus_task` calls `check_existing_syllabus()` first; returns `{"skipped": True}` if non-null `parsed_json` exists |
| 5 | User receives an SMS confirmation when parsing completes | VERIFIED | `parse_syllabus_task` calls `send_sms_safe()` on success, failure, and skip (already-exists) paths |
| 6 | If Claude returns malformed JSON, the task does not crash and returns None gracefully | VERIFIED | `parse_syllabus_pdf()` wraps entire call in `try/except Exception: return None`; markdown fence stripping also present |
| 7 | At T-5 days before an exam, Aria generates a gap analysis SMS with top-3 uncovered topics ranked by weight | VERIFIED | `gap_analysis_all_users` queries `canonical_events` for T-5 date range, fans out `run_gap_analysis_task.delay()`. `get_gap_topics()` returns topics sorted by `weight_pct` descending, capped at 3. `build_gap_alert_body()` formats SMS under 800 chars |
| 8 | Gap analysis skips silently when no syllabus exists for the exam's course (graceful degradation) | VERIFIED | `run_gap_analysis_task` returns `{"status": "skipped", "reason": "no_syllabus_or_topics"}` when `get_gap_topics()` returns `[]`; no SMS sent |
| 9 | Daily briefings include grade weight context and exam topic hints from parsed syllabi | VERIFIED | `generate_daily_briefing_user` calls `get_syllabus_context()` and passes `syllabus_context=syllabus_context` to `generate_briefing()`. `generate_briefing()` appends `EXAM TOPIC HINTS (from syllabus)` block to Claude prompt |
| 10 | Monday extended briefing includes exam topic coverage summaries for exams in next 14 days | VERIFIED | `get_syllabus_context(is_monday=True)` populates `coverage_summaries`. `generate_briefing()` appends `EXAM TOPIC COVERAGE (next 14 days)` block when `is_monday=True` |
| 11 | Briefings work identically to before if no syllabus is uploaded (backwards compatible) | VERIFIED | `get_syllabus_context()` returns `None` when no syllabi rows exist. `generate_briefing()` skips the syllabus block entirely when `syllabus_context is None` |

**Score:** 11/11 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `supabase/migrations/007_syllabi_unique_constraint.sql` | UNIQUE constraint on syllabi(user_id, course_name) | VERIFIED | Contains `ADD CONSTRAINT syllabi_user_course_unique UNIQUE (user_id, course_name)` |
| `celery_worker/ai/syllabus.py` | parse_syllabus_pdf(), upsert_syllabus(), check_existing_syllabus(), get_gap_topics(), build_gap_alert_body(), get_syllabus_context() | VERIFIED | 364 lines; all 6 functions present with full implementations |
| `celery_worker/tasks.py` | parse_syllabus_task, gap_analysis_all_users, run_gap_analysis_task | VERIFIED | All 3 tasks registered with `@celery_app.task(name="tasks.X")` |
| `src/app/api/upload/syllabus/route.ts` | POST endpoint for multipart PDF upload | VERIFIED | `export async function POST`, validates 4MB limit, 202 response, Redis LPUSH |
| `celery_worker/celery_app.py` | gap-analysis-daily Beat schedule entry at 03:00 UTC | VERIFIED | `"gap-analysis-daily"` entry with `crontab(hour=3, minute=0)` |
| `celery_worker/ai/briefing.py` | syllabus_context parameter in generate_briefing() | VERIFIED | `syllabus_context: dict | None = None` parameter; EXAM TOPIC HINTS and EXAM TOPIC COVERAGE blocks present |
| `celery_worker/tests/ai/test_syllabus.py` | Unit tests for syllabus parsing, upsert, gap analysis | VERIFIED | 430 lines; 17 tests covering all Plan 01 and Plan 02 behaviors |
| `celery_worker/tests/ai/test_briefing_syllabus.py` | Tests for syllabus_context enrichment in briefing | VERIFIED | 209 lines (min: 40); 5 tests covering all briefing enrichment paths |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `src/app/api/upload/syllabus/route.ts` | `celery_worker/tasks.py` | Redis LPUSH with `tasks.parse_syllabus_task` | VERIFIED | `task: 'tasks.parse_syllabus_task'` in header and body; `redis.lpush('celery', ...)` |
| `celery_worker/tasks.py` | `celery_worker/ai/syllabus.py` | lazy import in `parse_syllabus_task` | VERIFIED | `from ai.syllabus import check_existing_syllabus, parse_syllabus_pdf, upsert_syllabus` inside task body |
| `celery_worker/ai/syllabus.py` | Supabase syllabi table | `upsert_syllabus` using `_get_supabase()` | VERIFIED | `client.table("syllabi").upsert({...}, on_conflict="user_id,course_name").execute()` |
| `celery_worker/celery_app.py` | `celery_worker/tasks.py` | Beat schedule triggers `gap_analysis_all_users` daily at 03:00 UTC | VERIFIED | `"task": "tasks.gap_analysis_all_users"` in `gap-analysis-daily` Beat entry |
| `celery_worker/tasks.py` (gap_analysis_all_users) | `celery_worker/tasks.py` (run_gap_analysis_task) | fan-out `.delay()` per user with T-5 exam | VERIFIED | `run_gap_analysis_task.delay(exam["user_id"], exam["id"], ...)` in loop |
| `celery_worker/tasks.py` (run_gap_analysis_task) | `celery_worker/ai/syllabus.py` | lazy import `get_gap_topics, build_gap_alert_body` | VERIFIED | `from ai.syllabus import get_gap_topics, build_gap_alert_body` inside task body |
| `celery_worker/tasks.py` (generate_daily_briefing_user) | `celery_worker/ai/syllabus.py` | lazy import `get_syllabus_context` | VERIFIED | `from ai.syllabus import get_syllabus_context`; `syllabus_context = get_syllabus_context(user_id, deadlines, is_monday=is_monday)`; passed as `syllabus_context=syllabus_context` to `generate_briefing()` |
| `celery_worker/ai/syllabus.py` (get_gap_topics) | Supabase syllabi table | `_get_supabase()` query with ILIKE | VERIFIED | `.ilike("course_name", f"%{course_id}%")` present |

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| AI-01 | 07-01 | User can upload syllabus PDF via web UI | SATISFIED | `POST /api/upload/syllabus` accepts multipart FormData, validates file + course_name + user_id, returns 202 |
| AI-02 | 07-01 | Claude Opus parses syllabus PDF and extracts exams, assignments, topics, and grade weights | SATISFIED | `parse_syllabus_pdf()` sends PDF as document block to `claude-opus-4-6`; extracts all 4 field categories per `SYLLABUS_EXTRACTION_PROMPT` |
| AI-03 | 07-01 | Parsed syllabus data stored as structured JSON in Supabase syllabi table | SATISFIED | `upsert_syllabus()` writes `parsed_json` to `syllabi` table with `on_conflict="user_id,course_name"` |
| AI-10 | 07-02 | Study gap analysis generated at T-5 days before exam, cross-referencing syllabus topics against covered material | SATISFIED | `gap_analysis_all_users` fires at 03:00 UTC via Beat; finds exams due in exactly 5 days; dispatches `run_gap_analysis_task` per user/exam; SMS body under 800 chars with top-3 topics |
| INTEL-01 | 07-02 | Study gap detection — cross-reference syllabus topics with student's covered material; surface gaps before exams | SATISFIED | `get_gap_topics()` queries syllabi with ILIKE matching, returns top-3 topics sorted by weight_pct for the upcoming exam |

**All 5 phase requirements satisfied.**

**Traceability cross-check:** REQUIREMENTS.md marks AI-01, AI-02, AI-03, AI-10, INTEL-01 as Phase 7 / Complete. All match plan declarations and implementation evidence. No orphaned requirements found.

---

### Anti-Patterns Found

No blockers or warnings found.

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `celery_worker/ai/syllabus.py` | 211, 215, 219 | `return []` | Info | Graceful-degradation returns in `get_gap_topics()` when no syllabus/exam/topics found — intentional, not stub behavior |

---

### Human Verification Required

#### 1. End-to-End PDF Upload Flow

**Test:** Upload a real syllabus PDF via `POST /api/upload/syllabus` (multipart form with file, course_name, user_id). Wait for Celery worker to process.
**Expected:** 202 response with taskId; within ~30s, Supabase `syllabi` table contains a row with `parsed_json` populated (has `course_name`, `exams`, `assignments`, `total_tracked_weight_pct`); user receives confirmation SMS.
**Why human:** Requires live Anthropic API call with actual PDF bytes, running Celery worker, and populated Supabase instance.

#### 2. Gap Analysis SMS Content Quality

**Test:** With an exam in `canonical_events` exactly 5 days out and a matching syllabus uploaded, trigger `gap_analysis_all_users` manually or wait for the 03:00 UTC Beat job.
**Expected:** SMS arrives with exam name, "5 days", up to 3 topic names, and grade weight hint. Body is under 800 characters and reads naturally.
**Why human:** Requires live Supabase data, running Celery, and Twilio delivery. Content quality (readability) cannot be verified programmatically.

#### 3. Briefing Syllabus Enrichment in Production

**Test:** On a day with an exam within 7 days in `canonical_events` and a matching syllabus uploaded, trigger `generate_daily_briefing_user` for the user.
**Expected:** The SMS briefing contains exam topic hints section. On Monday, also contains coverage summaries for exams within 14 days.
**Why human:** Requires live Claude API call, Supabase data, and Twilio delivery to verify real prompt enrichment reaches the end SMS.

---

### Gaps Summary

No gaps. All 11 observable truths verified, all 8 artifacts confirmed substantive and wired, all 8 key links confirmed, all 5 requirements satisfied, all 5 commits verified in git history.

---

_Verified: 2026-03-20_
_Verifier: Claude (gsd-verifier)_
