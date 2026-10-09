# Phase 6: Google OAuth + GCal + Gmail + Alerts + Conflict Detection - Research

**Researched:** 2026-03-20
**Domain:** Google APIs (Calendar v3, Gmail v1), OAuth 2.0, push notifications, Redis SMS batching
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Gmail Sender Identification**
- Monitor all senders with `.edu` email domains — no user-provided professor list required
- When a `.edu` email arrives, Claude Haiku reads subject + body snippet → JSON: `{is_deadline_change: bool, confidence: float}`
- Alert threshold: `confidence >= 0.8 AND is_deadline_change = true` → fire alert; else log to `gmail_flags` only
- `gmail_flags` schema: `subject`, `sender`, `flagged_at`, `summary` — full email content NEVER stored
- Cross-reference (GMAI-05): fuzzy-match email subject against `deadlines.title`/`deadlines.course`; if match + different due date → fire ALRT-02

**Google OAuth Entry Point**
- Magic-link flow: Aria SMS → `/api/auth/google?user_id=...` → standard Google OAuth → tokens stored
- Callback stores access_token + refresh_token encrypted in `integrations` table (platform = 'google')
- On callback success: (1) store tokens, (2) GCal backfill task, (3) Gmail watch channel, (4) confirmation SMS
- Phase 8 (Seb) wraps same route with UI button — no backend changes needed

**Token Refresh**
- Check if `access_token` expires within 5 minutes before every API call; refresh if so
- Logic inlined in each sync task — no separate Beat job
- Refresh tokens stored encrypted at rest (AES-256)

**GCal Sync Scope**
- 7-day forward rolling window (today → +7 days)
- Skip `responseStatus = 'declined'` and `transparency = 'transparent'` events
- Sync trigger: GCal push notification webhook (`/api/gcal/webhook`) → immediate Celery task
- Push channel renewed 48 hours before 7-day expiry via Celery Beat (SYNC-04)

**Conflict Detection**
- Definition: Canvas deadline `due_date` falls on same calendar day as a "busy" GCal event
- Conflict SMS: warn + offer study block
- Timing: Run after every `canvas_sync_user` AND after every `gcal_sync_user`
- Deduplication: `conflict_alerts` table keyed to `(deadline_id, gcal_event_id)` — fire once per pair; re-fire if dates change

**GCal Write-Back (GCAL-05)**
- Title + duration + day from user SMS; find gap ≥ requested duration in waking hours (7am–10pm)
- Prefer `preferences_json.study_preference` (evening/afternoon/morning); default: evening (6–9pm)
- Ask preference via SMS on first Google connect
- Undo support: "Reply 'undo' to remove it"

**SMS Batching (SMS-10, SMS-11)**
- Multiple alerts within 10 minutes → one batched SMS (numbered list sorted by priority score desc)
- Redis hold queue with 10-minute TTL per user; flush Celery task at TTL expiry
- Max 3 texts per 10-minute window enforced by same batching layer

