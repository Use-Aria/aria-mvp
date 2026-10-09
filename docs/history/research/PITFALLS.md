# Pitfalls Research

**Domain:** AI SMS assistant — student academic data pipeline (Canvas iCal, Google OAuth, Twilio, Celery, Claude API)
**Researched:** 2026-03-18
**Confidence:** HIGH for OAuth/Twilio/iCal/compliance patterns (well-established); MEDIUM for Claude-specific context patterns (newer API surface)

---

## Critical Pitfalls

### Pitfall 1: Google OAuth Refresh Token Silent Revocation

**What goes wrong:**
A refresh token stops working silently in production. The next call to exchange it for an access token returns `invalid_grant`. The error is often swallowed, logged nowhere useful, and the user's Google Calendar or Gmail integration simply stops syncing without any alert to them or to the system.

**Why it happens:**
Google revokes refresh tokens under several conditions that developers don't anticipate:
- User has more than 50 active refresh tokens for your OAuth client (Google silently revokes the oldest)
- User revokes access via their Google account security settings
- App is in "Testing" mode in Google Cloud Console — tokens expire after 7 days, not indefinitely
- User changes their Google password
- Google detects suspicious activity and revokes all third-party tokens
- The refresh token was never stored, and only an access token (1-hour expiry) was persisted

The standard `access_denied` or `invalid_grant` error is easy to miss if the sync job catches generic exceptions and swallows them.

**How to avoid:**
1. Store `refresh_token` and `token_expiry` together in the `integrations` table; never store only `access_token`.
2. In the Google OAuth callback, confirm `refresh_token` is present in the response — it is only returned on first authorization or when `access_type=offline&prompt=consent` is explicitly passed. If it is absent, do not save the token row.
3. Handle `invalid_grant` as a distinct error case: mark the integration as `status: 'disconnected'` and send the user an SMS telling them to reconnect.
4. Promote the app from "Testing" to "Production" in Google Cloud Console before beta — testing-mode tokens expire in 7 days regardless of activity.
5. Add a health check: if `synced_at` is more than 2 hours old for a user who should be syncing, surface an alert.

**Warning signs:**
- GCal sync jobs complete with no errors but `synced_at` stops updating
- Zero calendar events returned for users who have events
- `invalid_grant` errors in Railway logs with no downstream alert

**Phase to address:** Phase 1 (Google Calendar integration) — must be built correctly from the start; retrofitting token refresh handling into a broken integration is painful.

---

### Pitfall 2: Google Calendar Watch Channels Silently Expiring

**What goes wrong:**
Push notification channels created via `calendar.events.watch()` have a maximum lifetime of 7 days (604,800 seconds). After expiry, Google stops sending push notifications to the webhook endpoint. No error is thrown. The system appears healthy but new calendar events are never received in real time.

**Why it happens:**
Developers set up a watch channel during integration and assume it persists. The expiration is easy to miss because the initial setup works perfectly. There is no retry or re-registration from Google's side — the channel simply stops.

**How to avoid:**
1. Store `channel_id`, `resource_id`, and `channel_expiry` in the `integrations` table when creating a watch.
2. Run a Celery periodic task (e.g., every 24 hours) that finds channels expiring within 48 hours and renews them via a fresh `watch()` call.
3. Before renewing, stop the old channel with `channels.stop()` to avoid duplicate notifications.
4. Validate the webhook endpoint is reachable before creating a channel — an unreachable endpoint creates a channel that never fires.

**Warning signs:**
- GCal push endpoint receives no traffic after a week despite users having active calendars
- `channel_expiry` column in DB shows dates in the past

**Phase to address:** Phase 1 (Google Calendar integration) — renewal logic must be built alongside the initial watch setup, not added later.

---

### Pitfall 3: Canvas iCal Parsing Breaks on Edge Case Event Formats

**What goes wrong:**
Canvas iCal feeds are not fully RFC 5545 compliant and vary by institution, Canvas version, and instructor configuration. Common breakage points:
- `DTEND` is absent (some Canvas events omit it for all-day or undated assignments)
- `SUMMARY` contains HTML-encoded characters (`&amp;`, `&lt;`, unicode) that must be decoded
- `DTSTART` uses floating time (no timezone suffix) rather than UTC — parsing as UTC shifts deadlines by the user's UTC offset
- Some assignments appear in the feed as `VEVENT` with `DTSTART` = `DTEND` (zero-duration events)
- `UID` format is not stable across Canvas versions; the same assignment can appear with a different `UID` after a Canvas upgrade, causing the diff engine to treat it as a deletion + new creation

