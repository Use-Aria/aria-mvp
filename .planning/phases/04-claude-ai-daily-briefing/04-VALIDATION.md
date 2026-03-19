---
phase: 4
slug: claude-ai-daily-briefing
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-19
---

# Phase 4 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest 7.x |
| **Config file** | `celery_worker/pytest.ini` |
| **Quick run command** | `cd celery_worker && python -m pytest tests/ -x -q` |
| **Full suite command** | `cd celery_worker && python -m pytest tests/ -v` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd celery_worker && python -m pytest tests/ -x -q`
- **After every plan wave:** Run `cd celery_worker && python -m pytest tests/ -v`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 4-01-01 | 01 | 0 | AI-04 | unit | `pytest tests/ai/test_briefing.py -x -q` | ❌ W0 | ⬜ pending |
| 4-01-02 | 01 | 0 | CONV-01 | unit | `pytest tests/ai/test_replies.py -x -q` | ❌ W0 | ⬜ pending |
| 4-01-03 | 01 | 1 | AI-04, AI-07, AI-08, AI-09 | unit | `pytest tests/ai/test_briefing.py -x -q` | ❌ W0 | ⬜ pending |
| 4-01-04 | 01 | 1 | AI-06, AI-11 | unit | `pytest tests/ai/test_briefing.py::test_exam_countdown -x -q` | ❌ W0 | ⬜ pending |
| 4-01-05 | 01 | 1 | SMS-03, CONV-01 | unit | `pytest tests/ai/test_replies.py -x -q` | ❌ W0 | ⬜ pending |
| 4-02-01 | 02 | 1 | AI-05 | unit | `pytest tests/ai/test_briefing.py::test_welcome_briefing -x -q` | ❌ W0 | ⬜ pending |
| 4-02-02 | 02 | 1 | SYNC-05 | unit | `pytest tests/canvas/test_db.py -x -q` | ✅ | ⬜ pending |
| 4-02-03 | 02 | 2 | AUTH-07, SYNC-06 | unit | `pytest tests/test_tasks_briefing.py -x -q` | ❌ W0 | ⬜ pending |
| 4-03-01 | 03 | 2 | AI-04 (task mgmt) | unit | `pytest tests/ai/test_task_management.py -x -q` | ❌ W0 | ⬜ pending |
| 4-03-02 | 03 | 2 | schema | manual | migration applied + columns exist in DB | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `celery_worker/tests/ai/__init__.py` — ai test sub-package init
- [ ] `celery_worker/tests/ai/test_briefing.py` — stubs for AI-04, AI-05, AI-06, AI-07, AI-08, AI-09, AI-11
- [ ] `celery_worker/tests/ai/test_replies.py` — stubs for SMS-03, CONV-01
- [ ] `celery_worker/tests/ai/test_task_management.py` — stubs for task mark-done/snooze/priority
- [ ] `celery_worker/tests/test_tasks_briefing.py` — stubs for SYNC-06, AUTH-07 (beat schedule + timezone guard)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Actual SMS arrives at 8am user local time | AUTH-07, SYNC-06 | Requires real Twilio + real time | Set test user timezone, wait for beat job, check Twilio logs |
| Claude briefing tone is smart-friend prose | AI-04 | Subjective prose quality | Review 3 generated briefings manually, confirm no bullets, no robotic language |
| Welcome briefing arrives within 60s of URL save | AI-05, SYNC-05 | Requires live Celery + Twilio | Trigger canvas URL save, start timer, confirm SMS arrives |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