**Monday Briefing Enrichment (AI-08 full)**
- Conflict warnings + available study windows (gaps ≥ 2 hours in 7am–10pm, user's study_preference)
- Study windows computed deterministically from `calendar_events` table (not via Claude)

### Claude's Discretion
- Exact Haiku prompt wording for email classification
- Fuzzy match algorithm (Levenshtein vs. substring)
- Encryption implementation (library choice, key storage)
- Exact Redis key schema for batch queues
- `conflict_alerts` table schema (new migration)
- Error handling when Gmail watch channel setup fails

### Deferred Ideas (OUT OF SCOPE)
- Study gap analysis (Phase 7)
- Discord integration (post-v1)
- GCAL-05 bulk study schedule (future)
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| GCAL-01 | Fetch GCal events (7-day rolling window) via OAuth | Google Calendar API events.list with timeMin/timeMax; google-api-python-client 2.193.0 |
| GCAL-02 | Calendar events normalized to CalendarEvent type, stored in Supabase | Existing `calendar_events` table already has all columns; ingest via `ingest_canonical_event()` for canonical_events |
| GCAL-03 | GCal push notification channel for real-time change detection | events().watch() API; webhook receives X-Goog headers; must do full events.list after notification |
| GCAL-04 | GCal push channel renewed before 7-day expiry | Celery Beat cron checks expiry, calls watch() with new UUID; stop old channel first |
| GCAL-05 | Study blocks written to GCal via SMS | events().insert() with dateTime body; find free slots in calendar_events gaps |
| GMAI-01 | Monitor Gmail for .edu sender emails | Gmail API users.watch() + Pub/Sub OR webhook; filter by INBOX label |
| GMAI-02 | Keyword/Claude detection of deadline changes | Claude Haiku call with subject + snippet; returns {is_deadline_change, confidence} |
| GMAI-03 | Gmail signals stored in gmail_flags table (metadata only) | New migration 006 adds gmail_flags table |
| GMAI-04 | Gmail watch channel renewed before 7-day expiry | Same Beat pattern as GCAL-04; users.watch() call every 6 days |
| GMAI-05 | Gmail signals cross-referenced against Canvas state | rapidfuzz token_set_ratio against deadlines.title/course; threshold ~70 |
| ALRT-01 | Deadline change alert within 15 minutes of Canvas diff | Existing canvas_sync_user → ingest_canonical_event → send_priority_alert path already achieves this |
| ALRT-02 | Gmail contradiction alert when email conflicts with Canvas deadline | New Celery task: gmail_process_email → classify → fuzzy match → send_sms_alert |
| ALRT-03 | Alert SMS includes original deadline, new deadline, course, title | Message format defined in CONTEXT.md; use send_sms_alert (bypass quiet hours) |
| INTEL-03 | Conflict detection: Canvas deadline overlaps GCal event, offer resolution via SMS | New detect_conflicts_user task; writes to conflict_alerts; sends SMS offer |
| SMS-10 | Multiple alerts within 10 minutes batched into one SMS | Redis LPUSH/EXPIRE + flush Celery task applied_at TTL expiry |
| SMS-11 | Max 3 texts in any 10-minute window | Same Redis batch layer counts texts per window before flushing |
| SYNC-03 | GCal push notification handler processes changes in real time | /api/gcal/webhook Next.js route → Celery gcal_sync_user.delay() |
| SYNC-04 | GCal and Gmail watch channels renewed via Celery Beat (48h before expiry) | Beat schedule entry; renewal tasks check integrations.watch_expires_at |
| AI-08 (full) | Monday briefing enriched with GCal conflicts + study windows when GCal connected | Pass conflict list + free_slots list into generate_briefing(); extend prompt |
</phase_requirements>

---

## Summary

Phase 6 wires Google Calendar and Gmail into Aria's existing Celery/Supabase pipeline. The core challenge is operating two fundamentally different push notification systems (GCal webhooks vs. Gmail Pub/Sub) and combining their signals with the already-working Canvas diff engine to fire coherent, batched alerts within 15 minutes.

GCal push notifications are straightforward: Google POSTs to `/api/gcal/webhook` with no body — only X-Goog headers. The webhook returns 200 immediately, enqueues `gcal_sync_user`, which calls `events.list()` for the full 7-day window and writes to `calendar_events` + `canonical_events`. The existing `ingest_canonical_event()` entry point handles scoring and immediate alert dispatch for high-priority items.

Gmail push notifications require Google Cloud Pub/Sub as middleware — unlike GCal which pushes directly to your HTTPS endpoint. The Gmail notification delivers a Base64-encoded historyId; the worker then calls `users.history.list()` to fetch new messages, retrieves metadata (subject + sender only), and classifies with Claude Haiku. The architectural gap is that Gmail requires a Pub/Sub topic and subscription setup in Google Cloud Console — this is a one-time infrastructure step, not code.

The SMS batching layer (Redis hold queue + flush task) and conflict deduplication table are the two wholly new subsystems in this phase. Both are straightforward to implement with the existing Redis connection and Supabase client already in place.

**Primary recommendation:** Build in this order — (1) OAuth flow + token storage + encryption, (2) GCal sync + push webhook + conflict detection, (3) Gmail Pub/Sub + classification, (4) SMS batching layer, (5) Monday briefing enrichment. GCal is independent of Gmail and can be tested end-to-end first.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| google-api-python-client | 2.193.0 | GCal + Gmail REST API calls | Official Google client; discovery-based, covers all Google APIs |
| google-auth | 2.x | OAuth2 credentials + token refresh | Official auth library; handles refresh_token flow automatically |
| google-auth-oauthlib | 1.3.0 | OAuth2 authorization code flow in server apps | Official oauthlib integration; handles authorization URL construction |
| cryptography | 46.0.5 (already installed) | AES token encryption via Fernet | Already in environment; Fernet = AES-128-CBC + HMAC-SHA256, sufficient for OAuth tokens |
| rapidfuzz | latest (~3.x) | Fuzzy string matching for Gmail→Canvas cross-reference | MIT license; 10–100x faster than thefuzz; same API surface |
| redis-py | already in requirements | Redis hold queue for SMS batching | Already used as Celery broker; add direct redis-py calls for batch queue |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| google-cloud-pubsub | 2.x | Gmail push notifications via Pub/Sub | Required for Gmail watch; Pub/Sub is mandatory middleware for Gmail API push |
| google-auth-httplib2 | 0.2.x | httplib2 transport for google-api-python-client | Required when building service from credentials; alternative: google-auth-requests |

**Note on gmail Pub/Sub architecture:** Gmail does NOT push directly to your webhook like GCal does. The flow is: Gmail → Google Cloud Pub/Sub topic → your subscription endpoint. You create a Pub/Sub topic, grant gmail-api-push@system.gserviceaccount.com publish rights, then call `users.watch(topicName=...)`. Pub/Sub then forwards notifications to `/api/gmail/webhook`.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| google-api-python-client | requests + raw HTTP | Hand-rolling auth headers, token refresh, retry logic — never worth it |
| rapidfuzz | thefuzz (FuzzyWuzzy) | thefuzz is GPL-licensed and 10x slower; rapidfuzz is drop-in replacement |
| Fernet (cryptography) | PyNaCl / custom AES | Fernet is already installed; handles IV, padding, HMAC automatically |
| Pub/Sub push subscription | Pub/Sub pull subscription | Pull requires polling loop; push is simpler with existing webhook pattern |

**Installation:**
```bash
pip install google-api-python-client google-auth google-auth-oauthlib google-auth-httplib2 google-cloud-pubsub rapidfuzz
```

**Version verification:**
```bash
pip index versions google-api-python-client  # 2.193.0 as of 2026-03-19
pip index versions google-auth-oauthlib      # 1.3.0 as of 2026-03-19
```

---

## Architecture Patterns

### Recommended Module Structure
```
celery_worker/
├── gcal/
│   ├── __init__.py
│   ├── auth.py          # build_gcal_service(user_id): handles token load + refresh
│   ├── fetch.py         # fetch_gcal_events(user_id, days=7): events.list() call
│   ├── watch.py         # establish_watch(user_id), renew_watch(user_id), stop_watch()
│   ├── writeback.py     # create_study_block(user_id, title, start, end): events.insert()
│   └── db.py            # get/store google tokens, calendar_events CRUD
├── gmail/
│   ├── __init__.py
│   ├── auth.py          # build_gmail_service(user_id): same token pattern as gcal/auth.py
│   ├── watch.py         # establish_gmail_watch(user_id), renew_gmail_watch(user_id)
│   ├── fetch.py         # fetch_new_messages(user_id, history_id): users.history.list()
│   └── classify.py      # classify_email(subject, snippet): Claude Haiku call → JSON
├── sms/
│   └── batch.py         # NEW: redis_enqueue_alert(user_id, text, priority), flush_batch(user_id)
└── tasks.py             # add: gcal_sync_all, gcal_sync_user, gmail_watch_all,
                         #      gmail_process_email, detect_conflicts_user,
                         #      renew_watch_channels, flush_sms_batch
src/app/api/
├── auth/
│   └── google/
│       ├── route.ts            # GET: redirect to Google OAuth URL
│       └── callback/route.ts   # GET: exchange code, store tokens, trigger sync
├── gcal/
│   └── webhook/route.ts        # POST: GCal push notification receiver
└── gmail/
    └── webhook/route.ts        # POST: Pub/Sub push subscription receiver
supabase/migrations/
└── 006_google_integrations.sql  # gmail_flags, conflict_alerts, watch_channel cols
```

### Pattern 1: Token Load + Refresh (inline, every API call)
**What:** Before each GCal or Gmail API call, load the stored token, check if it expires within 5 minutes, refresh if needed, write back if refreshed.
**When to use:** Every function that builds a Google API service object.
**Example:**
```python
# Source: google-auth-oauthlib official docs pattern
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build

def build_gcal_service(user_id: str):
    creds_data = load_google_tokens(user_id)  # from integrations table, decrypted
    creds = Credentials(
        token=creds_data["access_token"],
        refresh_token=creds_data["refresh_token"],
        token_uri="https://oauth2.googleapis.com/token",
        client_id=os.environ["GOOGLE_CLIENT_ID"],
        client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
    )
    if creds.expired or creds.expiry and (creds.expiry - datetime.now(timezone.utc)).total_seconds() < 300:
        creds.refresh(Request())
        store_google_tokens(user_id, creds.token, creds.refresh_token)
    return build("calendar", "v3", credentials=creds)
```

### Pattern 2: GCal Push Watch Setup
**What:** Register a webhook channel that Google calls on any calendar change. Returns a channel_id and resource_id needed for later stop/renewal.
**When to use:** On OAuth callback (initial) and 48h before 7-day expiry (renewal).
```python
# Source: developers.google.com/workspace/calendar/api/guides/push
import uuid

def establish_watch(user_id: str, service) -> dict:
    channel_id = str(uuid.uuid4())
    body = {
        "id": channel_id,
        "type": "web_hook",
        "address": f"{os.environ['APP_BASE_URL']}/api/gcal/webhook",
        "token": user_id,  # passed back in X-Goog-Channel-Token header
        "expiration": int((datetime.now(timezone.utc) + timedelta(days=7)).timestamp() * 1000),
    }
    result = service.events().watch(calendarId="primary", body=body).execute()
    # Store result["id"], result["resourceId"], result["expiration"] in integrations
    return result
```

### Pattern 3: GCal Webhook → Celery Fan-Out
**What:** The Next.js webhook returns 200 immediately and enqueues the Celery task. The webhook payload has NO body — only headers.
**When to use:** `/api/gcal/webhook` route.
```typescript
// Source: GCal push notification docs + existing canvas webhook pattern
export async function POST(request: Request) {
  const channelToken = request.headers.get('x-goog-channel-token') // this is user_id
  const resourceState = request.headers.get('x-goog-resource-state')
  if (resourceState === 'sync') {
    // Initial handshake — just return 200, no work needed
    return NextResponse.json({ ok: true })
  }
  // Enqueue Celery task for actual sync (via Redis publish)
  // gcal_sync_user.delay(user_id)
  return NextResponse.json({ ok: true }, { status: 200 })
}
```

### Pattern 4: Gmail Pub/Sub Notification → historyId → messages
**What:** Gmail sends a Base64-encoded JSON to your Pub/Sub endpoint. Decode it to get historyId, then call users.history.list() to find new messages.
**When to use:** `/api/gmail/webhook` route processing.
```python
# Source: developers.google.com/workspace/gmail/api/guides/push
import base64, json

def decode_pubsub_message(data: str) -> dict:
    """Decode base64url Pub/Sub data field → {emailAddress, historyId}"""
    return json.loads(base64.urlsafe_b64decode(data + "==").decode())

def fetch_new_messages(user_id: str, service, start_history_id: str) -> list[dict]:
    """Get messages added since start_history_id. Returns list of {subject, sender, snippet}."""
    result = service.users().history().list(
        userId="me",
        startHistoryId=start_history_id,
        historyTypes=["messageAdded"],
        labelId="INBOX",
    ).execute()
    messages = []
    for history in result.get("history", []):
        for msg_added in history.get("messagesAdded", []):
            msg_id = msg_added["message"]["id"]
            # Fetch metadata only — NEVER store full body
            msg = service.users().messages().get(
                userId="me", id=msg_id, format="metadata",
                metadataHeaders=["From", "Subject"]
            ).execute()
            messages.append(msg)
    return messages
```

### Pattern 5: SMS Batch Queue (Redis)
**What:** Hold alerts for a user for 10 minutes, then flush to one SMS.
**When to use:** Every alert that goes through Phase 6 alert paths.
```python
# Source: redis-py docs pattern; existing REDIS_URL already in celery_app.py
import redis, json

BATCH_TTL = 600  # 10 minutes in seconds

def redis_enqueue_alert(user_id: str, text: str, priority_score: int) -> bool:
    """Add alert to user's hold queue. Returns True if this is the first item (need to schedule flush)."""
    r = redis.from_url(os.environ["REDIS_URL"])
    key = f"sms_batch:{user_id}"
    item = json.dumps({"text": text, "priority": priority_score})
    is_new = r.llen(key) == 0
    r.rpush(key, item)
    r.expire(key, BATCH_TTL)
    return is_new  # caller schedules flush_sms_batch.apply_async(countdown=600) if True

def flush_sms_batch(user_id: str):
    """Pop all items from queue, sort by priority desc, send one combined SMS."""
    r = redis.from_url(os.environ["REDIS_URL"])
    key = f"sms_batch:{user_id}"
    raw_items = r.lrange(key, 0, -1)
    r.delete(key)
    if not raw_items:
        return
    items = sorted([json.loads(i) for i in raw_items], key=lambda x: x["priority"], reverse=True)
    # Enforce SMS-11: max 3 per 10-min window
    items = items[:3]
    if len(items) == 1:
        body = items[0]["text"]
    else:
        lines = "\n".join(f"{i+1}) {item['text']}" for i, item in enumerate(items))
        body = f"{len(items)} updates:\n{lines}"
    # send via send_sms_alert(user_id, phone, body)
```

### Pattern 6: Token Encryption (Fernet)
**What:** Encrypt OAuth tokens before storing in Supabase; decrypt on load.
**When to use:** All reads/writes to integrations.access_token and integrations.refresh_token.
```python
# Source: cryptography.io/en/latest/fernet/
from cryptography.fernet import Fernet

def get_fernet() -> Fernet:
    key = os.environ["TOKEN_ENCRYPTION_KEY"]  # 32 URL-safe base64 bytes; generate with Fernet.generate_key()
    return Fernet(key)

def encrypt_token(token: str) -> str:
    return get_fernet().encrypt(token.encode()).decode()

def decrypt_token(encrypted: str) -> str:
    return get_fernet().decrypt(encrypted.encode()).decode()
```

### Pattern 7: Conflict Detection
**What:** After each GCal or Canvas sync for a user, check if any Canvas deadline's date matches any busy GCal event's date. Deduplicate via conflict_alerts table.
**When to use:** End of `canvas_sync_user` and `gcal_sync_user`.
```python
def detect_conflicts_user(user_id: str):
    """Find Canvas deadlines whose due_date (local day) overlaps any busy GCal event."""
    client = _get_supabase()
    deadlines = client.table("deadlines").select("id,title,due_date,course").eq("user_id", user_id).is_("deleted_at", "null").execute().data
    events = client.table("calendar_events").select("id,title,start_time,end_time").eq("user_id", user_id).execute().data
    for d in deadlines:
        d_day = datetime.fromisoformat(d["due_date"]).date()
        for e in events:
            e_day = datetime.fromisoformat(e["start_time"]).date()
            if d_day == e_day:
                # Check if already fired for this pair
                existing = client.table("conflict_alerts").select("id").eq("user_id", user_id).eq("deadline_id", d["id"]).eq("gcal_event_id", e["id"]).execute().data
                if not existing:
                    _fire_conflict_alert(user_id, d, e)
                    client.table("conflict_alerts").insert({...}).execute()
```

### Anti-Patterns to Avoid
- **Storing full Gmail bodies:** Only store subject, sender, flagged_at, summary in gmail_flags — never body text. This is a locked decision and FERPA-adjacent privacy requirement.
- **Blocking Next.js webhook on Celery result:** Both `/api/gcal/webhook` and `/api/gmail/webhook` must return 200 within ~1 second or Google will retry and eventually expire the channel. Use `.delay()` not `.apply()`.
- **Calling events.list() on every Beat tick instead of using push:** Using only polling without push channels would miss the 15-minute ALRT-01 requirement entirely.
- **Using syncToken with timeMin/timeMax filters together:** These are mutually exclusive. After a push notification, do a fresh events.list() with timeMin/timeMax (not syncToken) for the 7-day window. syncToken is for full incremental sync — store it per user but use only for delta requests after initial full fetch.
- **Creating a new OAuth client for Gmail vs GCal:** Both scopes live on the same Google OAuth client (CLAUDE.md constraint). One auth flow, two scopes.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Token refresh logic | Custom HTTP POST to token endpoint | `google.oauth2.credentials.Credentials.refresh(Request())` | Handles expiry detection, retry, token update automatically |
| OAuth authorization URL | String formatting with params | `google_auth_oauthlib.flow.Flow.from_client_config().authorization_url()` | Handles state param, PKCE, scope encoding |
| Fuzzy string matching | Levenshtein distance from scratch | `rapidfuzz.fuzz.token_set_ratio()` | Edge cases in Unicode, partial word matching — 3 lines vs 50+ |
| Token encryption | Custom AES implementation | `cryptography.fernet.Fernet` | Handles IV, padding, HMAC authentication — 3 lines vs days of crypto work |
| Pub/Sub message parsing | Custom base64 + JSON | One-liner in `decode_pubsub_message()` using standard library | The encoding is documented and fixed; no library needed but no custom logic either |
| Watch channel UUID generation | Timestamp-based IDs | `uuid.uuid4()` | Google requires unique IDs up to 64 chars; UUID4 is the stated best practice |

**Key insight:** Google's Python client library handles the hardest parts (credential lifecycle, API retry, schema validation). The risk is in the orchestration and state management (syncToken storage, channel renewal, Redis batching) — build carefully there.

---

## Common Pitfalls

### Pitfall 1: GCal Webhook Has No Body
**What goes wrong:** Code tries to parse request body for changed event details — gets empty body, crashes or misses changes.
**Why it happens:** GCal push notifications only send HTTP headers (`X-Goog-*`). The specification says "Notification messages do not include a message body."
**How to avoid:** On receiving webhook, ONLY read `X-Goog-Resource-State` and `X-Goog-Channel-Token`. Then call `events.list()` for the full 7-day window. Do not try to extract event details from the webhook.
**Warning signs:** Webhook handler trying to `request.json()` or `request.body()`.

### Pitfall 2: Gmail Requires Pub/Sub (Not Direct Webhook)
**What goes wrong:** Developer tries to set a direct HTTPS URL in Gmail watch() — the call fails with a validation error.
**Why it happens:** Unlike GCal, Gmail push requires a Google Cloud Pub/Sub topic as intermediary. The Gmail API only accepts Pub/Sub topic names in watch().
**How to avoid:** Create Pub/Sub topic → create push subscription pointing to `/api/gmail/webhook` → grant gmail-api-push@system.gserviceaccount.com publish rights → THEN call users.watch(topicName=...).
**Warning signs:** Trying to set `address` in Gmail watch body (that's GCal's API, not Gmail's).

### Pitfall 3: historyId Staleness
**What goes wrong:** Gmail processing fetches messages from the wrong historyId and misses emails or double-processes.
**Why it happens:** The `historyId` in the Pub/Sub notification is the state AFTER the change. Must use the PREVIOUS stored historyId as `startHistoryId` in history.list().
**How to avoid:** Store the last processed historyId per user in the integrations table (or a gmail_state table). On each notification, use stored value as startHistoryId, then update stored value to the new historyId.
**Warning signs:** Calling history.list with the historyId FROM the notification as startHistoryId (gives empty result or misses messages).

### Pitfall 4: Watch Channel Expiry (GCal 7 days, Gmail 7 days)
**What goes wrong:** Push notifications silently stop after 7 days; no alerts fire; nobody notices until users report missing updates.
**Why it happens:** Neither GCal nor Gmail auto-renew channels. Channels expire with no notification.
**How to avoid:** Store `watch_expires_at` in integrations table. Beat job runs daily, checks if any channel expires within 48 hours, and calls watch() with a new UUID to replace it. Stop old channel first using `channels.stop()`.
**Warning signs:** alerts.delivered_count dropping to 0 without corresponding quiet period.

### Pitfall 5: 410 GONE on syncToken
**What goes wrong:** After a long period of inactivity or an ACL change, events.list() with syncToken returns 410 GONE.
**Why it happens:** Google invalidates syncTokens after some period or when calendar permissions change.
**How to avoid:** Wrap every syncToken-based call in a try/except for `HttpError 410`. On 410: clear local syncToken, do a fresh full events.list() with timeMin/timeMax, store new nextSyncToken. For the 7-day rolling window pattern in this phase, just redo the full fetch (no syncToken) — simpler and avoids this pitfall entirely.
**Warning signs:** Unhandled 410 errors in Celery worker logs.

### Pitfall 6: Redis SMS Batch Race Condition
**What goes wrong:** Two Celery workers simultaneously enqueue alerts for the same user; both see `is_new = True`; two flush tasks are scheduled; user gets duplicate SMS.
**Why it happens:** `llen() == 0` check followed by `rpush()` is not atomic.
**How to avoid:** Use a Redis SET NX (set if not exists) key as the "flush scheduled" lock rather than checking llen. Only the worker that successfully sets the lock schedules the flush task.
**Warning signs:** Users reporting duplicate batch messages.

### Pitfall 7: OAuth CSRF via Missing State Validation
**What goes wrong:** Attacker constructs a callback URL and tricks a user's browser into completing an OAuth flow that attaches the attacker's Google account.
**Why it happens:** The `state` parameter must be verified in the callback but is easy to forget.
**How to avoid:** In `/api/auth/google`, generate a state = `hmac(user_id + random_nonce, SECRET_KEY)`, store in a signed HTTP-only cookie. In `/api/auth/google/callback`, verify the state parameter matches before exchanging the code.
**Warning signs:** Callback handler that doesn't validate request.nextUrl.searchParams.get('state').

### Pitfall 8: Pub/Sub Domain Verification for Push Subscriptions
**What goes wrong:** Pub/Sub rejects push subscription creation because the endpoint domain isn't verified.
**Why it happens:** Google Cloud Pub/Sub requires domain verification for HTTPS push endpoints in production.
**How to avoid:** In development, use pull subscriptions (poll from worker) instead of push. In production (Vercel), add the Vercel domain to Google Search Console for verification, or use a Pub/Sub push subscription on a Railway subdomain.
**Warning signs:** Push subscription creation fails with "Invalid URL" or "domain not verified" error.

---

## Code Examples

Verified patterns from official sources:

### OAuth Flow: Authorization URL Construction
```python
# Source: Using OAuth 2.0 for Web Server Applications (Google Developers)
from google_auth_oauthlib.flow import Flow

SCOPES = [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/gmail.readonly",
]

def build_oauth_flow() -> Flow:
    client_config = {
        "web": {
            "client_id": os.environ["GOOGLE_CLIENT_ID"],
            "client_secret": os.environ["GOOGLE_CLIENT_SECRET"],
            "redirect_uris": [os.environ["GOOGLE_REDIRECT_URI"]],
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
        }
    }
    flow = Flow.from_client_config(client_config, scopes=SCOPES)
    flow.redirect_uri = os.environ["GOOGLE_REDIRECT_URI"]
    return flow

# In /api/auth/google route:
# flow = build_oauth_flow()
# auth_url, state = flow.authorization_url(access_type="offline", prompt="consent")
# Store state in cookie, redirect user to auth_url
```

### GCal Events List (7-day window)
```python
# Source: Events: list | Google Calendar | Google for Developers
from datetime import datetime, timezone, timedelta

def fetch_gcal_events(user_id: str) -> list[dict]:
    service = build_gcal_service(user_id)
    now = datetime.now(timezone.utc)
    time_max = now + timedelta(days=7)
    events_result = service.events().list(
        calendarId="primary",
        timeMin=now.isoformat(),
        timeMax=time_max.isoformat(),
        singleEvents=True,
        orderBy="startTime",
        showDeleted=False,
    ).execute()
    items = events_result.get("items", [])
    # Filter declined and transparent events
    return [
        e for e in items
        if e.get("transparency") != "transparent"
        and e.get("attendees") is None
        or not any(
            a.get("self") and a.get("responseStatus") == "declined"
            for a in (e.get("attendees") or [])
        )
    ]
```

### GCal Event Insert (Study Block)
```python
# Source: Create events | Google Calendar | Google for Developers
def create_study_block(user_id: str, title: str, start_dt: datetime, end_dt: datetime) -> str:
    service = build_gcal_service(user_id)
    event = {
        "summary": title,
        "start": {"dateTime": start_dt.isoformat(), "timeZone": "UTC"},
        "end": {"dateTime": end_dt.isoformat(), "timeZone": "UTC"},
    }
    created = service.events().insert(calendarId="primary", body=event).execute()
    return created["id"]  # store for undo support
```

### Claude Haiku Email Classification
```python
# Source: Anthropic Python SDK; model per CLAUDE.md
import json
from anthropic import Anthropic

HAIKU_SYSTEM = """You classify professor emails for a college student assistant.
Output ONLY valid JSON: {"is_deadline_change": bool, "confidence": float}
Confidence 0.0–1.0. High confidence if email explicitly mentions new date/extension/cancellation."""

def classify_email(subject: str, snippet: str) -> dict:
    client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    user_content = f"Subject: {subject}\n\nEmail preview: {snippet}"
    response = client.messages.create(
        model="claude-haiku-4-5-20251001",  # per CLAUDE.md
        max_tokens=64,
        system=HAIKU_SYSTEM,
        messages=[{"role": "user", "content": user_content}],
    )
    return json.loads(response.content[0].text)
```

### rapidfuzz Fuzzy Match (Gmail → Canvas)
```python
# Source: rapidfuzz docs; MIT license
from rapidfuzz import fuzz

def find_matching_deadline(email_subject: str, deadlines: list[dict]) -> dict | None:
    """Return best-matching deadline if score >= 70, else None."""
    best_score = 0
    best_match = None
    for d in deadlines:
        # token_set_ratio handles word-order differences ("Bio Lab Report" vs "Report for Bio Lab")
        score = fuzz.token_set_ratio(email_subject.lower(), d["title"].lower())
        if score > best_score:
            best_score = score
            best_match = d
    return best_match if best_score >= 70 else None
```

---

## Migration 006 Design

New tables required for Phase 6 (migration number follows 005_canonical_events.sql):

```sql
-- gmail_flags: metadata from .edu emails flagged by Claude Haiku
-- Full email content NEVER stored (locked decision)
CREATE TABLE public.gmail_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  sender TEXT NOT NULL,
  flagged_at TIMESTAMPTZ DEFAULT now(),
  summary TEXT,           -- Claude Haiku's one-line summary
  confidence NUMERIC,     -- classification confidence (0.0–1.0)
  matched_deadline_id UUID REFERENCES public.deadlines(id)
);

-- conflict_alerts: deduplication for conflict detection
-- Keyed to (user_id, deadline_id, gcal_event_id) — fire once per pair
CREATE TABLE public.conflict_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  deadline_id UUID NOT NULL REFERENCES public.deadlines(id),
  gcal_event_id TEXT NOT NULL,   -- google_event_id from calendar_events
  fired_at TIMESTAMPTZ DEFAULT now(),
  deadline_due_at TIMESTAMPTZ,   -- snapshot at time of alert (for re-fire detection)
  gcal_event_date DATE,          -- snapshot at time of alert
  UNIQUE (user_id, deadline_id, gcal_event_id)
);

-- Add watch channel columns to integrations (for renewal tracking)
ALTER TABLE public.integrations
  ADD COLUMN IF NOT EXISTS channel_id TEXT,
  ADD COLUMN IF NOT EXISTS resource_id TEXT,
  ADD COLUMN IF NOT EXISTS watch_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS history_id TEXT;  -- last processed Gmail historyId
```

Also need `TOKEN_ENCRYPTION_KEY` added to environment variables (32-byte Fernet key, base64).

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| FuzzyWuzzy for string matching | rapidfuzz | 2021 (rename to thefuzz) + rapidfuzz adoption | MIT license, 10x faster, same API |
| Polling Gmail for new messages | Gmail API push via Pub/Sub + history.list() | 2013+ | Near-real-time; no wasted API calls |
| GCal polling every N minutes | GCal push notification channels | 2013+ | Meets 15-min alert window; no wasted calls |
| google-auth-helpers (deprecated Next.js) | @supabase/ssr (already used in project) | Phase 1 decision | Already resolved |

**Deprecated/outdated:**
- `google.oauth2.service_account` — for service accounts only; this project uses user OAuth, use `google.oauth2.credentials.Credentials` instead
- `oauth2client` — deprecated in favor of `google-auth`; never use

---

## Infrastructure Prerequisites

These are NOT code tasks but must be completed before Phase 6 can work end-to-end:

1. **Google Cloud Console — OAuth scopes:** Ensure `https://www.googleapis.com/auth/calendar` and `https://www.googleapis.com/auth/gmail.readonly` are added to the OAuth consent screen. Gmail readonly is a **sensitive scope** and requires Google verification (1–6 weeks). Start this immediately.

2. **Google Cloud Pub/Sub topic:** Create a topic (e.g., `aria-gmail-notifications`) in the same GCP project. Grant `gmail-api-push@system.gserviceaccount.com` the Pub/Sub Publisher role on that topic.

3. **Pub/Sub push subscription:** Create a push subscription pointing to `https://[production-domain]/api/gmail/webhook`. Domain must be verified in Google Search Console. For development/testing, use a pull subscription and add a local polling loop, or use ngrok with a push subscription.

4. **TOKEN_ENCRYPTION_KEY env var:** Generate with `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`. Add to Railway env vars.

5. **APP_BASE_URL env var:** Required by GCal watch channel address. Set to production URL (Vercel) for GCal webhook target.

---

## Open Questions

1. **Gmail Pub/Sub in development**
   - What we know: Production push works via Google Cloud Pub/Sub + push subscription to HTTPS endpoint. Development requires HTTPS with valid SSL.
   - What's unclear: Best dev workflow — ngrok (temporary) vs. always using pull subscription in development vs. a test harness that manually calls `/api/gmail/webhook`.
   - Recommendation: Use pull subscription for local dev; switch to push subscription for staging/prod. Add a `celery_worker/gmail/pull_dev.py` dev-only polling script.

2. **GCal webhook authentication**
   - What we know: Google does not sign webhook payloads. The `X-Goog-Channel-Token` header is the only identifier, which we set to `user_id` in the watch body.
   - What's unclear: Whether channel-token-as-user-id is sufficient or whether additional HMAC verification should be added.
   - Recommendation: Store channel_id → user_id mapping in the integrations table and verify channel_id matches the expected user rather than trusting the token alone.

3. **SMS batching and send_sms_alert interaction**
   - What we know: `send_sms_alert` bypasses quiet hours and daily cap. The batch layer sits before the actual send call.
   - What's unclear: Whether the batch layer should also bypass quiet hours on flush, or respect them.
   - Recommendation: Batch flush should use `send_sms_alert` (bypass quiet hours) since all items in the batch queue were already scored as high-priority (score >= 80). ALRT-01 15-minute window takes precedence over quiet hours.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | pytest (already configured) |
| Config file | `celery_worker/pytest.ini` |
| Quick run command | `cd celery_worker && python -m pytest tests/ -x -q` |
| Full suite command | `cd celery_worker && python -m pytest tests/ -v` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| GCAL-01 | fetch_gcal_events returns normalized events | unit | `pytest tests/gcal/test_fetch.py -x` | ❌ Wave 0 |
| GCAL-02 | GCal events written to calendar_events + canonical_events | unit | `pytest tests/gcal/test_db.py -x` | ❌ Wave 0 |
| GCAL-03 | /api/gcal/webhook returns 200 and enqueues task | unit | Next.js route test (manual/smoke) | ❌ Wave 0 |
| GCAL-04 | Watch renewal logic fires 48h before expiry | unit | `pytest tests/gcal/test_watch.py -x` | ❌ Wave 0 |
| GCAL-05 | create_study_block creates event and stores ID | unit | `pytest tests/gcal/test_writeback.py -x` | ❌ Wave 0 |
| GMAI-01 | Gmail watch established on OAuth callback | unit | `pytest tests/gmail/test_watch.py -x` | ❌ Wave 0 |
| GMAI-02 | classify_email returns correct JSON for fixture emails | unit | `pytest tests/gmail/test_classify.py -x` | ❌ Wave 0 |
| GMAI-03 | gmail_flags row written with correct fields (no body) | unit | `pytest tests/gmail/test_db.py -x` | ❌ Wave 0 |
| GMAI-04 | Gmail watch renewal before 7-day expiry | unit | `pytest tests/gmail/test_watch.py::test_renewal -x` | ❌ Wave 0 |
| GMAI-05 | find_matching_deadline returns correct match with rapidfuzz | unit | `pytest tests/gmail/test_classify.py::test_fuzzy -x` | ❌ Wave 0 |
| ALRT-01 | Deadline change fires alert via existing ingest path | integration | `pytest tests/test_tasks_sms.py -x` (extend) | ✅ partial |
| ALRT-02 | Gmail contradiction alert fires with both dates | unit | `pytest tests/gmail/test_classify.py::test_alrt02 -x` | ❌ Wave 0 |
| ALRT-03 | Alert SMS body includes all required fields | unit | `pytest tests/test_tasks_ai.py -x` (extend) | ✅ partial |
| INTEL-03 | detect_conflicts_user fires for same-day overlap | unit | `pytest tests/gcal/test_conflicts.py -x` | ❌ Wave 0 |
| SMS-10 | Multiple alerts batched into one SMS | unit | `pytest tests/sms/test_batch.py -x` | ❌ Wave 0 |
| SMS-11 | Max 3 texts per 10-min window enforced | unit | `pytest tests/sms/test_batch.py::test_cap -x` | ❌ Wave 0 |
| SYNC-03 | gcal_sync_user processes real-time change | integration | `pytest tests/gcal/test_fetch.py::test_sync_user -x` | ❌ Wave 0 |
| SYNC-04 | Watch renewal Beat schedule entry exists | unit | `pytest tests/test_celery_app.py -x` (extend) | ✅ partial |
| AI-08 | Monday briefing includes conflicts + study windows | unit | `pytest tests/ai/test_briefing.py -x` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `cd celery_worker && python -m pytest tests/ -x -q`
- **Per wave merge:** `cd celery_worker && python -m pytest tests/ -v`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `celery_worker/tests/gcal/__init__.py` + `test_fetch.py`, `test_db.py`, `test_watch.py`, `test_writeback.py`, `test_conflicts.py`
- [ ] `celery_worker/tests/gmail/__init__.py` + `test_watch.py`, `test_classify.py`, `test_db.py`
- [ ] `celery_worker/tests/sms/test_batch.py` — covers SMS-10, SMS-11
- [ ] `celery_worker/tests/ai/test_briefing.py` — covers AI-08 Monday enrichment
- [ ] `celery_worker/conftest.py` — add Redis mock fixture (`fakeredis`)
- [ ] Install test deps: `pip install fakeredis pytest-mock`

---

## Sources

### Primary (HIGH confidence)
- [Google Calendar API Push Notifications](https://developers.google.com/workspace/calendar/api/guides/push) — webhook payload format, X-Goog headers, watch setup, expiry behavior
- [Google Calendar API Synchronization](https://developers.google.com/workspace/calendar/api/guides/sync) — syncToken flow, 410 GONE handling, incremental sync
- [Gmail API Push Notifications](https://developers.google.com/workspace/gmail/api/guides/push) — Pub/Sub requirement, historyId flow, watch() parameters, 7-day renewal
- [Google Calendar Events: watch](https://developers.google.com/workspace/calendar/api/v3/reference/events/watch) — official watch() API reference
- [Gmail users.history.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list) — historyTypes, labelId filtering
- [Google Calendar Events: insert](https://developers.google.com/calendar/api/guides/create-events) — event body format for study block write-back
- [cryptography Fernet docs](https://cryptography.io/en/latest/fernet/) — AES-128-CBC + HMAC-SHA256 implementation
- [rapidfuzz GitHub](https://github.com/rapidfuzz/RapidFuzz) — MIT license, token_set_ratio, Python API

### Secondary (MEDIUM confidence)
- PyPI: google-api-python-client 2.193.0 (2026-03-17), google-auth-oauthlib 1.3.0 (2026-02-27) — verified via search against PyPI listings
- Google OAuth state/CSRF pattern — Auth0 official docs cross-references Google's web server flow guide
- RapidFuzz vs thefuzz comparison — multiple independent sources agree on MIT license and performance superiority

### Tertiary (LOW confidence)
- Redis batch queue pattern — no single canonical source; derived from redis-py docs + Celery task scheduling docs combined with the CONTEXT.md design spec
- Pub/Sub domain verification for push subscriptions — mentioned in search but not verified against official current docs for Vercel-hosted apps specifically

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all library versions verified against PyPI search results dated 2026-03-19
- Google API patterns: HIGH — fetched directly from official Google Developers documentation
- Architecture: HIGH — extends well-understood existing patterns from Phases 2–5
- SMS batching: MEDIUM — design from CONTEXT.md is clear; specific Redis key schema is Claude's discretion
- Pub/Sub dev workflow: LOW — practical dev experience required; documented as open question

**Research date:** 2026-03-20
**Valid until:** 2026-04-20 (Google API docs are stable; library versions update weekly but breaking changes are rare)