**Why it happens:**
Canvas's iCal export is generated server-side and is institution-configurable. Developers test with their own institution's feed and don't see the variance. Edge cases only emerge once multiple users from different institutions or Canvas configurations connect.

**How to avoid:**
1. Use a battle-tested iCal parser (`ical.js` for Node, `icalendar` for Python) — never hand-roll iCal parsing.
2. Normalize `DTSTART` explicitly: if the value has no timezone suffix (`TZID` or `Z`), treat it as the user's local timezone (store during onboarding), not UTC.
3. Handle absent `DTEND` gracefully: default to `DTSTART + 1 hour` for events, `DTSTART + 23:59` for all-day items.
4. Decode HTML entities in `SUMMARY` before storing.
5. Build the diff engine around a canonical hash of `(SUMMARY + DTSTART + course)` rather than `UID` alone, as `UID` stability cannot be relied upon.
6. Log raw `UID` mismatches and validate against expected patterns before treating them as deletions.

**Warning signs:**
- Deadlines appearing at midnight UTC instead of midnight local time
- Duplicate deadlines in the DB for the same assignment after a Canvas update
- `TypeError` in iCal parsing for users at specific institutions

**Phase to address:** Phase 1 (Canvas iCal sync) — diff correctness is the core value proposition; a broken diff creates false alerts which destroys user trust.

---

### Pitfall 4: Twilio Webhook Request Signature Validation Skipped in Dev, Never Added in Production

**What goes wrong:**
The Twilio inbound SMS webhook at `/api/sms/webhook` is publicly accessible and unauthenticated. Any actor who discovers the URL can POST fake SMS messages to Aria and trigger AI processing, database writes, and outbound SMS responses — at Twilio's per-message cost and Claude's API cost.

**Why it happens:**
In development, signature validation is skipped because ngrok URLs change and the validation requires the full public URL. Developers intend to add it "before production" but it becomes a missing item in the rush to ship.

**How to avoid:**
1. Validate `X-Twilio-Signature` on every inbound webhook request using Twilio's official helper library. This requires passing the full public webhook URL (env var) and the POST body to the validator.
2. Return HTTP 403 immediately for any request that fails signature validation — do not process or log the body.
3. In dev: set `TWILIO_WEBHOOK_URL` as the current ngrok URL and update it each dev session, or use a fixed ngrok subdomain (ngrok paid plan).
4. Add a test that posts a request without a valid signature and asserts 403 is returned.

**Warning signs:**
- Webhook endpoint is reachable without any auth check
- No `X-Twilio-Signature` header validation in `route.ts`
- Missing `twilio` helper library import in the webhook handler

**Phase to address:** Phase 1 (Twilio SMS layer) — must be in the initial webhook implementation, not a follow-up task.

---

### Pitfall 5: Twilio Webhook Timeout Causes Duplicate Message Processing

**What goes wrong:**
Twilio expects a webhook response within 15 seconds. If the handler exceeds this (e.g., waiting for a Claude API call to complete before returning 200), Twilio retries the webhook — often 3 times with 1-hour intervals by default. Each retry is processed as a new message, triggering duplicate AI responses and duplicate outbound SMS messages sent to the user.

**Why it happens:**
Developers write the inbound handler as: receive message → call Claude → compose reply → send via Twilio → return 200. Claude API calls can take 3-30 seconds depending on model and load. The full round trip exceeds Twilio's 15-second timeout.

