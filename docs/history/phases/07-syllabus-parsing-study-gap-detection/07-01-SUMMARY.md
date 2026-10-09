---
phase: 07-syllabus-parsing-study-gap-detection
plan: "01"
subsystem: syllabus-parsing
tags: [ai, celery, supabase, pdf, claude-opus]
dependency_graph:
  requires: [Phase 06 Celery/Redis infrastructure, syllabi table (migration 001)]
  provides: [parse_syllabus_pdf, upsert_syllabus, check_existing_syllabus, parse_syllabus_task, POST /api/upload/syllabus]
  affects: [celery_worker/tasks.py, supabase/migrations/, src/app/api/]
tech_stack:
  added: [pdfplumber==0.11.9]
  patterns: [Claude document block API, Redis LPUSH Celery task enqueue, Supabase UPSERT ON CONFLICT]
key_files:
  created:
    - supabase/migrations/007_syllabi_unique_constraint.sql
    - celery_worker/ai/syllabus.py
    - celery_worker/tests/ai/test_syllabus.py
    - src/app/api/upload/syllabus/route.ts
  modified:
    - celery_worker/tasks.py
    - celery_worker/requirements.txt
decisions:
  - "check_existing_syllabus uses .not_.is_('parsed_json', 'null') query to implement never-re-parse guard — skips Claude call if row already has parsed data"
  - "parse_syllabus_pdf strips markdown code fences before json.loads — Claude Opus occasionally wraps JSON in ```json fences despite instructions"
  - "parse_syllabus_task lazy-imports ai.syllabus at call time — consistent with all other tasks.py imports, avoids circular dependency at module load"
  - "POST /api/upload/syllabus accepts user_id from FormData (Phase 7 bypass) — replaced with Supabase session in Phase 8 when auth UI is built"
  - "PDF bytes are never persisted — only base64 string passes through transient Redis queue, fulfilling the privacy requirement from CONTEXT.md"
metrics:
  duration_minutes: 3
  completed_date: "2026-03-21"
  tasks_completed: 2
  files_changed: 6
---

# Phase 7 Plan 01: Syllabus PDF Upload, Claude Opus Parsing, and Idempotent Storage Summary

**One-liner:** Syllabus PDF upload via Next.js route, Claude Opus document block parsing, and idempotent Supabase upsert on (user_id, course_name) with never-re-parse guard.

## What Was Built

Users can now upload course syllabus PDFs to Aria. The system:

1. Accepts multipart PDF uploads via POST /api/upload/syllabus (Next.js API route)
2. Validates file size (4MB max) and required fields
3. Enqueues a `parse_syllabus_task` Celery task via Redis LPUSH (returns 202 immediately — no synchronous Claude call)
4. The Celery task checks for an existing parsed result before calling Claude (never re-parses the same course)
5. Sends the PDF to Claude Opus as a base64 document block, extracts structured JSON (course_name, exams, assignments, total_tracked_weight_pct)
6. Upserts the result into the syllabi table via ON CONFLICT(user_id, course_name)
7. Sends a confirmation or error SMS to the user

## Commits

| Hash | Description |
|------|-------------|
| af4b3d4 | test(07-01): add failing tests for syllabus parsing module (TDD RED) |
| 24cfc63 | feat(07-01): syllabus parsing module + migration 007 + pdfplumber |
| b3e16aa | feat(07-01): parse_syllabus_task + POST /api/upload/syllabus |

## Tasks Completed

| # | Name | Status | Key Output |
|---|------|--------|------------|
| 1 | Migration 007 + syllabus parsing module + unit tests | Done | migration, syllabus.py, 9 unit tests |
| 2 | Celery parse_syllabus_task + Next.js upload route | Done | tasks.py task, route.ts |

## Test Results

- 9 new unit tests in `tests/ai/test_syllabus.py` — all pass
- Full suite: 229 tests passing, 0 regressions

## Decisions Made

- **Never-re-parse guard via check_existing_syllabus**: Queries syllabi table for existing non-null parsed_json before calling Claude. Returns cached result and sends "already have your syllabus" SMS. Keeps Claude costs zero on duplicate uploads.
- **Markdown fence stripping**: Claude Opus occasionally returns `\`\`\`json\n{...}\n\`\`\`` despite the prompt saying "no code fences." The strip logic handles this defensively.
- **Lazy imports in parse_syllabus_task**: All ai.syllabus imports are inside the task body, consistent with the rest of tasks.py. Avoids module-load circular import issues.
- **user_id from FormData (Phase 7 bypass)**: The upload route accepts user_id as a FormData field. This is a temporary bypass for Phase 7 testing; Phase 8 replaces it with Supabase session cookies.
- **PDF bytes not persisted**: Raw PDF bytes converted to base64 in Next.js memory only; base64 string queued in Redis transiently and decoded in the Celery worker. No PDF stored in Supabase.

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

All files verified on disk. All commits verified in git log.

| Check | Result |
|-------|--------|
| supabase/migrations/007_syllabi_unique_constraint.sql | FOUND |
| celery_worker/ai/syllabus.py | FOUND |
| celery_worker/tests/ai/test_syllabus.py | FOUND |
| src/app/api/upload/syllabus/route.ts | FOUND |
| Commit af4b3d4 (TDD RED tests) | FOUND |
| Commit 24cfc63 (syllabus.py + migration) | FOUND |
| Commit b3e16aa (tasks.py + route.ts) | FOUND |
