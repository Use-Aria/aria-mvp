---
phase: 6
slug: google-oauth-gcal-gmail-alerts-conflict-detection
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-19
---

# Phase 6 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | jest 29.x |
| **Config file** | jest.config.js |
| **Quick run command** | `npm test -- --testPathPattern=tests/integrations` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npm test -- --testPathPattern=tests/integrations`
- **After every plan wave:** Run `npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 6-01-01 | 01 | 1 | GCAL-01 | unit | `npm test -- --testPathPattern=gcal` | ❌ W0 | ⬜ pending |
| 6-01-02 | 01 | 1 | GCAL-02 | unit | `npm test -- --testPathPattern=gcal` | ❌ W0 | ⬜ pending |
| 6-02-01 | 02 | 1 | GMAI-01 | unit | `npm test -- --testPathPattern=gmail` | ❌ W0 | ⬜ pending |
| 6-02-02 | 02 | 1 | GMAI-02 | unit | `npm test -- --testPathPattern=gmail` | ❌ W0 | ⬜ pending |
| 6-03-01 | 03 | 2 | ALRT-01 | unit | `npm test -- --testPathPattern=alerts` | ❌ W0 | ⬜ pending |
| 6-03-02 | 03 | 2 | ALRT-02 | unit | `npm test -- --testPathPattern=alerts` | ❌ W0 | ⬜ pending |
| 6-04-01 | 04 | 2 | GCAL-04 | unit | `npm test -- --testPathPattern=conflict` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/integrations/gcal.test.ts` — stubs for GCAL-01, GCAL-02, GCAL-03
- [ ] `tests/integrations/gmail.test.ts` — stubs for GMAI-01, GMAI-02, GMAI-03
- [ ] `tests/integrations/alerts.test.ts` — stubs for ALRT-01, ALRT-02, ALRT-03
- [ ] `tests/integrations/conflict.test.ts` — stubs for GCAL-04, GCAL-05
- [ ] `tests/integrations/channel-renewal.test.ts` — stubs for SYNC-03, SYNC-04

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Google OAuth consent flow | GCAL-01, GMAI-01 | Requires real browser redirect + Google account | Trigger /api/auth/google, complete consent, verify tokens in Supabase integrations table |
| SMS alert fires within 15 min | ALRT-01 | Requires real Twilio + real Canvas diff | Trigger canvas-sync diff, check Twilio logs for message within 15 min |
| GCal push channel renewal | SYNC-03 | Requires real Google webhook endpoint | Verify renewal job fires 24h before expiry in Celery logs |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
