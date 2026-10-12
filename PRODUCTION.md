# Aria — Production Readiness Checklist

> Everything that is deferred or faked during local development but **required before Aria V2 runs for real users**.
> Update this file whenever implementation reveals a new production dependency.
> Owner: Daniel Lee (CTO). How-to for each item: `DEPLOYMENT.md`. Source runbooks: `docs/plans/2026-10-10-v2-master-plan.md` §7.

## Status legend

| Symbol | Meaning |
|--------|---------|
| ✅ | Done |
| ⏳ | In progress / pending external review |
| ❌ | Not started; blocks the free test |
| 🔧 | Not started; needed before a public launch, not for the free test |
| ⛔ | Superseded (V1 only) |

---

## 1. V2 free-test dependencies

| # | Dependency | Status | Notes |
|---|---|---|---|
| 1 | **Vercel project (Hobby)** + `APP_BASE_URL` | ❌ | Node 24. Every prod var from master plan §4 must be set. The URL is needed for magic links, OAuth redirects, Pub/Sub push and the jobs tick. Hobby is non-commercial only, so never charge anyone. |
| 2 | `CRON_SECRET` (Vercel Cron bearer) | ❌ | `openssl rand -hex 32`. It authorizes the daily `/api/cron/daily` (reconcile + heartbeat) and the `/api/jobs/dispatch` backstop (`vercel.json`). |
| 3 | **Supabase Vault + pg_cron tick** | ❌ | Run `scripts/ops/configure-jobs-tick.sql` after the first deploy. It sets `aria_dispatch_url` and `aria_dispatch_secret`, and the secret must equal `JOBS_DISPATCH_SECRET`. Until then the 15s `aria-jobs-tick` does nothing, and only the daily Vercel cron runs jobs. |
| 4 | Supabase migrations 001–003 on the prod project | ✅ | Project `onrurwsourjlgfmitezh`. Types in `src/server/db/types.ts` are current. |
| 5 | **Upstash Redis** (REST URL + token) | ❌ | Run lease + rate limits. Without it, production fails closed: the lease throws and rate limits deny. Pick a region near `iad1`. |
| 6 | **Sendblue sandbox** | ❌ | API key/secret, signing secret (`globalSecret`) and from-number. Set the `receive` webhook to `/api/channels/sendblue`. Turn on auto typing + mark-read and skip the outbound status webhook (D12). ≤10 contacts, so add each friend with `add-contact`. |
| 7 | **Google Cloud project `aria-v2`** | ❌ | OAuth consent screen **In production, unverified**, never "Testing" (which expires refresh tokens after 7 days). Web client `aria-web`. Gmail, Calendar and Pub/Sub APIs enabled. Topic `gmail-push` with the publisher grant, SA `gmail-push-invoker`, push subscription `gmail-push-sub`. Billing linked. |
| 8 | `*.vercel.app` accepted as a Google authorized domain | ❌ | If rejected, buy a domain (~$10–11/yr, Cloudflare) (D4). |
| 9 | **Python parser on Google Cloud Run** (`aria-parser`, `us-east4`) | ❌ | Needs a billing account. Secrets in Secret Manager, SA `aria-parser`, `--max-instances 2`, Artifact Registry keep-3 cleanup policy. Yields `PARSER_SERVICE_URL` + `PARSER_SHARED_SECRET`. |
| 10 | **$5 GCP budget alert** | ❌ | Alerts at 50/90/100%. Expected spend is $0. |
| 11 | **Separate Anthropic key for the parser** (workspace `aria-parser`) | ❌ | D6. Stored only in Secret Manager, never in Vercel. |
| 12 | `SYLLABUS_MEDIA_ALLOWED_HOSTS` | ❌ | The Sendblue media CDN host, known only after the first real PDF webhook. **Required:** empty fails closed in production, so no chat PDF can be read. `*.suffix` is allowed. |
| 13 | **GitHub repo secrets for `.github/workflows/keepalive.yml`** | ❌ | Required: `SUPABASE_URL`, and `SUPABASE_ANON_KEY` set to the project's new-style **publishable** key, never the service-role key. Optional: `APP_BASE_URL` + `CRON_SECRET`, which also ping `/api/cron/daily?source=gh` and write the `gh-actions` heartbeat row. |
| 14 | Contact email on `/privacy` | ❌ | The page says "Text Aria 'help'". Google's branding form needs a support email, so add a real contact address before submitting the consent screen. |
| 15 | Back up `APP_ENCRYPTION_KEY` to the password manager | ❌ | Losing it makes stored OAuth tokens and Canvas feed URLs unrecoverable. Never rotate it without a re-encryption plan. |
| 16 | Separate dev Supabase project (`aria-dev`) | 🔧 | D11. Dev and prod share one project today, so once Vault is set the prod tick can claim local-dev jobs (they dead-letter harmlessly). The local stack (`supabase start`) covers most dev work. |
| 17 | Sentry (`SENTRY_DSN`) | 🔧 | Not wired yet. `llm_calls` + `agent_runs` are the only telemetry. |
| 18 | OpenAI fallback model (`OPENAI_API_KEY`) | 🔧 | Deferred (V2-04 T9). |
| 19 | **Wave 5 code-review fixes (send safety)** | ✅ | Fix 5.5 findings #1–#4 before any friend connects Gmail: no HTTP retry on `messages.send` or calendar inserts, no turn replay after side effects, a chat confirm must postdate the draft, a long timeout for `confirm_action`. Full list: orchestrator notes → Wave 5 hand-off. |
| 20 | Wave 5 code-review fixes (other) | ✅ | Fixed 2026-10-11: #5, #6, #7 (per-phone limit + name confirm), #8, #9, #10, #13. #11: logs keep last-4 (spec §3.22, Daniel). #12: action-lock gaps stay a documented design gap. |

