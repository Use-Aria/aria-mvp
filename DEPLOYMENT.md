# Aria — Deployment (V2)

> How to deploy Aria V2. The pieces are a Vercel Hobby project (the Next.js app), the syllabus parser on Google Cloud Run, Supabase (Postgres + pg_cron + Vault), Upstash Redis, Sendblue and Google Cloud (OAuth + Pub/Sub). All accounts are under Daniel's control.
> Source runbooks: master plan `docs/plans/2026-10-10-v2-master-plan.md` §7 (accounts, post-deploy), V2-08 §12 (parser), V2-07 §6.2 (Google). Track progress in `PRODUCTION.md`.

```
iMessage ── Sendblue ──webhook──▶ Vercel: Next.js 16 (src/app, src/server)
                                   │   ▲  POST /api/jobs/dispatch (HMAC, every 15s)
                                   │   └── Supabase pg_cron + pg_net (Vault: URL + secret)
                                   ├──▶ Supabase Postgres (service role)
                                   ├──▶ Upstash Redis (run lease, rate limits)
                                   ├──▶ Anthropic (Haiku 5.5 / Sonnet 5.5)
                                   ├──▶ Google APIs (Calendar, Gmail) ◀── Pub/Sub push /api/google/gmail-push
                                   └──HTTPS + HMAC──▶ Cloud Run: aria-parser (FastAPI) ──▶ Anthropic (parser key)
Vercel Cron (daily): /api/jobs/dispatch, /api/cron/daily      GitHub Actions: keepalive.yml
```

Order: Supabase → parser → Vercel (first deploy gives `APP_BASE_URL`) → Google + Sendblue (both need the URL) → the post-deploy runbook.

---

## 1. Supabase

The V2 project (`onrurwsourjlgfmitezh`) already has migrations 001–003 applied. For a new project, for example the free `aria-dev` (D11):

```bash
supabase link --project-ref <project-ref>
supabase db push                         # 001_v2_baseline, 002_jobs_extensions, 003_v2_build
supabase gen types typescript --linked --schema public > src/server/db/types.ts
```

Then check:
- `select version();` returns ≥ 15.1.1.61, which the 15s pg_cron schedule needs.
- `select jobname, schedule, active from cron.job order by 1;` lists 5 jobs: `aria-jobs-tick`, `aria-retention-enqueue`, `aria-cron-history-purge`, `canvas-sync-enqueue`, `timeline-cleanup`.

The tick does nothing until the Vault secrets are set (§6 step 1).

---

## 2. Syllabus parser (Google Cloud Run)

You need a GCP project with a **billing account linked** (the free tier requires one; reuse `aria-v2`) and an Anthropic key from a separate workspace named `aria-parser` (D6).

```bash
# 0. Project + APIs
gcloud config set project <ARIA_GCP_PROJECT>
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com

# 1. Secrets
printf %s "$ARIA_PARSER_ANTHROPIC_KEY" | gcloud secrets create aria-parser-anthropic-key --data-file=-
openssl rand -base64 48 | tr -d '\n' > /tmp/parser_secret      # also goes into Vercel as PARSER_SHARED_SECRET
gcloud secrets create aria-parser-shared-secret --data-file=/tmp/parser_secret && rm /tmp/parser_secret

# 2. Runtime identity
gcloud iam service-accounts create aria-parser --display-name="Aria parser"
for s in aria-parser-anthropic-key aria-parser-shared-secret; do
  gcloud secrets add-iam-policy-binding $s \
    --member="serviceAccount:aria-parser@<ARIA_GCP_PROJECT>.iam.gserviceaccount.com" \
    --role=roles/secretmanager.secretAccessor
done

# 3. Deploy from source (Cloud Build uses services/parser/Dockerfile)
gcloud run deploy aria-parser --source services/parser --region us-east4 \
  --service-account aria-parser@<ARIA_GCP_PROJECT>.iam.gserviceaccount.com \
  --allow-unauthenticated --cpu 1 --memory 1Gi --concurrency 2 \
  --min-instances 0 --max-instances 2 --timeout 300 --cpu-boost \
  --set-secrets ANTHROPIC_API_KEY=aria-parser-anthropic-key:latest,PARSER_SHARED_SECRET=aria-parser-shared-secret:latest \
  --set-env-vars PARSER_PRIMARY_MODEL=claude-sonnet-5-5,PARSER_ESCALATION_MODEL=claude-opus-5-5,LOG_LEVEL=info

# 4. Keep Artifact Registry under the free tier (newest 3 images)
cat > /tmp/ar-policy.json <<'EOF'
[{"name":"keep-3","action":{"type":"Keep"},"mostRecentVersions":{"keepCount":3}},
 {"name":"delete-rest","action":{"type":"Delete"},"condition":{"tagState":"any"}}]
EOF
gcloud artifacts repositories set-cleanup-policies cloud-run-source-deploy --location us-east4 --policy /tmp/ar-policy.json

# 5. $5 budget alert
gcloud billing budgets create --billing-account=<BILLING_ACCOUNT_ID> --display-name="aria-free-test" \
  --budget-amount=5USD --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0
```

Check:
- `curl https://<parser-url>/healthz` returns `{"ok":true,…}`.
- An unsigned `curl -X POST https://<parser-url>/v1/parse-syllabus -d '{}'` returns 401.

Never set `PARSER_FAKE_LLM` on Cloud Run; the service refuses it when `K_SERVICE` is set. To rotate the secret, add a new version, set `PARSER_SHARED_SECRET_PREVIOUS` to the old one, redeploy, update Vercel, then drop the old version.

**Fallback without GCP billing:** run a second Vercel project with root `services/parser`, and set `SYLLABUS_MAX_PDF_BYTES=3000000` in the app (V2-08 §12).

