---
phase: 06-google-oauth-gcal-gmail-alerts-conflict-detection
plan: 01
subsystem: auth
tags: [google-oauth, fernet, encryption, supabase, celery, redis, typescript, nextjs]

requires:
  - phase: 05-priority-engine-canonical-timeline-db
    provides: canonical_events table + Celery task infrastructure
  - phase: 03-twilio-sms-tcpa-compliance
    provides: send_sms_safe + _get_user_sms_state + TCPA guards
  - phase: 01-infrastructure-foundation
    provides: Supabase client pattern (_get_supabase), Next.js App Router, Redis/Celery setup

provides:
  - Supabase migration 006 with gmail_flags, conflict_alerts tables + 4 watch columns on integrations
  - Fernet token encryption module (encrypt_token/decrypt_token) with TOKEN_ENCRYPTION_KEY
  - Google OAuth token storage/retrieval with encryption at rest (store_google_tokens/load_google_tokens)
  - OAuth initiation route (GET /api/auth/google) with HMAC CSRF state + Calendar + Gmail scopes
  - OAuth callback route (GET /api/auth/google/callback) dispatching encrypt_and_store_tokens Celery task
  - encrypt_and_store_tokens Celery task — encrypts, stores, sends confirmation SMS, asks study preference
  - Study preference SMS flow — question on first Google connect, answer captured in preferences_json

affects:
  - 06-02 (GCal sync — uses load_google_tokens)
  - 06-03 (Gmail watch — uses load_google_tokens + gmail_flags table)
  - 06-04 (conflict detection — uses conflict_alerts table)
  - 06-05 (channel renewal — uses watch_expires_at column on integrations)

tech-stack:
  added:
    - cryptography>=42.0.0 (Fernet symmetric encryption)
    - google-api-python-client>=2.120.0
    - google-auth>=2.29.0
    - google-auth-oauthlib>=1.2.0
    - google-auth-httplib2>=0.2.0
    - google-cloud-pubsub>=2.21.0
    - rapidfuzz>=3.9.0
    - fakeredis>=2.23.0 (dev only)
  patterns:
    - Fernet encryption before any DB write for OAuth tokens
    - CSRF protection via HMAC state in httpOnly oauth_state cookie
    - Celery task as encryption boundary — tokens plaintext in memory/Redis only, encrypted before Supabase
    - Study preference interception before Claude processing in handle_reply

key-files:
  created:
    - supabase/migrations/006_google_integrations.sql
    - celery_worker/google_auth/__init__.py
    - celery_worker/google_auth/encryption.py
    - celery_worker/google_auth/tokens.py
    - celery_worker/tests/google_auth/__init__.py
    - celery_worker/tests/google_auth/test_encryption.py
    - celery_worker/tests/google_auth/test_tokens.py
    - src/app/api/auth/google/route.ts
    - src/app/api/auth/google/callback/route.ts
  modified:
    - celery_worker/tasks.py (added encrypt_and_store_tokens task)
    - celery_worker/ai/replies.py (added _handle_study_preference_reply + interception in handle_reply)
    - celery_worker/requirements.txt (added google libs + cryptography + rapidfuzz)
    - celery_worker/requirements-dev.txt (added fakeredis)

key-decisions:
  - "Tokens NEVER stored as plaintext in Supabase — Celery task is the encryption boundary; Next.js callback dispatches task with raw tokens as args (plaintext only in process memory + transient Redis queue)"
  - "HMAC state stored in httpOnly cookie (not session/DB) — stateless CSRF protection, 10-min TTL"
  - "prompt=consent forced in OAuth URL — ensures refresh_token returned on re-auth, not just first connect"
  - "Study preference interception in handle_reply before Claude — no second LLM call for a 1-word answer"
  - "forward declaration try/except for gcal_sync_user and gmail_establish_watch_task — tasks.py compiles cleanly before Plans 03/04 add those task names"

patterns-established:
  - "Google integration pattern: initiation route -> callback dispatches Celery task -> task encrypts before DB write"
  - "Token encryption: always call encrypt_token/decrypt_token from google_auth.encryption — never raw Fernet in application code"
  - "SMS study preference: check _STUDY_PREF_KEYWORDS set before Claude intent extraction"

requirements-completed:
  - GCAL-01
  - GMAI-03
  - SYNC-04

duration: 5min
completed: 2026-03-20
---

# Phase 6 Plan 01: Google OAuth Foundation + Encrypted Token Storage Summary

**Fernet-encrypted Google OAuth flow (Calendar + Gmail scopes) with HMAC CSRF, gmail_flags/conflict_alerts DB tables, and first-connect study preference SMS**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-03-20T02:46:19Z
- **Completed:** 2026-03-20T02:51:00Z
- **Tasks:** 2
- **Files modified:** 14