**How to avoid:**
1. The inbound webhook handler must return HTTP 200 immediately after validating the request and enqueuing a Celery task.
2. The Celery task handles: Claude API call → outbound SMS via Twilio REST API.
3. Use idempotency: store `MessageSid` (Twilio's unique ID for each inbound message) in the DB and skip processing if already seen. This prevents Celery retries from double-firing too.
4. Never call Claude synchronously from a Twilio webhook handler.

**Warning signs:**
- Users receiving duplicate SMS replies
- Twilio dashboard showing multiple deliveries of the same inbound message
- Railway logs showing the same `MessageSid` processed more than once

**Phase to address:** Phase 1 (Twilio + Celery setup) — the async pattern must be established from the first working webhook, not retrofitted.

---

### Pitfall 6: Gmail Watch Expiration — The 7-Day Cliff

**What goes wrong:**
Gmail push notifications via `users.watch()` expire after exactly 7 days. Like Google Calendar watch channels, there is no automatic renewal and no error when expiry occurs — emails simply stop being processed. In a student assistant context this means professor announcements about deadline changes are silently missed starting day 8.

**Why it happens:**
Gmail watch is set up once during OAuth connection and the expiration is not tracked. The integration appears working in the first week of beta (which happens to be less than 7 days), then breaks silently.

**How to avoid:**
1. Store `gmail_history_id` and `gmail_watch_expiry` in the `integrations` table at watch creation time.
2. Celery periodic task renews any Gmail watch expiring within 48 hours using `users.watch()` again with the same topic.
3. On renewal, update `gmail_history_id` to the new value returned — this is the cursor for incremental email fetching.
4. Treat a missing or expired `gmail_history_id` as a signal to perform a full re-sync of recent emails (last 14 days).
5. Send a Slack/email alert to the dev if Gmail watch renewal fails for any user.

**Warning signs:**
- `gmail_watch_expiry` in the DB is more than 7 days in the past for any user
- Gmail Pub/Sub topic receives no messages for users who receive regular emails
- Professor email alerts stop firing after the first week of beta

**Phase to address:** Phase 1 (Gmail integration) — renewal logic is not optional infrastructure.

---

### Pitfall 7: TCPA Violation from Missing Opt-Out Handling

**What goes wrong:**
A user texts STOP to Aria's Twilio number. Twilio automatically blocks future messages to that number at the carrier level. But the application's DB still has the user marked as `sms_active: true`. When the next daily briefing runs, the app attempts to send — Twilio silently discards it. Worse: if the user later opts back in (texts START), but the app doesn't handle the opt-in webhook, the user receives nothing and believes the service is broken.

More critically: if you send marketing or promotional messages to a number that has opted out, that is a TCPA violation exposing Aria to $500-$1,500 per message in statutory damages.

**Why it happens:**
Developers focus on sending messages and treat STOP handling as an afterthought. Twilio handles the carrier-level block automatically, which creates a false sense of safety — the block prevents delivery, but the TCPA violation is in the attempt, and the block can be bypassed in test environments.

**How to avoid:**
1. Register a webhook in Twilio for STOP/HELP/START keywords — Twilio will POST to this webhook when users reply with these keywords.
2. On STOP: set `sms_opted_out: true`, `sms_opted_out_at: timestamp` in the users table. Never send to opted-out users regardless of Twilio's carrier block.
3. On START: clear `sms_opted_out`, log the re-opt-in timestamp.
4. Every outbound SMS function must check `sms_opted_out` before calling `twilio.messages.create()`.
5. The onboarding SMS must include opt-out instructions: "Reply STOP to unsubscribe."
6. Daily briefing volume: MVP sends one briefing per day. Do not send more than 3 unsolicited messages per day per user (TCPA best practice).
7. Store a `trigger_type` for every outbound message to prove they were transactional, not marketing.

**Warning signs:**
- No webhook handler for STOP/START keywords
- No `sms_opted_out` column in the users table
- Outbound SMS functions that call Twilio without checking opt-out status first

**Phase to address:** Phase 1 (Twilio SMS) — opt-out handling must ship with the first outbound message capability, not as a follow-up.

---

### Pitfall 8: FERPA Exposure via Canvas API Scope Creep

**What goes wrong:**
A developer adds Canvas API calls (not iCal) to fetch richer assignment data — grade weights, submission status, rubrics. This bypasses the iCal-only architecture and creates FERPA exposure: Canvas API returns enrollment, submission, and grade data which are educational records protected by FERPA. Without a Data Processing Agreement with Yale (which requires months of institutional approval), handling this data is non-compliant.

**Why it happens:**
Canvas has a rich API and iCal is limited. When building the syllabus weight feature, it is tempting to pull `submissions` or `assignments` endpoints to get grade weights rather than parsing the syllabus PDF. The API calls are technically easy to make.

**How to avoid:**
1. Enforce a hard rule in code review: no Canvas API calls. Canvas data enters the system only via iCal URL.
2. Grade weights come exclusively from the syllabus PDF parser (Claude Opus), stored in the `syllabi` table.
3. Never store Canvas API credentials. The only Canvas-related credential is the iCal URL (a public URL fragment, not an auth token).
4. Document this constraint in CLAUDE.md and enforce it in PR reviews.

**Warning signs:**
- Any import of a Canvas API client library
- Any HTTP call to `instructure.com` endpoints other than the iCal feed URL
- Any DB column storing `submission_id`, `grade`, or `enrollment_id`

**Phase to address:** Phase 1 (Canvas iCal sync) — constraint must be documented and enforced from day one.

---

### Pitfall 9: Claude Context Window Overflow Causing Truncated or Hallucinated Briefings

**What goes wrong:**
A student with 8 courses, active syllabi, and 3 weeks of deadlines submits a context payload that exceeds the model's effective context window for coherent generation. Claude either truncates the input silently (returning a partial briefing), generates hallucinated deadlines, or produces a malformed response that the briefing parser cannot handle.

**Why it happens:**
The system is designed around a single student's data but the prompt template is not tested against heavy users. During finals week, a student may have 20+ upcoming deadlines, 10+ calendar events, and 5 syllabus summaries. Without explicit truncation logic the context grows unboundedly.

**How to avoid:**
1. Enforce the 14-day deadline window and 7-day calendar window as hard limits before constructing any prompt — never pass "all deadlines" or "all events."
2. Sort deadlines by `due_date` ascending and take the nearest N that fits the token budget, not all of them.
3. For syllabus summaries, pass only the parsed `parsed_json` field (structured summary), never the raw `raw_text`.
4. Add a token estimation step before the Claude call (rough estimate: 1 token ≈ 4 characters). Truncate if approaching 80% of the model's context limit.
5. Define a JSON schema for Claude's output and validate the response — if it fails validation, retry with a reduced context window.
6. Separate concerns: the briefing generator (`briefing.ts`) and the SMS reply handler (`replies.ts`) should have different context budgets and strategies.

**Warning signs:**
- Claude responses that are cut off mid-sentence
- Briefings that reference deadlines not in the context payload
- JSON parsing errors on Claude's response in high-load scenarios (many deadlines)

**Phase to address:** Phase 1 (briefing generation) — context budget management must be in the initial briefing generator, not added after users report weird briefings.

---

### Pitfall 10: Celery Task Retry Storm on Upstream API Failure

**What goes wrong:**
An upstream API (Canvas iCal, Google Calendar, Claude) is temporarily unavailable. Celery retries the failed task with default settings — potentially immediately, potentially thousands of times across 50 users simultaneously. This floods Railway's worker processes, exhausts Redis memory, and can get Aria's IP rate-limited or banned by the upstream service.

**Why it happens:**
Celery's default retry behavior is to retry immediately (or after a very short delay) with no backoff. When the Canvas iCal endpoint is down for 10 minutes during a deploy, all 50 users' sync jobs pile up in the retry queue.

**How to avoid:**
1. All Celery tasks that call external APIs must use exponential backoff with jitter:
   ```python
   @app.task(bind=True, max_retries=5)
   def sync_canvas(self, user_id):
       try:
           ...
       except RequestException as e:
           raise self.retry(exc=e, countdown=2 ** self.request.retries * 60)
   ```
2. Set a `max_retries` limit (5 is reasonable) so failed tasks eventually move to the dead-letter queue rather than retrying forever.
3. Use a dead-letter queue (DLQ) pattern: failed tasks after max retries go to a `failed_tasks` queue, which triggers a developer alert.
4. Canvas sync runs every 60 minutes. If the last sync failed, do not re-run at the next 60-minute mark — use a jitter so all users do not sync at exactly the same time.
5. Separate queues for high-priority tasks (inbound SMS → Claude reply) and low-priority tasks (canvas sync, briefing generation) so a Canvas outage does not block SMS responses.

**Warning signs:**
- Railway memory usage spiking during upstream API incidents
- Celery queue depth growing unboundedly in Redis
- Canvas iCal endpoint returning 429 (rate limited) in logs

**Phase to address:** Phase 1 (Celery + background sync engine) — retry strategy must be in the first Celery task, not added after a production incident.

---

### Pitfall 11: Cold-Start UX — Users Receive Nothing for the First 24 Hours

**What goes wrong:**
A user completes onboarding at 2pm on a Tuesday. The daily briefing runs Monday at 8am. Canvas sync ran at 1pm (before they connected). The user has zero interactions with Aria for 18+ hours and concludes the product is broken. They churn before ever seeing the core value.

**Why it happens:**
The daily briefing is a scheduled job. Onboarding triggers no immediate feedback loop. Developers think about the "steady state" experience but not the "first session" experience.

**How to avoid:**
1. Immediately after onboarding completes (Canvas URL validated, Google OAuth done), trigger a one-time "welcome briefing" — a summary of the next 7 days — sent via SMS within 60 seconds.
2. The welcome briefing uses the same `briefing.ts` function but is triggered by the onboarding API route, not the scheduler.
3. The onboarding confirmation SMS should set expectations: "I'll send you a daily briefing each morning. Here's a preview of your week:"
4. If the user connects Canvas but not Google Calendar yet, still send a partial briefing with just Canvas deadlines rather than waiting for full setup.
5. Provide a "reply STATUS to get your current overview" command from day one.

**Warning signs:**
- Onboarding flow ends with a confirmation message but no immediate content
- No Celery task triggered at the end of onboarding
- First contact with AI value is next morning's scheduled briefing

**Phase to address:** Phase 1 (onboarding + Twilio SMS) — the first SMS after onboarding is the most important message Aria ever sends.

---

### Pitfall 12: Duplicate Deadline Alerts from Competing Diff Sources

**What goes wrong:**
Aria detects a deadline change via Canvas iCal diff AND via a professor Gmail mentioning the same change. Both trigger an SMS alert. The user receives two SMS messages about the same deadline change within minutes of each other and concludes Aria is spammy or broken.

**Why it happens:**
The Canvas sync and Gmail watch are independent pipelines. Both detect "this deadline changed" and both enqueue an alert task. Without deduplication, both fire.

**How to avoid:**
1. Implement a `deadline_alerts` table: `(user_id, deadline_id, alert_type, triggered_at)`. Before sending any alert, check if an alert for this `(user_id, deadline_id)` was sent within the last 2 hours.
2. Use Celery's `task_id` as an idempotency key when enqueuing alerts — if an alert task for `(user_id, deadline_id)` is already in the queue, drop the duplicate.
3. The Gmail classifier (Haiku model) should tag emails as "deadline change detected" and write to a `pending_alerts` table. A separate consolidation task runs every 5 minutes and merges pending alerts with Canvas diff alerts before sending.

**Warning signs:**
- Users receive 2-3 SMS messages about the same event
- `messages` table shows duplicate outbound rows with `trigger_type: 'deadline_alert'` for the same deadline within a short window

**Phase to address:** Phase 1 (deadline alert pipeline) — deduplication logic must be designed before the first alert fires.

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Storing only `access_token`, not `refresh_token` | Simpler OAuth flow | Integration silently breaks after 1 hour; requires user re-auth | Never |
| Calling Claude synchronously from Twilio webhook | Simpler code path | Twilio timeout causes duplicate processing | Never |
| Hardcoding Twilio phone number instead of env var | Faster dev setup | Number rotation is a deploy change, not a config change | Never |
| Skipping webhook signature validation in dev | Faster iteration | Endpoint ships without auth protection | Never |
| Using Canvas API instead of iCal for richer data | Better data quality | FERPA exposure, institutional approval required | Never |
| Passing all deadlines to Claude without truncation | Simpler prompt construction | Context overflow, hallucinated briefings for power users | Never |
| Single Celery queue for all tasks | Simpler setup | Canvas sync outage blocks SMS replies | Acceptable in prototype only; fix before beta |
| Storing phone numbers in plaintext in logs | Easier debugging | PII exposure in log files | Never |
| Polling Gmail instead of push notifications | Simpler to implement | 5-10 min lag on professor emails; misses "15 min alert" SLA | Never |
| Re-parsing syllabus PDF on every briefing request | No storage needed | Slow, expensive, inconsistent results | Never |

---

## Integration Gotchas

Common mistakes when connecting to external services.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Google OAuth | Not passing `access_type=offline&prompt=consent` → no refresh token returned | Always pass both params; confirm `refresh_token` is in response before storing |
| Google OAuth | App in "Testing" mode → tokens expire in 7 days | Publish app to Production before beta launch |
| Google Calendar watch | Creating watch but not storing expiry → channel silently expires | Store `channel_id`, `resource_id`, `channel_expiry`; renew 48h before expiry |
| Gmail watch | Same as GCal watch — 7-day expiry, no auto-renewal | Same pattern: store expiry, Celery renewal task |
| Canvas iCal | Parsing `DTSTART` as UTC when feed uses floating time | Always apply user's stored timezone to floating-time events |
| Canvas iCal | Using `UID` alone for diff identity | Use hash of `(SUMMARY + DTSTART)` as the canonical identity key |
| Twilio inbound | Processing Claude call synchronously before returning 200 | Return 200 immediately; enqueue Celery task for Claude + reply |
| Twilio inbound | No signature validation | Validate `X-Twilio-Signature` on every request; return 403 on failure |
| Twilio outbound | Not checking opt-out status before sending | Always check `sms_opted_out` before calling `twilio.messages.create()` |
| Claude API | Sending entire deadline history to every call | Hard-limit to 14-day window; estimate tokens before call; truncate to 80% context limit |
| Celery | No retry backoff → retry storm during upstream downtime | Exponential backoff with jitter; max 5 retries; separate queues by priority |
| Supabase | Storing raw OAuth access tokens without encryption | Encrypt tokens with AES-256 before writing; decrypt only at API call time |

---

## Performance Traps

Patterns that work at small scale but fail as usage grows.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| All Canvas syncs scheduled at the same minute (e.g., :00 of every hour) | Burst of 50 concurrent iCal fetches at exactly 9:00 AM | Add per-user jitter offset (e.g., `user_id % 60` minutes) to spread load | At 10+ users |
| Claude briefing calls are synchronous on the scheduler tick | Daily briefing job blocks for 30s × 50 users = 25 minutes | Generate briefings as individual Celery tasks, not a for-loop in one job | At 20+ users |
| Chroma vector DB on same Railway instance as FastAPI workers | Syllabus embedding queries slow down during sync spikes | Run Chroma as a separate Railway service or use Supabase pgvector instead | At 5+ concurrent syllabus queries |
| No DB index on `deadlines(user_id, due_date)` | Briefing query scans full table | Add composite index during schema migration | At 500+ deadline rows |
| Storing full `raw_text` of every syllabus PDF as a table column | `syllabi` table becomes hundreds of MB | Store `raw_text` in Supabase Storage (object store), not a column; only `parsed_json` in the table | At 50+ syllabi |

---

## Security Mistakes

Domain-specific security issues beyond general web security.

| Mistake | Risk | Prevention |
|---------|------|------------|
| Phone numbers stored in plaintext in application logs | PII exposure if logs are accessed by third parties or Railway support staff | Hash phone numbers (SHA-256 + salt) in all log statements; use masked format (+1-XXX-XXX-1234) |
| OAuth refresh tokens stored unencrypted in Supabase | Token theft from DB gives permanent Google account access | AES-256 encrypt tokens before INSERT; decrypt at read time using `SUPABASE_SERVICE_ROLE_KEY`-derived key |
| `ANTHROPIC_API_KEY` accessible to client-side Next.js code | API key exposed in browser bundle | Never expose key via `NEXT_PUBLIC_` prefix; all Claude calls go through Next.js API routes or FastAPI only |
| Twilio webhook endpoint unauthenticated | Fake SMS injection, API cost amplification | Validate `X-Twilio-Signature` on every inbound request |
| Canvas iCal URL stored unencrypted | URL reveals course enrollment and can be used to impersonate student | Treat iCal URL as a credential; store encrypted; rotate if user resets Canvas |
| Supabase Row Level Security disabled | Any authenticated user can read all other users' deadlines and messages | Enable RLS on every table; policies enforce `user_id = auth.uid()` |
| JWT tokens not validated on FastAPI side | Next.js frontend can be bypassed; direct calls to FastAPI expose all data | Validate Supabase JWT on every FastAPI endpoint using `python-jose` |

---

## UX Pitfalls

Common user experience mistakes in this domain.

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| No immediate feedback after onboarding | User waits 18+ hours for first value; churns | Trigger welcome briefing SMS within 60 seconds of completing onboarding |
| Briefing message is too long for SMS (>160 chars = multi-part) | Long messages split into 2-4 SMS; formatting breaks; feels like spam | Design briefing template to fit one SMS (160 chars) or use MMS thoughtfully; test with 5-6 deadlines |
| Deadline alert sends at 11 PM | User is asleep; gets woken up; opts out | Respect quiet hours (10 PM – 7 AM); queue alerts for next morning if triggered at night |
| Alert fires for a Canvas edit that is not a real deadline change (e.g., instructor fixed a typo in the assignment title) | User receives false alarm; erodes trust | Use Haiku to classify whether a Canvas diff is a meaningful change (due date or type change) vs. cosmetic (title/description) before firing alert |
| "Reply STOP to unsubscribe" only mentioned in initial welcome | Users forget how to opt out; get frustrated; file spam complaints | Include opt-out reminder in every weekly briefing footer |
| User connects Canvas but has no deadlines in the next 7 days | Welcome briefing says "You have no upcoming deadlines" — sounds broken | Show next 14 days for the welcome briefing; fall back to "Your semester looks clear for the next two weeks. I'll alert you when assignments are posted." |

---

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces.

- [ ] **Google OAuth integration:** Verify `refresh_token` is being stored (not just `access_token`). Check that `access_type=offline&prompt=consent` is in the auth URL. Confirm app is in Production mode in Google Cloud Console.
- [ ] **Google Calendar watch:** Verify `channel_expiry` is stored in DB and Celery renewal task exists and is scheduled.
- [ ] **Gmail watch:** Same as GCal — verify `gmail_watch_expiry` stored and renewal task scheduled.
- [ ] **Twilio webhook:** Verify `X-Twilio-Signature` validation is in the handler and STOP/START webhook is registered in Twilio console.
- [ ] **Twilio inbound handling:** Verify webhook handler returns 200 immediately and enqueues Celery task (does not call Claude synchronously).
- [ ] **Canvas iCal sync:** Verify diff engine uses content hash not just `UID`. Verify timezone handling for floating-time events. Verify HTML entity decoding in `SUMMARY`.
- [ ] **Celery tasks:** Verify exponential backoff is configured on every task that calls an external API. Verify dead-letter queue exists.
- [ ] **Opt-out compliance:** Verify every outbound SMS function checks `sms_opted_out` before calling Twilio. Verify STOP handler updates DB.
- [ ] **Supabase RLS:** Verify RLS is enabled and policies exist on `deadlines`, `syllabi`, `calendar_events`, `tasks`, `messages`.
- [ ] **Claude context:** Verify briefing generator hard-limits deadline window to 14 days and has token estimation before API call.
- [ ] **Onboarding:** Verify a welcome briefing Celery task is triggered synchronously at the end of onboarding (not waiting for the scheduler).
- [ ] **Duplicate alerts:** Verify `deadline_alerts` deduplication table or equivalent check exists before any alert SMS fires.

---

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| OAuth refresh token revoked for a user | LOW | Mark integration as `disconnected`; send SMS with re-auth link; user re-authorizes in 2 clicks |
| GCal/Gmail watch expired undetected | LOW | Backfill missed events via REST API poll for the gap period; renew watch; no user-facing impact if gap < 24h |
| Duplicate alerts already sent to users | MEDIUM | Send a follow-up SMS: "Heads up — you may have received a duplicate alert. We've fixed the issue." Do not ignore it. |
| Canvas iCal diff created phantom deletions (UID instability) | MEDIUM | Re-sync from scratch for affected users: truncate `deadlines` for that `user_id`, re-fetch full feed, rebuild from canonical hashes |
| Twilio webhook processed duplicates due to timeout | MEDIUM | Identify duplicate `MessageSid` pairs in `messages` table; backfill `processed` flag; add `MessageSid` uniqueness constraint going forward |
| Claude briefing hallucinated deadlines | HIGH | Identify affected users from `messages` table; send correction SMS; add token budgeting and output validation immediately |
| TCPA violation — sent to opted-out number | HIGH | Document the incident; check if Twilio carrier block was in place (if so, message likely wasn't delivered); add `sms_opted_out` check immediately; consult legal if messages were delivered |

---

## Pitfall-to-Phase Mapping

How roadmap phases should address these pitfalls.

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| OAuth refresh token silent revocation | Phase 1 — Google OAuth | Test: revoke token manually in Google account → confirm system marks integration disconnected and sends SMS |
| GCal watch channel expiry | Phase 1 — Google Calendar | Test: create watch with 1-min expiry → confirm renewal task fires and new channel is created |
| Gmail watch expiry | Phase 1 — Gmail integration | Test: simulate 7-day-old watch → confirm Celery renewal task identifies and renews it |
| Canvas iCal parsing edge cases | Phase 1 — Canvas iCal sync | Test: feed parser a fixture with floating-time DTSTART, missing DTEND, HTML entities in SUMMARY |
| Canvas iCal UID instability | Phase 1 — Canvas diff engine | Test: run diff with UID-changed feed → confirm no false deletions using content-hash identity |
| Twilio webhook signature validation | Phase 1 — Twilio SMS | Test: POST without valid signature → assert 403 returned |
| Twilio timeout / duplicate processing | Phase 1 — Twilio + Celery | Test: simulate slow Claude response → assert webhook returns 200 immediately; Celery processes async |
| TCPA opt-out handling | Phase 1 — Twilio SMS | Test: send STOP to number → confirm `sms_opted_out` is set; attempt outbound → confirm blocked |
| FERPA Canvas API scope creep | Phase 1 — Canvas iCal sync | Code review: grep for `instructure.com/api` — must return zero results |
| Claude context overflow | Phase 1 — briefing generation | Test: generate briefing with 50 deadlines → confirm token check truncates appropriately; no malformed response |
| Celery retry storm | Phase 1 — Celery engine | Test: simulate Canvas 503 → confirm exponential backoff in logs; confirm max_retries respected |
| Cold-start UX | Phase 1 — onboarding + Twilio | Test: complete onboarding → confirm welcome briefing SMS arrives within 60 seconds |
| Duplicate deadline alerts | Phase 1 — deadline alert pipeline | Test: trigger Canvas diff + Gmail detection for same deadline → confirm only one SMS sent |
| Quiet hours violation | Phase 1 — alert pipeline | Test: trigger alert at 11 PM → confirm message is queued until 7 AM |

---

## Sources

- Google OAuth 2.0 documentation: token refresh, `invalid_grant` error conditions, and testing-mode expiry are well-documented in Google Identity Platform docs (HIGH confidence — from training data consistent with official docs)
- Google Calendar API push notification documentation: 7-day channel expiry and `channels.stop()` requirement are documented in the Calendar API reference (HIGH confidence)
- Gmail API push notifications documentation: 7-day watch expiry and `historyId` cursor pattern are documented in Gmail API reference (HIGH confidence)
- Twilio webhook documentation: 15-second timeout, retry behavior, `X-Twilio-Signature` validation requirement are documented in Twilio docs (HIGH confidence)
- TCPA compliance: opt-out handling requirements (STOP/START), 3-message-per-day best practice for unsolicited messages, and per-message statutory damages are established US telecommunications law and Twilio's compliance documentation (HIGH confidence)
- FERPA: educational records definition and institution-level approval requirements for third-party data access are established law and Canvas's own documentation (HIGH confidence)
- Canvas iCal edge cases: floating-time DTSTART, UID instability, missing DTEND — MEDIUM confidence, based on community reports and known Canvas behavior patterns in training data; recommend validating with test feeds from multiple institutions before beta
- Celery retry configuration: exponential backoff pattern and queue separation are documented in Celery best practices (HIGH confidence)
- Claude context limits: token window guidance, truncation behavior — HIGH confidence based on Anthropic API documentation and known model characteristics

---
*Pitfalls research for: Aria — AI SMS assistant (Canvas iCal, Google OAuth, Twilio, Celery, Claude API)*
*Researched: 2026-03-18*
