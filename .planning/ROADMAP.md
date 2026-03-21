# Roadmap: Aria

## Milestones

- ✅ **v1.0 MVP** — Phases 1–9 (shipped 2026-03-21)
- 🚧 **v1.1 App Store Launch** — Phases 10–12 (in progress)

## Phases

<details>
<summary>✅ v1.0 MVP (Phases 1–9) — SHIPPED 2026-03-21</summary>

- [x] Phase 1: Infrastructure Foundation (2/2 plans) — completed 2026-03-18
- [x] Phase 2: Canvas iCal Sync (2/2 plans) — completed 2026-03-19
- [x] Phase 3: Twilio SMS + TCPA Compliance (3/3 plans) — completed 2026-03-19
- [x] Phase 4: Claude AI + Daily Briefing (2/2 plans) — completed 2026-03-19
- [x] Phase 5: Priority Engine + Canonical Timeline DB (2/2 plans) — completed 2026-03-19
- [x] Phase 6: Google OAuth + GCal + Gmail + Alerts + Conflict Detection (5/5 plans) — completed 2026-03-20
- [x] Phase 7: Syllabus Parsing + Study Gap Detection (2/2 plans) — completed 2026-03-21
- [x] Phase 8: iOS App + Onboarding (5/5 plans) — completed 2026-03-20
- [x] Phase 9: Todoist Integration (3/3 plans) — completed 2026-03-20

</details>

### 🚧 v1.1 App Store Launch (Phases 10–12)

- [x] **Phase 10: iOS Build Configuration** — `eas.json` + `app.json` privacy strings + icon fix (partially complete — needs Apple credentials filled in and build verified)
- [ ] **Phase 11: Backend Deployment** — Deploy Next.js to Vercel, Celery to Railway, configure all production env vars
- [ ] **Phase 12: Legal, Listing & Submission** — Privacy Policy, Terms of Service, App Store Connect listing, screenshots, submit for review

### Phase Details

#### Phase 10: iOS Build Configuration
**Goal**: The iOS app can be built and distributed via EAS — `eas build` succeeds, the app is on TestFlight, and all App Store-required permission strings are declared.
**Depends on**: Phase 8 (iOS app complete)
**Requirements**: IOSBLD-01, IOSBLD-02, IOSBLD-03, IOSBLD-04, IOSBLD-05, IOSBLD-06
**Success Criteria**:
  1. `eas build --platform ios --profile preview` completes without errors
  2. Build is visible in App Store Connect → TestFlight
  3. App installs and runs on a physical iPhone via TestFlight
  4. Full onboarding flow completes on device (Canvas URL → welcome briefing SMS received)
  5. Voice input requests microphone permission with correct usage description text
**Plans**: 1 plan
Plans:
- [x] 10-01-PLAN.md — eas.json + app.json fixes (COMPLETE — files written 2026-03-21)

#### Phase 11: Backend Deployment
**Goal**: The production backend is live — Next.js API on Vercel, Celery workers on Railway, all env vars configured, and core integrations verified working end-to-end.
**Depends on**: Phase 10 (iOS build working so E2E test is possible)
**Requirements**: BKND-01, BKND-02, BKND-03, BKND-04, BKND-05, BKND-06, BKND-07, BKND-08
**Success Criteria**:
  1. `GET /api/health` returns 200 on the production Vercel URL
  2. A Canvas iCal URL submitted via onboarding triggers a welcome briefing SMS within 60 seconds
  3. Celery Beat fires canvas-sync job every 60 minutes (confirmed in Railway logs)
  4. Google OAuth callback completes and stores encrypted token in Supabase
  5. Twilio inbound SMS webhook returns 200 and queues processing to Celery
**Plans**: 1 plan
Plans:
- [ ] 11-01-PLAN.md — Vercel deploy + Railway services + env var configuration

#### Phase 12: Legal, Listing & Submission
**Goal**: Aria is submitted to the App Store for review — Privacy Policy and Terms live, App Store Connect listing complete with screenshots, and the production build submitted.
**Depends on**: Phase 11 (backend live so screenshots show real data)
**Requirements**: LEGAL-01, LEGAL-02, LEGAL-03, LISTING-01, LISTING-02, LISTING-03, LISTING-04, LISTING-05
**Success Criteria**:
  1. Privacy Policy is live at a public URL and covers SMS consent, OAuth token storage, and 30-day data deletion
  2. App Store Connect listing has description, keywords, and screenshots for 6.7" and 6.1" iPhone
  3. App status in App Store Connect shows "Waiting for Review" or "In Review"
**Plans**: 1 plan
Plans:
- [ ] 12-01-PLAN.md — Privacy Policy + ToS + App Store listing copy + submission

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Infrastructure Foundation | v1.0 | 2/2 | Complete | 2026-03-18 |
| 2. Canvas iCal Sync | v1.0 | 2/2 | Complete | 2026-03-19 |
| 3. Twilio SMS + TCPA Compliance | v1.0 | 3/3 | Complete | 2026-03-19 |
| 4. Claude AI + Daily Briefing | v1.0 | 2/2 | Complete | 2026-03-19 |
| 5. Priority Engine + Canonical Timeline DB | v1.0 | 2/2 | Complete | 2026-03-19 |
| 6. Google OAuth + GCal + Gmail + Alerts | v1.0 | 5/5 | Complete | 2026-03-20 |
| 7. Syllabus Parsing + Study Gap Detection | v1.0 | 2/2 | Complete | 2026-03-21 |
| 8. iOS App + Onboarding | v1.0 | 5/5 | Complete | 2026-03-20 |
| 9. Todoist Integration | v1.0 | 3/3 | Complete | 2026-03-20 |
| 10. iOS Build Configuration | v1.1 | 0/1 | In Progress | — |
| 11. Backend Deployment | v1.1 | 0/1 | Not started | — |
| 12. Legal, Listing & Submission | v1.1 | 0/1 | Not started | — |

_Full v1.0 phase details archived in [.planning/milestones/v1.0-ROADMAP.md](.planning/milestones/v1.0-ROADMAP.md)_
