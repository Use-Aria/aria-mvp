# Aria — Local Development Guide

> How to run the full stack locally and test the iOS app in the simulator.
> For first-time machine setup, see `SETUP.md`. For production deployment, see `DEPLOYMENT.md`.

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 18+ | `brew install node` |
| Docker Desktop | latest | [docker.com/products/docker-desktop](https://docker.com/products/docker-desktop) |
| Xcode | 14+ | Mac App Store (required for iOS Simulator) |
| Expo CLI | latest | `npm install -g expo-cli` |

Confirm before starting:
```bash
node --version       # v18+
docker --version     # any recent version
```

---

## Environment Variables

### 1. Root — `.env.local` (Next.js API)

Create at `aria-mvp/.env.local`. **Never commit this file.**

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://jjnedeyfpgogaizsucxp.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<get from Supabase dashboard → Settings → API>
SUPABASE_SERVICE_ROLE_KEY=<get from Supabase dashboard → Settings → API>

# Google OAuth
GOOGLE_CLIENT_ID=<get from Google Cloud Console → Credentials>
GOOGLE_CLIENT_SECRET=<get from Google Cloud Console → Credentials>
GOOGLE_REDIRECT_URI=http://localhost:3000/api/auth/google/callback

# Twilio
TWILIO_ACCOUNT_SID=<from twilio.com/console>
TWILIO_AUTH_TOKEN=<from twilio.com/console>
TWILIO_PHONE_NUMBER=+1XXXXXXXXXX

# Anthropic
ANTHROPIC_API_KEY=<from console.anthropic.com>

# Redis (matches docker-compose default — no change needed for local)
REDIS_URL=redis://localhost:6379/0
```

### 2. Mobile — `mobile/.env`

```bash
EXPO_PUBLIC_DEMO_MODE=false          # keep false — true injects fake session and skips all auth
EXPO_PUBLIC_API_URL=http://localhost:3000
EXPO_PUBLIC_SUPABASE_URL=https://jjnedeyfpgogaizsucxp.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=<same anon key as above>
```

> `EXPO_PUBLIC_DEMO_MODE=true` bypasses auth entirely and loads fake data — only use for pure UI work.

---

## Starting the Stack

Open **3 terminals**, run one command in each. Order matters.

### Terminal 1 — Redis (Docker)

```bash
open -a Docker          # wait for Docker Desktop to fully start (~30s)
cd /path/to/aria-mvp
docker-compose up -d redis
```

`docker-compose` reads worker env vars from root `.env.local`, so you should not see missing Supabase warnings if that file is populated.

Confirm it's running:
```bash
docker ps               # should show aria-mvp-redis-1 as healthy
```

> Redis is required for the Google OAuth callback and the onboarding complete route.
> Without it, Google connect will still work (dev fallback path), but welcome SMS won't enqueue.

### Terminal 2 — Next.js API

```bash
cd /path/to/aria-mvp
npm install             # only needed first time or after pulling new deps
npm run dev             # starts on http://localhost:3000
```

Leave this running. The mobile app calls all API routes here (`/api/onboarding/profile`, `/api/auth/google`, etc.).

### Terminal 3 — Expo Metro (iOS Simulator)

```bash
open -a Simulator       # boot the iOS Simulator first — wait for it to fully load
cd /path/to/aria-mvp/mobile
npm install             # only needed first time
npx expo start --clear  # --clear wipes Metro cache
```

Then press **`i`** to open in the iOS Simulator.

---

## Running Migrations

Any time you pull and there are new `.sql` files in `supabase/migrations/`:

```bash
npx supabase db push
```

If not linked yet:
```bash
export SUPABASE_ACCESS_TOKEN=<token from supabase.com/dashboard/account/tokens>
npx supabase link --project-ref jjnedeyfpgogaizsucxp
npx supabase db push
```

---

## Resetting for Onboarding Testing

Use this procedure any time you want to run through the full onboarding flow from scratch. All three steps are required for a complete reset.

**Step 1 — Wipe the simulator session**
```
iOS Simulator menu → Device → Erase All Content and Settings
```
Then press `i` in Metro to reinstall the app. This clears the Supabase session from SecureStore so the app launches with no active session.

**Step 2 — Delete the user from Supabase** (Supabase SQL Editor at supabase.com → SQL Editor)

```sql
delete from public.users
where phone = '1XXXXXXXXXX';  -- exact value as stored in public.users (e.g. '17034705155')

delete from auth.users
where phone = '1XXXXXXXXXX';
```

Both deletes are required. Deleting from `public.users` cascades and removes all child rows for that user: integrations (including stored Google OAuth tokens), deadlines, messages, calendar events, tasks, syllabi, gmail flags, conflict alerts, and spotify sessions. Deleting from `auth.users` removes the Supabase phone-auth account so the phone number is treated as brand new on next sign-up.

If you want to verify before deleting:
```sql
select id, phone from public.users where phone = '1XXXXXXXXXX';
select id, phone from auth.users where phone = '1XXXXXXXXXX';
```

**Step 3 — Revoke Aria's Google OAuth access**

If you connected a Google account during onboarding, that account still has Aria listed as an authorized app on Google's side even after the Supabase rows are deleted. To test the full Google OAuth consent screen again:

1. Go to [myaccount.google.com/permissions](https://myaccount.google.com/permissions)
2. Find **Aria** (or the OAuth app name you set in Google Cloud Console) in the list
3. Click it → **Remove Access**

After revoking, the next time you tap "Connect Google" in the tools screen, Google will show the full consent screen and permission grant — exactly what a new user sees.

> Skipping Step 3 is fine if you only want to test the onboarding flow mechanics. The OAuth callback will still work (Google re-issues tokens to a recognized app). Only revoke if you need to test the first-time consent UX.

---

## Google OAuth — Adding Test Users

The app is unverified with Google. Anyone trying to connect Google will see "Access blocked" unless their email is added as a test user.

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → select the Aria project
2. APIs & Services → OAuth consent screen
3. Scroll to **Test users** → **+ Add Users**
4. Add the tester's Google email
5. Save — they can now click through the "Google hasn't verified this app" warning

---

## Useful Commands

| Task | Command |
|------|---------|
| Run JS tests | `cd mobile && npx jest __tests__/onboarding.test.tsx --verbose` |
| Lint | `npm run lint` |
| Push migrations | `npx supabase db push` |
| Check Redis | `docker ps` |
| Stop Redis | `docker-compose down` |
| Clear Metro cache | `npx expo start --clear` |
| Hard reset simulator | Device → Erase All Content and Settings |

---

## Key Gotchas

| Gotcha | Rule |
|--------|------|
| Spinner on app launch | Stale SecureStore session — erase simulator and reinstall |
| `Network request failed` | Missing `react-native-url-polyfill/auto` as first import in `_layout.tsx` — already fixed, don't remove it |
| Google connect "Couldn't confirm" | Check Next.js terminal for errors. Redis must be running. In dev, tokens write directly to Supabase (no Celery needed). |
| `EXPO_PUBLIC_DEMO_MODE=true` | Bypasses all auth and loads fake data — always keep `false` for real testing |
| Back buttons in onboarding | Use `router.replace()` not `router.back()` — the stack is cleared via replace, `GO_BACK` will throw |
| Mobile API auth | All Next.js API routes read JWT from `Authorization: Bearer` header — NOT cookies |
| `onboarding_completed_at` routing | `_layout.tsx` re-fetches this on session + segment change. If routing loops, check that the complete route returned `{ ok: true }` in Next.js logs |
| Canvas iCal URL | Get from Canvas → Calendar → Calendar Feed link at the bottom of the right sidebar |