## Accomplishments

- Migration 006 adds `gmail_flags` and `conflict_alerts` tables plus 4 watch channel columns on `integrations` — all downstream Phase 6 plans depend on this schema
- Fernet token encryption module round-trips correctly and is non-deterministic (timestamp-salted); tokens NEVER stored as plaintext in Supabase
- OAuth initiation (HMAC state + httpOnly cookie) and callback (code exchange + Celery dispatch) routes compile cleanly with TypeScript strict mode
- `encrypt_and_store_tokens` Celery task encrypts before DB write, sends confirmation SMS, asks study preference on first connect, and pre-wires GCal/Gmail downstream task stubs
- Study preference interception in `handle_reply` captures morning/afternoon/evening answers before Claude — no extra LLM call

## Task Commits

1. **Task 1: Migration 006 + Token Encryption Module** - `1e72936` (feat — TDD: RED tests first, GREEN implementation)
2. **Task 2: Google OAuth Routes + study preference SMS** - `5139800` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified

- `supabase/migrations/006_google_integrations.sql` - gmail_flags, conflict_alerts tables + watch columns on integrations
- `celery_worker/google_auth/encryption.py` - Fernet encrypt_token/decrypt_token using TOKEN_ENCRYPTION_KEY
- `celery_worker/google_auth/tokens.py` - store_google_tokens/load_google_tokens (always encrypted)
- `celery_worker/tests/google_auth/test_encryption.py` - 4 tests: round-trip, non-deterministic, not-plaintext
- `celery_worker/tests/google_auth/test_tokens.py` - 3 tests: encrypted storage, decrypted load, None for missing user
- `src/app/api/auth/google/route.ts` - OAuth initiation with HMAC state, calendar + gmail.readonly scopes
- `src/app/api/auth/google/callback/route.ts` - Code exchange, CSRF validation, Celery task dispatch (no plaintext DB write)
- `celery_worker/tasks.py` - Added encrypt_and_store_tokens Celery task (priority=9)
- `celery_worker/ai/replies.py` - Added _handle_study_preference_reply + interception before Claude
- `celery_worker/requirements.txt` - Added cryptography, google libs, rapidfuzz
- `celery_worker/requirements-dev.txt` - Added fakeredis

## Decisions Made

- Tokens NEVER at rest unencrypted: Celery task is the encryption boundary. Next.js callback dispatches `encrypt_and_store_tokens` with raw tokens as task args — they exist as plaintext only in the Next.js process memory and transiently in the Redis task queue (encrypted before Supabase write).
- `prompt=consent` forced in OAuth URL to ensure Google always returns a `refresh_token` (not just on first connect).
- HMAC state in httpOnly cookie is stateless CSRF protection — no DB round-trip needed.
- Study preference interception happens before Claude intent extraction — avoids a second LLM call for a 1-word answer.
- Forward declaration try/except for `gcal_sync_user` / `gmail_establish_watch_task` — `tasks.py` compiles before Plans 03/04 register those task names.

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

External services require manual configuration before this plan's routes work end-to-end:

**Environment variables to add:**

| Variable | Source |
|---|---|
| `GOOGLE_CLIENT_ID` | Google Cloud Console -> APIs & Services -> Credentials -> OAuth 2.0 Client ID |
| `GOOGLE_CLIENT_SECRET` | Google Cloud Console -> APIs & Services -> Credentials -> OAuth 2.0 Client ID |
| `GOOGLE_REDIRECT_URI` | Set to `https://[your-domain]/api/auth/google/callback` |
| `TOKEN_ENCRYPTION_KEY` | Generate: `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` |
| `APP_BASE_URL` | Production URL (e.g., `https://aria.vercel.app`) — needed for GCal webhook in Plan 03 |

**Google Cloud Console configuration:**

1. Enable Google Calendar API and Gmail API in APIs & Services -> Library
2. Add Calendar + Gmail scopes to OAuth consent screen in APIs & Services -> OAuth consent screen
3. Add `https://[your-domain]/api/auth/google/callback` as authorized redirect URI

**Run migration:**

```bash
npx supabase db push
```

## Next Phase Readiness

- Plan 02 (GCal sync): `load_google_tokens` is available. `calendar_events` table exists from migration 001. Watch columns (`channel_id`, `resource_id`, `watch_expires_at`) are ready on `integrations`.
- Plan 03 (Gmail watch): `load_google_tokens` ready. `gmail_flags` table ready. `history_id` column ready on `integrations`.
- Plan 04 (conflict detection): `conflict_alerts` table ready with dedup UNIQUE constraint.
- All downstream plans can reference `google_auth.tokens` for encrypted token access.

---
*Phase: 06-google-oauth-gcal-gmail-alerts-conflict-detection*
*Completed: 2026-03-20*
