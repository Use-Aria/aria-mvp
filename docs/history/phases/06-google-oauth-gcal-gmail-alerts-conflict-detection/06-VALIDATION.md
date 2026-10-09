---
phase: 6
slug: google-oauth-gcal-gmail-alerts-conflict-detection
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-03-19
---

# Phase 6 -- Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest (already configured) |
| **Config file** | `celery_worker/pytest.ini` |
| **Quick run command** | `cd celery_worker && python -m pytest tests/ -x -q` |
| **Full suite command** | `cd celery_worker && python -m pytest tests/ -v` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd celery_worker && python -m pytest tests/ -x -q`
- **After every plan wave:** Run `cd celery_worker && python -m pytest tests/ -v`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 6-01-01 | 01 | 1 | GCAL-01, GMAI-03 | unit | `cd celery_worker && python -m pytest tests/google_auth/ -x -q` | W0 | pending |
| 6-01-02 | 01 | 1 | GCAL-01 | smoke | `npx tsc --noEmit src/app/api/auth/google/route.ts src/app/api/auth/google/callback/route.ts` | N/A | pending |
| 6-02-01 | 02 | 1 | SMS-10, SMS-11 | unit | `cd celery_worker && python -m pytest tests/sms/test_batch.py -x -q` | W0 | pending |
| 6-02-02 | 02 | 1 | SMS-10 | unit | `cd celery_worker && python -m pytest tests/ -x -q` | partial | pending |
| 6-03-01 | 03 | 2 | GCAL-01, GCAL-02 | unit | `cd celery_worker && python -m pytest tests/gcal/test_fetch.py tests/gcal/test_db.py -x -q` | W0 | pending |
| 6-03-02 | 03 | 2 | GCAL-03, GCAL-04, SYNC-03, SYNC-04 | unit | `cd celery_worker && python -m pytest tests/gcal/test_watch.py -x -q` | W0 | pending |
| 6-04-01 | 04 | 2 | GMAI-01, GMAI-02, GMAI-05 | unit | `cd celery_worker && python -m pytest tests/gmail/test_classify.py -x -q` | W0 | pending |
| 6-04-02 | 04 | 2 | GMAI-03, GMAI-04, ALRT-02 | unit | `cd celery_worker && python -m pytest tests/gmail/test_watch.py -x -q` | W0 | pending |
| 6-05-01 | 05 | 3 | INTEL-03 | unit | `cd celery_worker && python -m pytest tests/gcal/test_conflicts.py tests/gcal/test_slots.py -x -q` | W0 | pending |
| 6-05-02 | 05 | 3 | GCAL-05, AI-08 | unit | `cd celery_worker && python -m pytest tests/gcal/test_writeback.py tests/ai/test_briefing_gcal.py -x -q` | W0 | pending |

*Status: pending / green / red / flaky*

---

## Wave 0 Requirements

- [ ] `celery_worker/tests/google_auth/__init__.py` + `test_encryption.py`, `test_tokens.py`
- [ ] `celery_worker/tests/sms/__init__.py` + `test_batch.py` -- covers SMS-10, SMS-11
- [ ] `celery_worker/tests/gcal/__init__.py` + `test_fetch.py`, `test_db.py`, `test_watch.py`, `test_conflicts.py`, `test_writeback.py`, `test_slots.py`
- [ ] `celery_worker/tests/gmail/__init__.py` + `test_classify.py`, `test_watch.py`
- [ ] `celery_worker/tests/ai/test_briefing_gcal.py` -- covers AI-08 Monday enrichment
- [ ] `celery_worker/conftest.py` -- add Redis mock fixture (`fakeredis`)
- [ ] Install test deps: `pip install fakeredis pytest-mock`

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Google OAuth consent flow | GCAL-01, GMAI-01 | Requires real browser redirect + Google account | Trigger /api/auth/google, complete consent, verify tokens in Supabase integrations table (encrypted) |
| SMS alert fires within 15 min | ALRT-01 | Requires real Twilio + real Canvas diff | Trigger canvas-sync diff, check Twilio logs for message within 15 min |
| GCal push channel renewal | SYNC-03 | Requires real Google webhook endpoint | Verify renewal job fires 24h before expiry in Celery logs |
| Study preference SMS | GCAL-05 | Requires real Twilio + user reply | After OAuth, verify SMS asking "when do you prefer to study"; reply "evening" and check preferences_json |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 30s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