---

## 2. Verify when credentials arrive (master plan §7.3 + Wave 4 additions)

Details for each item are in the branch plans' §12.

**Sendblue** (V2-03 §12, V2-04 §12, V2-08 V3)
- ❌ The `sb-signing-secret` header is a static secret
- ❌ Canonical base URL: `.com` vs `.co` (`SENDBLUE_API_BASE`)
- ❌ Fixtures captured for iMessage text, photo, PDF, multi-attachment, inline reply, SMS from Android, and an Apple ID email sender
- ❌ Inbound tapback shape. This decides `x_` evidence ("❤️ = yes"). Tapback parsing is off until confirmed.
- ❌ The send response carries `message_handle`
- ❌ Typing, reactions and inline replies work on the sandbox line
- ❌ STOP/START behaviour
- ❌ The vCard renders and links expand
- ❌ Sandbox limits, and whether a 24h window applies to proactive messages
- ❌ Media CDN host (→ `SYLLABUS_MEDIA_ALLOWED_HOSTS`)

**Upstash**
- ❌ `SET NX PX` and the Lua release work, with byte-exact tokens under `automaticDeserialization: false`

**Supabase**
- ❌ Postgres version ≥ 15.1.1.61
- ❌ The 15s cron runs on Free
- ❌ `extensions.hmac` exists
- ❌ Vault is readable by cron
- ❌ pg_net timeout
- ❌ Free-tier pausing behaviour over 8 days, with the keepalive running

**Vercel**
- ❌ `maxDuration = 300` takes effect
- ❌ `after()` runs ≥ 60s
- ❌ pg_net's 5s timeout vs cold start
- ❌ The cron bearer arrives
- ❌ Node 24 has full ICU zones
- ❌ Both crons and the GH keepalive fire

**Anthropic**
- ❌ Cache read on the second identical call (`scripts/check-llm-cache.ts`)
- ❌ Haiku TTFT p50/p95, adaptive vs disabled thinking
- ❌ The strict grammar compiles with all 31 tools in prod. Locally green at the Wave 4 gate.
- ❌ Sonnet reads Haiku thinking blocks (mid-run escalation)
- ❌ Briefing token counts, and the Monday briefing fits in 2048 max tokens

