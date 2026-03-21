# Requirements: Aria

**Defined:** 2026-03-21
**Core Value:** Students don't have a productivity problem — they have a fragmentation problem. Aria is the first layer that sees everything simultaneously and acts on it proactively.
**Last updated:** 2026-03-21 — v1.1 App Store Launch

## v1.1 Requirements

### iOS Build Configuration

- [x] **IOSBLD-01**: `eas.json` exists with `preview` (internal distribution) and `production` build profiles
- [x] **IOSBLD-02**: `app.json` includes `NSMicrophoneUsageDescription` and `NSSpeechRecognitionUsageDescription` for App Store compliance
- [x] **IOSBLD-03**: `app.json` includes `appleTeamId` field and correct iOS icon path
- [ ] **IOSBLD-04**: `eas.json` `submit` section filled with real Apple ID, App Store Connect App ID, and Team ID
- [ ] **IOSBLD-05**: `eas build --platform ios --profile preview` succeeds without errors
- [ ] **IOSBLD-06**: Preview build uploaded to TestFlight and installable on physical iPhone

### Backend Deployment

- [x] **BKND-01**: `celery_worker/railway.toml` created with Dockerfile build config and worker start command
- [x] **BKND-02**: `Procfile` created for Railway process definitions (worker + beat)
- [x] **BKND-03**: `DEPLOYMENT.md` documents all environment variables for Vercel and Railway
- [ ] **BKND-04**: Next.js API deployed to Vercel and `/api/health` returns 200
- [ ] **BKND-05**: Celery worker deployed to Railway and processing tasks (confirmed via Railway logs)
- [ ] **BKND-06**: Celery Beat deployed to Railway and firing scheduled jobs (canvas sync, briefings)
- [ ] **BKND-07**: Twilio webhook URL updated to production Vercel domain
- [ ] **BKND-08**: Google OAuth redirect URI updated to production Vercel domain

### Legal & Compliance

- [ ] **LEGAL-01**: Privacy Policy published at a public URL (covers SMS/TCPA, OAuth token storage, 30-day deletion)
- [ ] **LEGAL-02**: Terms of Service published at a public URL
- [ ] **LEGAL-03**: Privacy policy URL added to `app.json` and App Store Connect listing

### App Store Listing

- [ ] **LISTING-01**: App record created in App Store Connect with bundle ID `com.aria.mobile`
- [ ] **LISTING-02**: App description, subtitle, and keywords written and entered in App Store Connect
- [ ] **LISTING-03**: Screenshots captured for 6.7" and 6.1" iPhone and uploaded to App Store Connect
- [ ] **LISTING-04**: Age rating questionnaire completed (expected: 4+)
- [ ] **LISTING-05**: App submitted for Apple review

## v2 Requirements

- End-to-end TestFlight beta with 50 Yale users (structured feedback)
- Android app (React Native, same codebase)
- iMessage via Sendblue
- Spotify focus session automation
- Web dashboard

## Out of Scope (v1.1)

| Feature | Reason |
|---------|--------|
| Android Play Store submission | iOS-first; Android is v2 |
| Sendblue iMessage | Twilio SMS sufficient for launch |
| Web dashboard | iOS app is primary interface |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| IOSBLD-01 | Phase 10 | Complete |
| IOSBLD-02 | Phase 10 | Complete |
| IOSBLD-03 | Phase 10 | Complete |
| IOSBLD-04 | Phase 10 | Pending |
| IOSBLD-05 | Phase 10 | Pending |
| IOSBLD-06 | Phase 10 | Pending |
| BKND-01 | Phase 11 | Complete |
| BKND-02 | Phase 11 | Complete |
| BKND-03 | Phase 11 | Complete |
| BKND-04 | Phase 11 | Pending |
| BKND-05 | Phase 11 | Pending |
| BKND-06 | Phase 11 | Pending |
| BKND-07 | Phase 11 | Pending |
| BKND-08 | Phase 11 | Pending |
| LEGAL-01 | Phase 12 | Pending |
| LEGAL-02 | Phase 12 | Pending |
| LEGAL-03 | Phase 12 | Pending |
| LISTING-01 | Phase 12 | Pending |
| LISTING-02 | Phase 12 | Pending |
| LISTING-03 | Phase 12 | Pending |
| LISTING-04 | Phase 12 | Pending |
| LISTING-05 | Phase 12 | Pending |

**Coverage:**
- v1.1 requirements: 21 total
- Mapped to phases: 21
- Unmapped: 0 ✓

---
*Requirements defined: 2026-03-21*
