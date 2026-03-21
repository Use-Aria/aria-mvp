# Deployment Guide

How to deploy Aria to production: Vercel (Next.js API) + Railway (Celery workers) + Supabase (database).

---

## Architecture

```
iOS App (Expo/EAS)
    ↓ HTTPS
Vercel — Next.js API routes (src/app/api/)
    ↓ Celery tasks via Redis
Railway — Celery worker + Celery Beat (celery_worker/)
    ↓ reads/writes
Supabase — PostgreSQL database
```

---

## 1. Supabase

Already provisioned. Run any pending migrations before deploying:

```bash
npx supabase db push
```

---

## 2. Vercel (Next.js API)

**Deploy:**
```bash
npm install -g vercel
vercel --prod
```

**Required environment variables** (set in Vercel dashboard → Settings → Environment Variables):

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (server-only) |
| `GOOGLE_CLIENT_ID` | Google OAuth 2.0 client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth 2.0 client secret |
| `GOOGLE_REDIRECT_URI` | Must match: `https://your-vercel-domain.vercel.app/api/auth/google/callback` |
| `TWILIO_ACCOUNT_SID` | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Twilio auth token |
| `TWILIO_PHONE_NUMBER` | Your Twilio phone number (E.164 format: +1XXXXXXXXXX) |
| `TWILIO_WEBHOOK_URL` | Full URL for inbound SMS: `https://your-vercel-domain.vercel.app/api/sms/webhook` |
| `REDIS_URL` | Redis URL from Railway (copy after provisioning Redis service) |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `GMAIL_PUBSUB_TOPIC` | Google Cloud Pub/Sub topic name for Gmail watch notifications |

**After deploying:**
- Update `GOOGLE_REDIRECT_URI` in Google Cloud Console to match your Vercel URL
- Update Twilio webhook URL in Twilio Console → Phone Numbers → your number → Messaging webhook

---

## 3. Railway (Celery Worker + Beat)

**Services to create in Railway:**

### Redis
1. New Project → Add Service → Redis
2. Copy the `REDIS_URL` from Redis service → use in both Vercel and Celery env vars

### Celery Worker
1. Add Service → GitHub Repo → select `aria-mvp`
2. Set root directory: `celery_worker`
3. Railway auto-detects `Dockerfile` in `celery_worker/`
4. Start command: `celery -A celery_app worker --loglevel=info --concurrency=2`

### Celery Beat (scheduler)
1. Add another service from the same repo
2. Set root directory: `celery_worker`
3. Start command: `celery -A celery_app beat --loglevel=info`

**Required environment variables** (set in Railway dashboard for both Celery services):

| Variable | Description |
|----------|-------------|
| `REDIS_URL` | From Railway Redis service (auto-linked if same project) |
| `SUPABASE_URL` | Same as `NEXT_PUBLIC_SUPABASE_URL` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |
| `TWILIO_ACCOUNT_SID` | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Twilio auth token |
| `TWILIO_PHONE_NUMBER` | Your Twilio phone number |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `GOOGLE_CLIENT_ID` | Google OAuth 2.0 client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth 2.0 client secret |
| `GMAIL_PUBSUB_TOPIC` | Google Cloud Pub/Sub topic name |
| `ENCRYPTION_KEY` | Fernet key for OAuth token encryption (generate with `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`) |

---

## 4. iOS App (EAS Build)

**Prerequisites:**
- Apple Developer Program membership ($99/year)
- `eas-cli` installed: `npm install -g eas-cli`
- Logged in: `eas login`

**Fill in `mobile/eas.json`:**
```json
"submit": {
  "production": {
    "ios": {
      "appleId": "your@apple.id",
      "ascAppId": "YOUR_APP_STORE_CONNECT_APP_ID",
      "appleTeamId": "YOUR_TEAM_ID"
    }
  }
}
```

**Fill in `mobile/app.json`:**
```json
"ios": {
  "appleTeamId": "YOUR_TEAM_ID"
}
```

**Build and submit:**
```bash
cd mobile

# TestFlight (internal testing)
eas build --platform ios --profile preview
eas submit --platform ios --profile preview

# App Store
eas build --platform ios --profile production
eas submit --platform ios --profile production
```

---

## 5. Post-Deploy Verification

- [ ] `GET https://your-vercel-domain.vercel.app/api/health` returns 200
- [ ] Canvas sync Celery Beat task fires every 60 min (check Railway logs)
- [ ] Twilio webhook receives inbound SMS (test from Twilio console)
- [ ] Google OAuth callback completes and stores encrypted token in Supabase
- [ ] Daily briefing generates and sends at 8am user timezone

---

## Generating the Fernet Encryption Key

The Celery workers encrypt OAuth tokens before storing in Supabase. Generate once and store in Railway:

```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

Store the output as `ENCRYPTION_KEY` in Railway. Do not rotate this key after users have connected Google accounts — it will invalidate all stored tokens.
