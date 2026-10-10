# Aria — Production Readiness Checklist

> This file tracks everything that is deferred during local development but **required before public launch**.
> Update this file whenever a new production dependency is discovered during implementation.
> Owner: Daniel Lee (CTO)

---

## ⚠️ V2 production dependencies (added 2026-10-10)

> Sections 1–8 below describe **V1** (Twilio, Expo, Celery/Railway) and get rewritten for V2 in build Wave 5. Until then, this section is the V2 source of truth. Full runbooks: `docs/plans/2026-10-10-v2-master-plan.md` §7.

| Dependency | Status | Notes |
|---|---|---|
| Vercel project (Hobby) + `APP_BASE_URL` | ❌ | Needed for magic links, OAuth redirects, Pub/Sub push, the jobs tick |
| Supabase Vault secrets for the jobs tick (dispatch URL + `JOBS_DISPATCH_SECRET`) | ❌ | Run `scripts/ops/configure-jobs-tick.sql` after the first deploy; until then the 15s pg_cron tick is a no-op |
| `CRON_SECRET` (Vercel Cron bearer) | ❌ | Daily `/api/cron/daily` keepalive + `/api/jobs/dispatch` backstop (`vercel.json`) |
| Sendblue sandbox (API key/secret, signing secret, number) | ❌ | Verify the [verify] list in master plan §7.3 (signing header, tapback shape, email handles, media URLs) |
| Upstash Redis (REST URL + token) | ❌ | Run lease + rate limits; production fails closed without it |
| Google Cloud project: OAuth client ("In production", unverified) + Pub/Sub topic/subscription | ❌ | Check `*.vercel.app` is accepted as an authorized domain (else buy a domain, D4); test one Yale account first |
| Python parser on Google Cloud Run (needs a billing account) | ❌ | Separate Anthropic key for the parser (D6); `PARSER_SERVICE_URL` + `PARSER_SHARED_SECRET` |
| `SYLLABUS_MEDIA_ALLOWED_HOSTS` | ❌ | Sendblue media CDN host, known only after the sandbox. **Required:** empty fails closed in production, so no chat PDF can be read (`*.suffix` allowed) |
| Separate dev Supabase project (`aria-dev`) | 🔧 | D11: dev and prod share one project today; the prod tick could claim local-dev jobs once Vault secrets are set |
| Back up `APP_ENCRYPTION_KEY` to the password manager | ❌ | Losing it makes stored OAuth tokens and iCal URLs unrecoverable |

---

## Status Legend

| Symbol | Meaning |
|--------|---------|
| ✅ | Done |
| ⏳ | In progress / pending external review |
| ❌ | Not started — blocks launch |
| 🔧 | Not started — needed before production, not for beta |

---

## 1. Google OAuth App Verification

**Why deferred:** Google requires a verification process before unverified apps can access Gmail and Calendar scopes for the general public. During development, test users (manually added in Google Cloud Console) can bypass the "Access blocked" screen.

**Scopes being verified:**
- `https://www.googleapis.com/auth/gmail.readonly` — Sensitive
- `https://www.googleapis.com/auth/calendar` — Sensitive

No restricted scopes — no third-party security audit required.

### Steps

| Step | Status | Notes |
|------|--------|-------|
| Privacy Policy live at a public URL | ❌ | Required before submitting — covers OAuth data use, SMS consent, 30-day deletion |
| Homepage live at a public URL | ❌ | Vercel deployment URL works |
| Verify domain ownership in Google Search Console | ❌ | Must verify the domain your OAuth redirect lives on |
| Configure OAuth consent screen (name, logo, support email, scopes, authorized domain) | ❌ | Google Cloud Console → APIs & Services → OAuth consent screen |
| Record demo video | ❌ | Screen recording showing: OAuth consent flow + how Gmail and Calendar data is used in the app |
| Submit for brand verification | ❌ | 2–3 business day review |
| Submit for sensitive scope verification | ❌ | After brand verification — 2–6 week review |

