# Aria — Active Work State

> **This file is the traffic light for the repo.**
> Read it before touching any code. Update it when you start and when you finish.
> Both developers (Josh + Seb) run separate Claude Code sessions — this file prevents collisions.

---

## 🔒 Currently In Progress

*Nothing claimed yet. Run `/project:start` to claim a task.*

| Developer | Task | Branch | Claimed At |
|-----------|------|--------|------------|
| — | — | — | — |

---

## 🎯 Up Next (Priority Order)

### On-Demand Scheduling Enhancement (Phase 4 SMS)
- [ ] **SCH-01** — Apply 8 minor fixes to plan, then execute `docs/superpowers/plans/2026-03-21-on-demand-scheduling.md` → **Josh**
  - Fix list in `PROGRESS.md` "Immediate — Fix the plan before executing it"
  - Creates `celery_worker/sms/schedule.py`, modifies `celery_worker/ai/replies.py`

### v1.1 App Store Launch

- [ ] **PH10-02** — Fill Apple Developer credentials (`APPLE_ID`, `ASC_APP_ID`, team ID), run `eas build --platform ios --profile preview`, verify TestFlight install → **Josh**
- [ ] **PH11-01** — Plan + execute Phase 11: Deploy Next.js to Vercel, Celery workers to Railway, configure all production env vars → **Josh**
- [ ] **PH12-01** — Plan + execute Phase 12: Privacy Policy, Terms of Service, App Store Connect listing, screenshots, submit for review → **Josh + Seb**

---

## ✅ Completed

### v1.0 MVP — Shipped 2026-03-21

| Phase | What shipped | Date |
|-------|-------------|------|
| Phase 1 — Infrastructure | Next.js 15.2, Supabase schema+Auth+RLS, Celery+Redis+Docker | 2026-03-18 |
| Phase 2 — Canvas Sync | iCal fetch, diff engine, Celery Beat 60-min sync | 2026-03-18 |
| Phase 3 — Twilio SMS + TCPA | send/receive SMS, TCPA guards, keyword dispatch, Twilio webhook | 2026-03-19 |
| Phase 4 — Claude AI + Daily Briefing | Claude Sonnet briefings, conversational replies, exam countdowns | 2026-03-19 |
| Phase 5 — Priority Engine | canonical_events table, priority scoring (0–100), send_priority_alert | 2026-03-19 |
| Phase 6 — Google OAuth + GCal + Gmail | Fernet-encrypted tokens, GCal sync + push, Gmail pipeline (Haiku classify), conflict detection, study blocks, SMS batch queue | 2026-03-20 |
| Phase 7 — Syllabus + Study Gap | Claude Opus PDF parsing, never-re-parse guard, gap analysis Beat (T-5), briefing enrichment | 2026-03-21 |
| Phase 8 — iOS App + Onboarding | Expo React Native app, 4-zone dashboard, in-app chat, Google OAuth, onboarding flow | 2026-03-20 |
| Phase 9 — Todoist Integration | Todoist OAuth, task sync, SMS CRUD, briefing integration | 2026-03-20 |
| Phase 10-01 — iOS Build Config | `eas.json` + `app.json` fixes written (Apple credentials still needed) | 2026-03-21 |

---

## 📋 Handoff Notes

### 2026-03-21 — Josh
**Done:** v1.0 MVP shipped (all 9 phases). Phase 10 build config files written.
**On-demand scheduling designed:** spec + plan in `docs/superpowers/`. Plan has 8 known minor fixes — see `PROGRESS.md` for the full list. Do NOT execute until fixes are applied.
**Gotchas:**
- Apply all 8 plan fixes before `/gsd:execute-phase` or subagent execution
- `mobile/` directory is the React Native app (not `src/`)
- Apple credentials (APPLE_ID, ASC_APP_ID, team ID) must be in `.env.local` before `eas build`
- Google OAuth app verification for Gmail scope may take 1–6 weeks — start if not already done
**Next up:** SCH-01 (scheduling) → PH10-02 (Apple creds + build) → PH11-01 (deploy) → PH12-01 (App Store)

---

## ⚠️ Collision Rules

1. **Never start a task that's already claimed** in the "Currently In Progress" table
2. **Always `git pull origin main` before claiming** — another dev may have finished and pushed
3. **One task at a time per developer** — finish and push before claiming a second
4. **Seb: do not touch `src/lib/`, `src/app/api/`, `celery_worker/`, or `supabase/`** — Josh owns these
5. **Josh: do not touch `mobile/src/app/(pages)/` or `mobile/src/components/`** — Seb owns these
6. **Both: never modify `src/types/index.ts` without telling the other person first**
