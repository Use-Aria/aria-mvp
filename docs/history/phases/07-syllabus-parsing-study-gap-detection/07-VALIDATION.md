---
phase: 07
slug: syllabus-parsing-study-gap-detection
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-20
---

# Phase 07 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest 8.x |
| **Config file** | `celery_worker/pytest.ini` (or `pyproject.toml`) |
| **Quick run command** | `cd celery_worker && python -m pytest tests/ai/test_syllabus.py tests/ai/test_briefing_syllabus.py -q --tb=short` |
| **Full suite command** | `cd celery_worker && python -m pytest tests/ -q --tb=short` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd celery_worker && python -m pytest tests/ai/test_syllabus.py -q --tb=short`
- **After every plan wave:** Run `cd celery_worker && python -m pytest tests/ -q --tb=short`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** ~10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 07-01-01 | 01 | 1 | AI-01, AI-02, AI-03 | unit | `cd celery_worker && python -m pytest tests/ai/test_syllabus.py -q` | Yes (created in task) | ⬜ pending |
| 07-01-02 | 01 | 1 | AI-01, AI-02, AI-03 | unit + structural grep | `cd celery_worker && python -m pytest tests/ai/test_syllabus.py -q && grep -q "export async function POST" ../src/app/api/upload/syllabus/route.ts` | Yes (created in task) | ⬜ pending |
| 07-02-01 | 02 | 2 | AI-10, INTEL-01 | unit | `cd celery_worker && python -m pytest tests/ai/test_syllabus.py -q` | Yes (extended in task) | ⬜ pending |
| 07-02-02 | 02 | 2 | AI-10, INTEL-01 | unit | `cd celery_worker && python -m pytest tests/ai/test_briefing_syllabus.py -q` | Yes (created in task) | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Wave 0 test scaffolds are NOT needed — both plans use TDD (tests are written as the first step of each task, not in a separate Wave 0 phase). Test files created by plans:

- `celery_worker/tests/ai/test_syllabus.py` — created in Plan 07-01 Task 1, extended in Plan 07-02 Task 1
- `celery_worker/tests/ai/test_briefing_syllabus.py` — created in Plan 07-02 Task 2

*Existing infrastructure (pytest, fakeredis, unittest.mock) covers all phase requirements — no new framework installs.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| PDF upload via multipart HTTP POST returns 202 | AI-01 | Requires live Next.js dev server + file system | `curl -F "file=@test_syllabus.pdf" -F "user_id=<uuid>" http://localhost:3000/api/upload/syllabus` — expect 202 JSON |
| SMS confirmation received after parse completes | AI-02 | Requires Twilio + live Celery worker | Upload PDF, wait ~30s, verify SMS received on test phone |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
