---
phase: 3
slug: twilio-sms-tcpa-compliance
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-19
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest 7.x (Python, celery_worker/) |
| **Config file** | `celery_worker/pytest.ini` or `pyproject.toml` (Wave 0 installs if absent) |
| **Quick run command** | `cd celery_worker && pytest tests/test_sms.py -x -q` |
| **Full suite command** | `cd celery_worker && pytest tests/ -q` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd celery_worker && pytest tests/test_sms.py -x -q`
- **After every plan wave:** Run `cd celery_worker && pytest tests/ -q`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 3-01-01 | 01 | 0 | SMS-01 | unit | `pytest tests/test_sms.py::test_send_sms_safe -x -q` | ❌ W0 | ⬜ pending |
| 3-01-02 | 01 | 0 | SMS-01 | unit | `pytest tests/test_sms.py::test_quiet_hours -x -q` | ❌ W0 | ⬜ pending |
| 3-01-03 | 01 | 0 | SMS-03 | unit | `pytest tests/test_sms.py::test_opt_out_guard -x -q` | ❌ W0 | ⬜ pending |
| 3-01-04 | 01 | 0 | SMS-04 | unit | `pytest tests/test_sms.py::test_daily_cap -x -q` | ❌ W0 | ⬜ pending |
| 3-02-01 | 02 | 1 | SMS-05 | unit | `pytest tests/test_webhook.py::test_signature_valid -x -q` | ❌ W0 | ⬜ pending |
| 3-02-02 | 02 | 1 | SMS-05 | unit | `pytest tests/test_webhook.py::test_signature_invalid -x -q` | ❌ W0 | ⬜ pending |
| 3-02-03 | 02 | 1 | SMS-06 | unit | `pytest tests/test_webhook.py::test_message_logged -x -q` | ❌ W0 | ⬜ pending |
| 3-03-01 | 03 | 1 | SMS-07 | unit | `pytest tests/test_commands.py::test_stop_command -x -q` | ❌ W0 | ⬜ pending |
| 3-03-02 | 03 | 1 | SMS-07 | unit | `pytest tests/test_commands.py::test_start_command -x -q` | ❌ W0 | ⬜ pending |
| 3-03-03 | 03 | 1 | SMS-08 | unit | `pytest tests/test_commands.py::test_pause_command -x -q` | ❌ W0 | ⬜ pending |
| 3-03-04 | 03 | 1 | SMS-09 | unit | `pytest tests/test_commands.py::test_help_command -x -q` | ❌ W0 | ⬜ pending |
| 3-04-01 | 04 | 2 | SMS-05 | integration | `pytest tests/test_integration.py::test_webhook_e2e -x -q` | ❌ W0 | ⬜ pending |
| 3-04-02 | 04 | 2 | SYNC-02 | integration | `pytest tests/test_integration.py::test_canvas_sync_schedule -x -q` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `celery_worker/tests/test_sms.py` — stubs for SMS-01, SMS-03, SMS-04
- [ ] `celery_worker/tests/test_webhook.py` — stubs for SMS-05, SMS-06
- [ ] `celery_worker/tests/test_commands.py` — stubs for SMS-07, SMS-08, SMS-09
- [ ] `celery_worker/tests/test_integration.py` — stubs for SMS-05 e2e, SYNC-02
- [ ] `celery_worker/tests/conftest.py` — shared fixtures (mock Twilio client, mock Supabase)
- [ ] pytest install in `celery_worker/requirements.txt` if absent

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Outbound SMS received on test phone within 30s | SMS-01 | Requires live Twilio number and physical device | Send test SMS via `send_sms_safe()` with test credentials; verify receipt on phone |
| Carrier-level STOP propagation | SMS-07 | Carrier processing is external | Text STOP to Twilio number; verify DB opt-out set; wait 24h verify carrier suppression |
| STOP confirmation bypasses opt-out guard | SMS-07 | Requires live Twilio send + opt-out state | Set `sms_opted_out=true`, trigger STOP confirmation; verify single SMS delivered |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
