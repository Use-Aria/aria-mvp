---
phase: 1
slug: infrastructure-foundation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-18
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest 7.x (Python/Celery tasks) + Jest/Vitest (Next.js API routes) |
| **Config file** | `pytest.ini` / `jest.config.ts` — Wave 0 installs |
| **Quick run command** | `pytest tests/ -x -q` / `npm test -- --testPathPattern=api` |
| **Full suite command** | `pytest tests/ && npm test` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run quick command for the affected layer (pytest for Python, npm test for Next.js)
- **After every plan wave:** Run full suite
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| schema setup | 01 | 1 | AUTH-01 | integration | `npx supabase db push && npm run test:db` | ❌ W0 | ⬜ pending |
| RLS policies | 01 | 1 | AUTH-01 | integration | `npm run test:rls` | ❌ W0 | ⬜ pending |
| Supabase Auth session | 01 | 2 | AUTH-04 | e2e | `npm test -- --testPathPattern=auth` | ❌ W0 | ⬜ pending |
| health endpoint | 01 | 2 | AUTH-04 | unit | `npm test -- --testPathPattern=health` | ❌ W0 | ⬜ pending |
| Celery ping task | 02 | 1 | SYNC-01 | integration | `pytest tests/test_celery.py -x` | ❌ W0 | ⬜ pending |
| Docker Compose | 02 | 1 | SYNC-01 | smoke | `docker compose up -d && docker compose ps` | ❌ W0 | ⬜ pending |
| SMS webhook stub | 03 | 1 | AUTH-01 | unit | `npm test -- --testPathPattern=sms` | ❌ W0 | ⬜ pending |
| env vars documented | 03 | 1 | AUTH-04 | manual | See Manual-Only below | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/test_celery.py` — ping task stub for SYNC-01
- [ ] `tests/conftest.py` — shared pytest fixtures (Redis URL, Supabase client)
- [ ] `src/app/api/__tests__/health.test.ts` — health endpoint test
- [ ] `src/app/api/__tests__/sms-webhook.test.ts` — stub webhook 200 response test
- [ ] `tests/test_db.py` — test record write to each core table
- [ ] `tests/test_rls.py` — RLS enforcement test (anon user cannot read another user's row)
- [ ] `pytest` install in `requirements.txt` if not present
- [ ] `vitest` or `jest` in `package.json` devDependencies

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Twilio inbound SMS received in Railway env | AUTH-01 | Requires live Twilio number + deployed Railway service | Text the provisioned number from a real phone; confirm webhook logs appear in Railway service logs |
| Env vars non-empty in Vercel + Railway | AUTH-04 | Requires deployed environments; no CI secret access | Hit `/api/health` on deployed Vercel URL; confirm 200 with all keys listed |
| A2P 10DLC registration initiated | AUTH-01 | External Twilio console action | Log into Twilio console, navigate to Messaging > Regulatory Compliance, start 10DLC registration |
| Celery worker accepts task on Railway | SYNC-01 | Requires deployed Railway worker service | Trigger `tasks.ping.delay()` from Railway shell; confirm task appears in Redis and worker logs show completion |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
