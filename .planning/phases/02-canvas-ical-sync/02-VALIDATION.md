---
phase: 2
slug: canvas-ical-sync
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-18
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest (not yet installed — Wave 0 installs) |
| **Config file** | `celery_worker/pytest.ini` — Wave 0 |
| **Quick run command** | `cd celery_worker && python -m pytest tests/ -x -q` |
| **Full suite command** | `cd celery_worker && python -m pytest tests/ -v` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd celery_worker && python -m pytest tests/canvas/ -x -q`
- **After every plan wave:** Run `cd celery_worker && python -m pytest tests/ -v`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** ~10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 2-01-01 | 01 | 0 | CANV-01 | unit | `python -m pytest tests/canvas/test_parse.py -x` | ❌ W0 | ⬜ pending |
| 2-01-02 | 01 | 0 | CANV-01 | unit | `python -m pytest tests/canvas/test_parse.py::test_allday_date_to_utc -x` | ❌ W0 | ⬜ pending |
| 2-01-03 | 01 | 0 | CANV-01 | unit | `python -m pytest tests/canvas/test_parse.py::test_tz_aware_datetime_to_utc -x` | ❌ W0 | ⬜ pending |
| 2-01-04 | 01 | 0 | CANV-04 | unit | `python -m pytest tests/canvas/test_diff.py -x` | ❌ W0 | ⬜ pending |
| 2-01-05 | 01 | 0 | CANV-05 | unit | `python -m pytest tests/canvas/test_fetch.py::test_429_raises_http_error -x` | ❌ W0 | ⬜ pending |
| 2-02-01 | 02 | 0 | CANV-02 | integration | `python -m pytest tests/canvas/test_db.py::test_upsert_writes_synced_at -x` | ❌ W0 | ⬜ pending |
| 2-03-01 | 03 | 0 | CANV-03 | unit | `python -m pytest tests/test_celery_app.py::test_beat_schedule_60min -x` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `celery_worker/tests/__init__.py` — test package init
- [ ] `celery_worker/tests/canvas/__init__.py` — canvas test sub-package init
- [ ] `celery_worker/tests/canvas/test_parse.py` — covers CANV-01 (VEVENT parsing, DATE vs DATETIME, UTC conversion)
- [ ] `celery_worker/tests/canvas/test_diff.py` — covers CANV-04 (added/changed/removed detection, title-only no-op)
- [ ] `celery_worker/tests/canvas/test_fetch.py` — covers CANV-05 (429 raises HTTPError)
- [ ] `celery_worker/tests/canvas/test_db.py` — covers CANV-02 (upsert writes, soft-delete)
- [ ] `celery_worker/tests/test_celery_app.py` — covers CANV-03 (beat_schedule entry)
- [ ] `celery_worker/pytest.ini` — pytest configuration
- [ ] `celery_worker/requirements-dev.txt` — add `pytest` and `pytest-mock`

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Sync job runs every 60 min in production | CANV-03 | Requires real Celery Beat running against live Redis | Insert integration row, start celery_beat container, wait 60 min, confirm `synced_at` advances in Supabase dashboard |
| Canvas iCal URL produces valid feed | CANV-01 | Requires real Canvas student account | Manually GET the iCal URL in browser, confirm `.ics` content is returned with VEVENT records |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
