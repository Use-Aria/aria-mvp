---
phase: 9
slug: todoist-integration
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-19
---

# Phase 9 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest (existing, `celery_worker/pytest.ini`) |
| **Config file** | `celery_worker/pytest.ini` — `testpaths = tests`, `python_files = test_*.py` |
| **Quick run command** | `cd celery_worker && python -m pytest tests/todoist/ tests/ai/ -x -q` |
| **Full suite command** | `cd celery_worker && python -m pytest tests/ -q` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd celery_worker && python -m pytest tests/todoist/ tests/ai/ -x -q`
- **After every plan wave:** Run `cd celery_worker && python -m pytest tests/ -q`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** ~15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 9-01-01 | 01 | 1 | TASK-01 | unit (mock requests) | `pytest tests/todoist/test_fetch.py -x` | ❌ W0 | ⬜ pending |
| 9-01-02 | 01 | 1 | TASK-01 | unit (mock requests 403) | `pytest tests/todoist/test_fetch.py::test_403_marks_revoked -x` | ❌ W0 | ⬜ pending |
| 9-01-03 | 01 | 1 | TASK-02 | unit | `pytest tests/todoist/test_parse.py -x` | ❌ W0 | ⬜ pending |
| 9-01-04 | 01 | 1 | TASK-01 | integration (mocked Supabase) | `pytest tests/todoist/test_db.py -x` | ❌ W0 | ⬜ pending |
| 9-01-05 | 01 | 2 | TASK-02 | unit (mock ingest) | `pytest tests/todoist/test_sync.py -x` | ❌ W0 | ⬜ pending |
| 9-01-06 | 01 | 2 | TASK-01 | integration (mocked Supabase) | `pytest tests/todoist/test_db.py -x` | ❌ W0 | ⬜ pending |
| 9-02-01 | 02 | 3 | TASK-02 | unit (mock Supabase) | `pytest tests/ai/test_briefing.py::test_overload_detection -x` | ❌ W0 | ⬜ pending |
| 9-02-02 | 02 | 3 | TASK-02 | unit (mock _count_items_due_today) | `pytest tests/ai/test_briefing.py::test_overload_prepend -x` | ❌ W0 | ⬜ pending |
| 9-02-03 | 02 | 3 | TASK-01 | unit (mock Claude response) | `pytest tests/ai/test_replies.py::test_todoist_intent -x` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `celery_worker/tests/todoist/__init__.py` — new test package
- [ ] `celery_worker/tests/todoist/test_fetch.py` — covers TASK-01 (HTTP calls, 403 handling, due-date filter)
- [ ] `celery_worker/tests/todoist/test_parse.py` — covers TASK-02 (due.datetime vs. due.date normalization, priority inversion)
- [ ] `celery_worker/tests/todoist/test_db.py` — covers TASK-01 (get_all_todoist_integrations, mark_synced, mark_integration_revoked)
- [ ] `celery_worker/tests/todoist/test_sync.py` — covers TASK-02 (ingest_canonical_event called correctly from sync)
- [ ] `celery_worker/tests/ai/test_briefing.py` additions — test_overload_detection, test_overload_prepend
- [ ] `celery_worker/tests/ai/test_replies.py` additions — test_todoist_intent, test_todoist_create_without_due

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| iOS OAuth flow end-to-end (WebBrowser + deep link redirect) | TASK-01 | Requires real Todoist account + iOS simulator | 1. Tap Connect Todoist in Preferences; 2. Complete OAuth in browser; 3. Verify app returns to Preferences with Todoist row showing Connected |
| SMS CRUD round-trip (create/complete/update task) | TASK-01 | Requires live Twilio + Todoist sandbox | Send "add task buy groceries" via SMS; verify task appears in Todoist with no due date |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