**References:**
- [Brand verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification)
- [Sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)
- [Google OAuth verification walkthrough](https://ryanschiang.com/google-oauth-verification-what-to-expect)

**Beta workaround (current):** Manually add each tester's email in Google Cloud Console → OAuth consent screen → Test users.

---

## 2. Twilio Toll-Free Number Verification

**Why deferred:** Unverified toll-free numbers have limited throughput and may be filtered by carriers. Verification is required for reliable SMS delivery at scale.

| Step | Status | Notes |
|------|--------|-------|
| Twilio Messaging Service created (`MGbf33d2d3327638ca21a7f05be5e138ba`) | ✅ | Done 2026-04-12 |
| Toll-free verification submitted | ⏳ | Submitted 2026-04-12 — approval takes 1–3 business days |
| Verification approved | ⏳ | Pending |

**Impact of not verifying:** SMS delivery works but may be rate-limited or filtered.

---

## 3. Apple Developer Program

**Why deferred:** Requires paid membership ($99/year) and Apple-side credentials that must be manually retrieved from App Store Connect.

| Step | Status | Notes |
|------|--------|-------|
| Apple Developer Program membership active | ❌ | $99/year at developer.apple.com |
| Retrieve Apple ID | ❌ | The Apple ID email used for the developer account |
| Retrieve App Store Connect App ID (`ascAppId`) | ❌ | Create app in App Store Connect → General → App Information |
| Retrieve Team ID (`appleTeamId`) | ❌ | developer.apple.com → Account → Membership |
| Fill in `mobile/eas.json` — `appleId`, `ascAppId`, `appleTeamId` | ❌ | See `DEPLOYMENT.md §4` |
| Fill in `mobile/app.json` — `appleTeamId` | ❌ | |
| Run `eas build --platform ios --profile preview` | ❌ | Confirms build pipeline works |
| Verify app installs via TestFlight on a physical iPhone | ❌ | Full onboarding flow must complete |

---

## 4. Backend Deployment

### 4a. Vercel (Next.js API)

| Step | Status | Notes |
|------|--------|-------|
| Deploy to Vercel (`vercel --prod`) | ❌ | See `DEPLOYMENT.md §2` |
| Set all Vercel environment variables | ❌ | See table below |
| Update `GOOGLE_REDIRECT_URI` in Google Cloud Console to Vercel URL | ❌ | Must match exactly: `https://<vercel-domain>/api/auth/google/callback` |
| Update Twilio inbound SMS webhook to Vercel URL | ❌ | Twilio Console → Phone Numbers → your number → Messaging webhook → `https://<vercel-domain>/api/sms/webhook` |
| Confirm `GET /api/health` returns 200 on production URL | ❌ | |

**Vercel environment variables:**

| Variable | Set? |
|----------|------|
| `NEXT_PUBLIC_SUPABASE_URL` | ❌ |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ❌ |
| `SUPABASE_SERVICE_ROLE_KEY` | ❌ |
| `GOOGLE_CLIENT_ID` | ❌ |
| `GOOGLE_CLIENT_SECRET` | ❌ |
| `GOOGLE_REDIRECT_URI` | ❌ |
| `TWILIO_ACCOUNT_SID` | ❌ |
| `TWILIO_AUTH_TOKEN` | ❌ |
| `TWILIO_PHONE_NUMBER` | ❌ |
| `TWILIO_WEBHOOK_URL` | ❌ |
| `REDIS_URL` | ❌ (copy from Railway after provisioning) |
| `ANTHROPIC_API_KEY` | ❌ |
| `GMAIL_PUBSUB_TOPIC` | ❌ |

### 4b. Railway (Celery Worker + Beat + Redis)

| Step | Status | Notes |
|------|--------|-------|
| Create Railway project | ❌ | |
| Provision Redis service in Railway | ❌ | Copy `REDIS_URL` for use in Vercel + Celery env vars |
| Create Celery Worker service (root: `celery_worker`, start: `celery -A celery_app worker`) | ❌ | |
| Create Celery Beat service (root: `celery_worker`, start: `celery -A celery_app beat`) | ❌ | |
| Generate Fernet encryption key and store as `ENCRYPTION_KEY` | ❌ | `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` — generate once, never rotate after users connect Google |
| Verify Google OAuth callback uses encrypted path | ❌ | `src/app/api/auth/google/callback/route.ts` branches on `NODE_ENV`. In dev it writes tokens directly to Supabase (unencrypted). In production (`NODE_ENV=production`, set automatically by Vercel) it enqueues the Celery `encrypt_and_store_tokens` task via Redis. **Celery worker + `ENCRYPTION_KEY` must be live on Railway before any real users connect Google.** |
| Set all Railway environment variables on both Celery services | ❌ | See `DEPLOYMENT.md §3` |
| Confirm Canvas sync Beat task fires every 60 min (Railway logs) | ❌ | |
| Confirm GCal watch renewal Beat task fires every 6h (Railway logs) | ❌ | Watch channels expire every 7 days |

### 4c. Supabase

| Step | Status | Notes |
|------|--------|-------|
| Run all pending migrations (`npx supabase db push`) | ❌ | Always run before going live |
| Confirm RLS policies active on all tables | 🔧 | |
| Remove test phone numbers / hardcoded OTPs from Supabase Auth dashboard | ❌ | Test OTP `123456` added during dev — remove before launch |

---

## 5. Mobile App — Production Build

| Step | Status | Notes |
|------|--------|-------|
| Set `EXPO_PUBLIC_API_URL` to Vercel production URL in `mobile/.env` | ❌ | Currently points to `localhost:3000` |
| Confirm `EXPO_PUBLIC_DEMO_MODE=false` in `mobile/.env` | ✅ | Set 2026-04-12 |
| Run `eas build --platform ios --profile production` | ❌ | After Apple credentials are filled in |
| Submit production build to App Store (`eas submit --platform ios --profile production`) | ❌ | After Phase 12 legal/listing complete |

---

## 6. Legal & Compliance

| Step | Status | Notes |
|------|--------|-------|
| Privacy Policy written and live at a public URL | ❌ | Must cover: SMS consent, OAuth token storage (Gmail + Calendar), 30-day data deletion, AES-256 encryption at rest |
| Terms of Service written and live | ❌ | |
| SMS opt-in consent flow in app (TCPA) | ✅ | Implemented — `tcpa.tsx` screen with explicit toggle |
| Privacy Policy and ToS URLs added to App Store Connect listing | ❌ | Required for App Store approval |
| Privacy Policy URL added to Google OAuth consent screen | ❌ | Required for Google verification |

---

## 7. App Store Connect Listing

| Step | Status | Notes |
|------|--------|-------|
| Create app in App Store Connect | ❌ | Sets `ascAppId` |
| Write app description and keywords | ❌ | Phase 12 |
| Create screenshots for 6.7" iPhone (iPhone Pro Max) | ❌ | Required by App Store |
| Create screenshots for 6.1" iPhone | ❌ | Required by App Store |
| Set age rating | ❌ | |
| Link Privacy Policy URL | ❌ | |
| Submit for App Store review | ❌ | Status: "Waiting for Review" confirms submission |

---

## 8. Google Cloud — Gmail Pub/Sub Watch

**Why deferred:** Gmail watch notifications require a Pub/Sub topic and a publicly accessible push endpoint. This only works once the Next.js backend is deployed to Vercel.

| Step | Status | Notes |
|------|--------|-------|
| Create Google Cloud Pub/Sub topic for Gmail watch | ❌ | Set as `GMAIL_PUBSUB_TOPIC` env var |
| Configure push subscription to Vercel webhook endpoint | ❌ | Endpoint: `https://<vercel-domain>/api/sync/gmail/webhook` |
| Confirm Gmail watch notifications arrive at Vercel webhook | ❌ | |
| GCal push notification channel renewal (Beat task `renew-watch-channels`) | 🔧 | Implemented — confirm it runs in Railway logs |

---

## Launch Order

These must be completed in dependency order:

```
1. Privacy Policy + ToS (blocks Google verification AND App Store)
2. Vercel deploy (blocks Twilio webhook + Google redirect URI update)
3. Railway deploy (blocks Celery jobs + welcome SMS)
4. Remove Supabase test OTPs
5. Update EXPO_PUBLIC_API_URL → Vercel URL, rebuild app
6. Google OAuth verification submitted (long lead time — start early)
7. Twilio toll-free verification approved (in progress)
8. Apple Developer credentials → EAS build → TestFlight
9. App Store Connect listing + screenshots
10. Submit to App Store
```

---

## Quick Reference — What Works Locally But Breaks in Production

| Thing | Local workaround | Production fix needed |
|-------|-----------------|----------------------|
| Google OAuth | Test users manually added | App verification |
| Redis | `docker-compose up redis` | Railway Redis service |
| Next.js API | `npm run dev` on localhost | Vercel deployment |
| Celery workers | Not running (SMS features limited) | Railway Celery services |
| Twilio inbound SMS | Not reachable (no public URL) | Vercel URL set as Twilio webhook |
| Gmail Pub/Sub watch | Not wired up | Pub/Sub push to Vercel URL |
| Mobile API URL | `localhost:3000` | `EXPO_PUBLIC_API_URL` → Vercel URL |
| Supabase test OTP | `123456` hardcoded for any test number | Remove test users before launch |
