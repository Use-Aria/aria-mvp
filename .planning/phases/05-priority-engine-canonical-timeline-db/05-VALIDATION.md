---
phase: 5
slug: priority-engine-canonical-timeline-db
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-19
---

# Phase 5 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest (version per celery_worker/requirements-dev.txt) |
| **Config file** | `celery_worker/pytest.ini` — `testpaths = tests` |
| **Quick run command** | `cd celery_worker && python -m pytest tests/priority/ -x -q` |
| **Full suite command** | `cd celery_worker && python -m pytest tests/ -q` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd celery_worker && python -m pytest tests/priority/ -x -q`
- **After every plan wave:** Run `cd celery_worker && python -m pytest tests/ -q`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 5-01-01 | 01 | 0 | PRIO-02 | unit | `pytest tests/priority/test_engine.py -x` | ❌ W0 | ⬜ pending |
| 5-01-02 | 01 | 0 | PRIO-03 | unit | `pytest tests/priority/test_router.py -x` | ❌ W0 | ⬜ pending |
| 5-01-03 | 01 | 0 | PRIO-01 | unit | `pytest tests/priority/test_ingest.py -x` | ❌ W0 | ⬜ pending |
| 5-01-04 | 01 | 0 | PRIO-03 | unit | `pytest tests/sms/test_send.py::test_send_sms_alert -x` | ❌ W0 | ⬜ pending |
| 5-01-05 | 01 | 1 | PRIO-02 | unit | `pytest tests/priority/test_engine.py -x` | ❌ W0 | ⬜ pending |
| 5-01-06 | 01 | 1 | PRIO-03 | unit | `pytest tests/priority/test_router.py -x` | ❌ W0 | ⬜ pending |
| 5-01-07 | 01 | 1 | PRIO-01 | unit | `pytest tests/priority/test_ingest.py -x` | ❌ W0 | ⬜ pending |
| 5-01-08 | 01 | 1 | PRIO-03 | unit | `pytest tests/sms/test_send.py -x` | ✅ | ⬜ pending |
| 5-02-01 | 02 | 2 | PRIO-01 | unit | `pytest tests/priority/test_ingest.py -x` | ❌ W0 | ⬜ pending |
| 5-02-02 | 02 | 2 | PRIO-01 | integration | `pytest tests/ -q` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `celery_worker/priority/__init__.py` — package marker
- [ ] `celery_worker/priority/engine.py` — stub for `score_event()` and `compute_urgency()`
- [ ] `celery_worker/priority/router.py` — stub for `route_event()`
- [ ] `celery_worker/priority/ingest.py` — stub for `ingest_canonical_event()`
- [ ] `celery_worker/tests/priority/__init__.py` — test package marker
- [ ] `celery_worker/tests/priority/test_engine.py` — covers PRIO-02 (score_event, compute_urgency, spot checks, NULL grade_weight, overdue clamping)
- [ ] `celery_worker/tests/priority/test_router.py` — covers PRIO-03 routing thresholds (≥80=immediate, 50–79=digest, <50=silent)
- [ ] `celery_worker/tests/priority/test_ingest.py` — covers PRIO-01 (canonical write, backfill idempotency)
- [ ] New test functions in `celery_worker/tests/sms/test_send.py`: `test_send_sms_alert`, `test_alert_bypasses_guards`

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Immediate alert SMS received within 60 seconds of ingesting score ≥ 80 event | PRIO-03 | Requires live Twilio + Railway worker | 1. Use test user. 2. Insert a canonical event with `priority_score=85, delivery_status='immediate'`. 3. Call `send_priority_alert.delay(user_id, event_id)`. 4. Verify SMS arrives within 60 seconds. |
| Backfill does not spam users during deploy | PRIO-01 | Requires live user data + Twilio | 1. Confirm `skip_routing=True` is set in backfill task. 2. Run backfill on test user. 3. Verify no SMS received despite any events scoring ≥ 80. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