---

## 3. Upstash

Create a free Redis database in a region near Vercel `iad1` and copy its REST URL and token. Production refuses to run the lease and rate limits without it.

---

## 4. Vercel (Hobby)

1. Import the GitHub repo as a new project. Use the Next.js framework preset, Node.js **24.x** (from `package.json` engines), and the default build command.
2. Set the production environment variables. Mark secrets *Sensitive*. Names are in `.env.example`, and master plan §4 explains them.

   | Group | Vars |
   |---|---|
   | App | `APP_BASE_URL` (the production domain, e.g. `https://<app>.vercel.app`) |
   | Supabase | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` |
   | LLM | `ANTHROPIC_API_KEY`, `ARIA_AGENT=real`, optional `AGENT_ESCALATION_CAP_PCT` (default 10) |
   | Channel | `CHANNEL_PROVIDER=sendblue`, `SENDBLUE_API_KEY`, `SENDBLUE_API_SECRET`, `SENDBLUE_SIGNING_SECRET`, `SENDBLUE_FROM_NUMBER`, optional `SENDBLUE_API_BASE` |
   | Upstash | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` |
   | Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GMAIL_PUBSUB_TOPIC`, `GMAIL_PUSH_SERVICE_ACCOUNT`, `GMAIL_PUSH_SUBSCRIPTION`; optional `GOOGLE_REDIRECT_URI`, `GMAIL_PUSH_AUDIENCE`, `GOOGLE_PKCE` |
   | Secrets | `APP_ENCRYPTION_KEY` (`openssl rand -base64 32`, back it up), `SESSION_SECRET`, `JOBS_DISPATCH_SECRET` (`openssl rand -hex 32`), `CRON_SECRET` (`openssl rand -hex 32`) |
   | Parser | `PARSER_SERVICE_URL` (Cloud Run URL), `PARSER_SHARED_SECRET` (same as the GCP secret), `SYLLABUS_MEDIA_ALLOWED_HOSTS` (Sendblue media CDN host; empty fails closed) |

   Leave `DEV_CHANNEL_SECRET` unset. The dev route returns 404 in production regardless.
3. Deploy. If the final domain differs from the `APP_BASE_URL` you set, fix it and redeploy.
4. `vercel.json` registers two daily crons: `/api/jobs/dispatch` at 12:00 UTC and `/api/cron/daily` at 10:00 UTC. Vercel sends `Authorization: Bearer $CRON_SECRET`.

---

## 5. Google Cloud and Sendblue

**Google** (V2-07 §6.2, about 30 min):
1. Create the project `aria-v2` and link billing.
2. Enable the Gmail, Calendar and Pub/Sub APIs.
3. Branding: no logo, `/privacy` and `/terms` URLs, authorized domain `<app>.vercel.app`. If the domain is rejected, buy one (D4).
4. Audience: External, **Publish → In production**.
5. Add these scopes manually: `openid`, `userinfo.email`, `calendar.events.readonly`, `calendar.calendarlist.readonly`, `calendar.app.created`, `gmail.readonly`, `gmail.send`.
6. Create a Web client `aria-web` with redirect URIs `https://<app>.vercel.app/api/google/callback` and `http://localhost:3000/api/google/callback`.
7. Create the Pub/Sub topic `gmail-push` and grant `gmail-api-push@system.gserviceaccount.com` the publisher role on it.
8. Create the service account `gmail-push-invoker`.
9. Create the push subscription `gmail-push-sub` with endpoint `https://<app>.vercel.app/api/google/gmail-push`. Use the same URL as the token audience.
10. Set the Google env vars in Vercel and redeploy.

**Sendblue sandbox:**
1. Create the API key and secret.
2. Set the `receive` webhook to `https://<app>.vercel.app/api/channels/sendblue`, with the global secret equal to `SENDBLUE_SIGNING_SECRET`.
3. Turn on auto typing indicator and auto mark-read. Don't add an outbound status webhook (D12).
4. Add each friend as a contact (≤10). Each friend texts the number once.

---

## 6. Post-deploy runbook (master plan §7.2)

1. **Vault + tick.** Run `scripts/ops/configure-jobs-tick.sql` section by section in the Supabase SQL editor. Never commit the filled-in values.
   - Set `<APP_BASE_URL>/api/jobs/dispatch` and `JOBS_DISPATCH_SECRET`. The secret must equal the Vercel value.
   - Then run the verify block: a `noop` job reaches `done` within ~30s, and `net._http_response` shows 202.
   - Rotation and pause blocks are in the same file.
2. **Crons.** Check that both crons appear in the Vercel dashboard. Then `curl -H "Authorization: Bearer $CRON_SECRET" $APP_BASE_URL/api/cron/daily` should return 200 and update `system_heartbeat`.
3. **Sendblue.** Send a test text. The webhook should log 200 in under 1s, and Aria should reply.
4. **Google.** The redirect URI and the Pub/Sub push endpoint use the deployed host. Do a first connect with Daniel's personal Gmail.
5. **Parser.** `curl $PARSER_SERVICE_URL/healthz`. Text a PDF from an iPhone, read the media host from the redacted webhook log, set `SYLLABUS_MEDIA_ALLOWED_HOSTS`, and redeploy.
6. **GitHub keepalive** (`.github/workflows/keepalive.yml`).
   - Repo secrets: `SUPABASE_URL`, and `SUPABASE_ANON_KEY` set to the project's **publishable** key, never the service-role key.
   - Optional secrets: `APP_BASE_URL` + `CRON_SECRET`, which also ping `/api/cron/daily?source=gh`.
   - Run it once from the Actions tab.
7. Work through the [verify] list in `PRODUCTION.md`.