**Google**
- ❌ `vercel.app` is accepted as an authorized domain
- ❌ Scope classes shown in the Console
- ❌ The consent screen publishes In production
- ❌ The unverified-app screen
- ❌ Granular consent
- ❌ PKCE accepted for Web clients (`GOOGLE_PKCE=off` fallback)
- ❌ Refresh token on reconnect (`prompt=consent`)
- ❌ The Aria calendar is created, and CRUD works under `calendar.app.created`
- ❌ The `privateExtendedProperty=aria_key` filter works
- ❌ A deleted Aria calendar returns 404/410, not 403
- ❌ Watch expiry, and `events.watch` on vercel.app
- ❌ Gmail push JWT
- ❌ Threaded send. `Message-ID` is preserved, and `rfc822msgid:` finds it.
- ❌ `gmail.send` 403 reasons
- ❌ `authuser` permalink
- ❌ Yale EliApps block test (one Yale account first)
- ❌ Revocation sends exactly one message
- ❌ `admin_policy_enforced` error shape
- ❌ Triage cost, and live classifier/digest quality
- ❌ iOS Safari sends `Sec-Fetch-Site` (≥ 16.4)

**Canvas** (Daniel's Yale feed)
- ❌ Id shape, content type, ETag
- ❌ Course-code format → `courseKey`
- ❌ Date-only spot checks and overrides
- ❌ Revocation signature
- ❌ Fetch works from Vercel `iad1`
- ❌ Hourly slot
- ❌ DST on 2026-11-01

**Parser** (V2-08 §12 V1–V10)
- ❌ healthz cold start
- ❌ Unsigned request returns 401
- ❌ End to end over Sendblue
- ❌ A re-send hits the hash guard (no new `llm_calls`)
- ❌ A non-syllabus PDF is rejected
- ❌ `/setup` upload works ≤ 4 MB
- ❌ Logs are clean
- ❌ Billing is $0 after a week
- ❌ Secret rotation drill

**Web** (web §12)
- ❌ iMessage previews for each link kind
- ❌ The preview fetch doesn't burn the token
- ❌ `sms:` buttons
- ❌ Canvas guide and Google connect on iPhone
- ❌ `/week` around midnight
- ❌ Safe areas, dark mode, PWA copy
- ❌ Export download and delete
- ❌ The email draft send path
- ❌ Optimistic mark-done
- ❌ Clipboard
- ❌ Security headers
- ❌ Overlapping server-action responses finish on a production build / Vercel preview (they hang under `next dev`; e2e runs with 1 worker)
- ❌ `/email/<bad id>` status code on Vercel (a soft 404 = 200 under `next dev`)

**Wave 5 review [verify]**
- ❌ Whether Gmail `messages.send` dedupes a resent message with the same client Message-ID (fix 5.5 #1 regardless)
- ❌ Whether Sendblue's single retry on 503 can double-send (`sendblue.ts:309`)

**Wave 5 review fixes [verify]** (2026-10-11)
- ❌ `calendarList.list` with `minAccessRole=owner` works under `calendar.app.created` alone (used to adopt an "Aria" calendar after an ambiguous create)
- ❌ A duplicate `events.watch` channel id is rejected (not a second channel)
- ❌ Gmail `rfc822msgid:` search finds a just-sent message within the 2s second look
- ❌ `after(promise)` registered from `confirm_action` inside the dispatch's own `after()` keeps the Vercel invocation alive (≤300s)
- ❌ Sendblue `sent_at` vs DB clock skew doesn't misjudge a "yes" sent right as a draft appears (confirm-ordering check)
- ❌ A `send_unconfirmed` row settles via recovery (page read or daily reconcile) — no chat note is posted

---

## 3. Before a public launch (beyond the free test)

The full plan is in `docs/plans/2026-10-09-aria-v2-production-plan.md`.

| Step | Status | Notes |
|------|--------|-------|
| Google brand verification + restricted-scope verification | 🔧 | `gmail.readonly` is **restricted**, not sensitive, so it needs a CASA security assessment. `gmail.send` is sensitive. The unverified In-production app is capped at 100 users lifetime. Needs a real domain, homepage, full privacy policy, Search Console domain verification and a demo video. Brand review takes 2–3 business days and scope review takes weeks. |
| Full Privacy Policy + Terms of Service | 🔧 | `/privacy` and `/terms` are minimal pages for the free test (D5). |
| TCPA-grade consent capture, age gate (13+) | 🔧 | Skipped for the private test. |
| Backups / PITR | 🔧 | Supabase Free has no backups. Nightly `pg_dump` to Daniel's storage, or upgrade. |
| Paid tiers (Vercel Pro, Supabase Pro, Sendblue AI Agent line) | 🔧 | Hobby is non-commercial. The sandbox is ≤10 contacts on a shared number. |
| Anthropic zero-data-retention review | 🔧 | Aria reads friends' email. |

---

## 4. Decommission V1 accounts (spec §2)

| Step | Status | Notes |
|------|--------|-------|
| Rotate keys on the old Supabase project `jjnedeyfpgogaizsucxp`. Remove its test OTP `123456`. Delete the project once it's confirmed empty of real users. | 🔧 | V1 never launched, so nothing gets migrated |
| Railway project (former teammate's account) shut down | 🔧 | Rotate every secret it could hold |
| Twilio: rotate the auth token, then wind down | 🔧 | V2 doesn't use Twilio |
| Old Google Cloud OAuth client: reset its secret or delete it | 🔧 | V2 uses the new `aria-v2` project |
| Old Anthropic keys revoked | 🔧 | |
| GitHub: remove former teammates' write access and deploy keys | 🔧 | |
| Apple/EAS/Expo: optionally revoke certs | 🔧 | No app in V2 |

---

## 5. Superseded V1 items (kept for history)

The V1 checklist covered Twilio toll-free verification, the Apple Developer Program, EAS/TestFlight builds, the App Store Connect listing, the Railway Celery worker + Beat + Redis, the Fernet `ENCRYPTION_KEY`, and the `EXPO_PUBLIC_API_URL` switch. V2 has no app, no Twilio and no Celery, so every one of these is ⛔. The V1 runbook is in git history before the Wave 5 cleanup and in `docs/history/`.

---

## Launch order (free test)

```
0. Wave 5 review findings fixed (§1 #19, #20) ✅ 2026-10-11
1. Supabase prod project ready (done) → Upstash → Cloud Run parser + $5 budget + parser key
2. Vercel deploy (gives APP_BASE_URL) → set every env var → redeploy
3. Vault + tick (configure-jobs-tick.sql) → verify crons + keepalive secrets
4. Google Cloud project (authorized-domain check first; buy a domain if rejected)
5. Sendblue sandbox webhook → first PDF → SYLLABUS_MEDIA_ALLOWED_HOSTS
6. Work through §2, then invite friends (≤10 contacts)
```

## Quick reference: what works locally but needs real setup in production

| Thing | Local | Production |
|-------|-------|------------|
| Channel | `dev` provider (`npm run dev:chat`) | Sendblue webhook + `CHANNEL_PROVIDER=sendblue` |
| Jobs tick | `npm run dev:tick` | pg_cron 15s tick via Vault + Vercel daily crons |
| Lease / rate limits | DB lease; rate limits skipped | Upstash (fails closed if missing) |
| Parser | `docker compose up parser` with `PARSER_FAKE_LLM=1` | Cloud Run + separate Anthropic key |
| Gmail | Polling (no Pub/Sub topic) | Pub/Sub push to `/api/google/gmail-push` |
| Google OAuth | `http://localhost:3000/api/google/callback` | Deployed redirect URI on the `aria-v2` client |
| Chat PDFs | http/loopback media allowed | `SYLLABUS_MEDIA_ALLOWED_HOSTS` allow-list |
