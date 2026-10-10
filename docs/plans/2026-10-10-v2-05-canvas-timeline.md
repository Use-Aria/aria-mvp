# V2-05: Canvas iCal connect, hourly sync, and the timeline module (plan)

> **Status:** Plan only. No code, migration, or dependency changes have been made.
> **Author:** V2-05 planning agent, 2026-10-10.
> **Binding contracts:** `docs/plans/2026-10-10-v2-build-brief.md`.
> **Reconciled with the sibling plans written the same day:** V2-03, V2-04, V2-06, V2-07, V2-08, and web-surfaces. §8.5 lists every name and shape this plan adopted from them. Where a consumer already specified a signature, this plan **adopts the consumer's name and shape** and extends it only with optional fields.

---

## 1. Scope and spec references

**In scope (V2-05 owns):**

| Area | Paths |
|---|---|
| Canvas integration: URL validation, SSRF-hardened fetch, ICS lexing, Canvas mapping, sync, connect/disconnect/status | `src/server/integrations/canvas/**` |
| Timeline module: write API (snapshot, window replace, incremental, prune), diff, change batches, read API (list, search, refs, load, model rendering), status changes | `src/server/timeline/**` |
| Shared pure code: university list, Canvas URL detection and normalization, guide and error copy | `src/shared/{universities,canvas-url,canvas-guide}.ts` |
| Job kind `canvas_sync` (one file plus one registry line) | `src/server/jobs/kinds/canvas-sync.ts` |
| Agent tools `connect_canvas` and `canvas_status` (files plus registry lines in V2-04's "agenda (V2-05)" slot block) | `src/server/agent/tools/{connect-canvas,canvas-status}.ts` |
| Tests and fixtures | `tests/unit/canvas/**`, `tests/unit/timeline/**`, `tests/unit/shared/{universities,canvas-url}.test.ts`, `tests/fixtures/canvas/**`, `tests/smoke/{timeline,canvas-live}.smoke.test.ts` |

**Not V2-05 (per the sibling plans):**

| Item | Owner |
|---|---|
| `/setup` Canvas UI (`CanvasConnect.tsx`, `connectCanvasAction`) | web-surfaces W5 |
| `/week` page | web-surfaces W7 |
| Timezone/DST helpers `src/shared/time/tz.ts` (`zonedToUtc`, `localDateOf`, `formatForChat`, `formatForTool`). V2-05 **consumes** them. | V2-06 |
| `courseKey` / `sameCourse` in `src/shared/course-key.ts` | V2-08 |
| `collapseSyllabusDuplicates` (called from V2-05's read path) | V2-08 |
| The `timeline_changes` job handler `handleTimelineChanges` (alerts, T-3h auto-nudges, anchored reminders) | V2-06 |
| `wrapUntrusted` | V2-04 |
| Jobs infrastructure and `deliver` | V2-03 |

V2-05's agenda tools `get_agenda`, `search_deadlines`, and `mark_done` are V2-04 files that call this module.

**Spec references:**
- §1.2: the Canvas verdict "Port". Bugs to fix: the `" - "` course split, all-day items at 7:59pm ET, and no URL.
- §1.3: the salvage list (`celery_worker/canvas/*.py`, `mobile/lib/universities.ts`, `tools.tsx:144-190, 298-302`, `CanvasUrlInput.tsx`, `useCards.ts:121-133`).
- §3.10: iCal only; SSRF hardening; encrypted URL; connect by paste on the page or in chat.
- §3.15: hourly jittered sync; external-id keys; ≤7 days → immediate, otherwise next briefing; urgency at read time.
- §3.16: anchored reminders move with the due date (V2-06, driven by this branch's change batches).
- §3.22: Canvas text is untrusted; only user-authored chat text triggers actions.
- §4.4: job kind "Canvas sync".
- §4.13: pure-logic tests.
- §5: `timeline_items` and `integrations`.
- Free-testing plan F3.

---

## 2. Analysis

### 2.1 What a real Canvas feed looks like (from Instructure's source, §3)

The feed comes from `CalendarEvent::IcalEvent#to_ics` in canvas-lms. Each fact below is read from the source, not guessed:

| Property | Real format | Consequence |
|---|---|---|
| `SUMMARY` | `"<title> [<course_code>]"`. With a student-specific override: `"<title> (<override title>) [<course_code>]"`. Account or user calendar events have no bracket suffix. | The V1 `" - "` split never matched. Parse the **trailing** `[...]` group. It holds the **course code** (for example `CPSC 323 01 (FA26)` **[verify Yale's format]**), not the course name. Store it raw in `course`; normalize at read time with V2-08's `courseKey()`. |
| `DTSTART` (timed) | Always UTC: `DTSTART:20261016T210000Z`, seconds zeroed. Canvas passes `tzid: "UTC"`, and icalendar-ruby drops the TZID and appends `Z`. | Timed items are simple. |
| `DTSTART` (all-day) | `DTSTART;VALUE=DATE:20261015`, **no DTEND**, whenever `all_day && all_day_date`. | See the next row. |
| Assignment `all_day` | `all_day = (due_at.strftime("%H:%M") == "23:59")` in the editor's time zone. Canvas's default due time is 11:59pm ("fancy midnight"). | **Most assignments arrive date-only.** V1 pinned them to `23:59:59Z` (7:59pm EDT), which is the spec's bug. Correct reading: **23:59 local on that date**. |
| `UID` | `event-assignment-<id>`, `event-calendar-event-<id>`, `event-sub-assignment-<id>` (discussion checkpoints), and **`event-assignment-override-<override_id>` when an override applies to this student**. | Stable per object, **except** that an extension or section override switches `event-assignment-N` to `event-assignment-override-M`. A naive UID diff turns the most important due change (an extension) into "removed + created". Handled by rekeying (§2.4). |
| `URL` | `https://<host>/calendar?include_contexts=course_<cid>&month=MM&year=YYYY#assignment_<id>` (`#calendar_event_<id>` for events; the parent's `#assignment_<id>` for sub-assignments). Set *before* the override block, so it keeps the base id. | The fragment is a stable "Canvas object key" (`match_key`) that survives the override UID switch. A direct link `https://<host>/courses/<cid>/assignments/<id>` is derivable. |
| `DESCRIPTION` / `X-ALT-DESC;FMTTYPE=text/html` | Present only when the student can see it. Instructor-authored HTML. | Untrusted. Never store `X-ALT-DESC`. Store at most 1,000 chars of plain-text `DESCRIPTION` in `raw`; never put it in a prompt by default. |
| Header | `PRODID:icalendar-ruby`, `VERSION:2.0`, `CALSCALE:GREGORIAN`, `METHOD:PUBLISH`, `X-WR-CALNAME:<Name> Calendar (Canvas)`. | Canvas fingerprint for "Other" hosts. |
| Window and caps | **30 days back to 366 days ahead.** Up to **1,000 assignments** and 1,000 calendar events per feed (`paginate(per_page: 1000, max: 1000)`). Undated assignments are omitted. To-Do items are not included. | Items that age out of the window are not deletions (§2.5). |
| Invalid or revoked feed | **HTTP 400 `text/html`** plus `x-canvas-meta: …o=calendar_events_api;n=public_feed…` (live probe). Not 404 or 410. A host with no Canvas account → **404** with `x-canvas-meta` but no `n=public_feed`. | Revocation detection keys on 400 plus that header, and on 404/410. |
| URL shape | `/feeds/calendars/user_<uuid>.ics`. Today's uuid is `SecureRandom.alphanumeric(40)`; legacy ids are possible via `UserPastLtiId`. Other feed types exist: `course_<uuid>`, `enrollment_<uuid>`, `group_membership_<uuid>`. | Accept `user_[A-Za-z0-9]{20,64}`. Give a friendly error for `course_`/`enrollment_` feeds, which lack the per-student calendar. |

### 2.2 Decision: iCal parsing

| Option | Maintenance (2026-10-10) | Deps / size | Date-only and TZ fidelity | Verdict |
|---|---|---|---|---|
| **`ical.js` 2.2.1** (Mozilla / Thunderbird lineage) | Repo pushed 2026-10-05. Last npm release 2025-08-08. | **0 deps.** 1.2 MB unpacked, server-only. ESM plus `ical.es5.cjs` (Jest-friendly), own types. MPL-2.0 (file-level copyleft only if modified). | `ICAL.Time` keeps `isDate`, wall-clock fields, and the TZID, so we own the semantics. Handles unfolding, escaping, quoted params, VTIMEZONE, RRULE. | ✅ **Choice** |
| `node-ical` 0.27.3 | Active (2026-10-03). | 2 deps (`rrule-temporal`, `temporal-polyfill`, about 1.5 MB). | Converts to JS `Date` up front, and date-only values become server-local midnight, the same class of bug we're fixing. Ships a URL-fetch helper we must never use (SSRF). | ❌ |
| `ts-ics` 2.4.7 | Active (2026-09-28). | 1 dep, MIT. | Keeps DATE vs DATE-TIME but returns `Date`s. Smaller community. | Runner-up |
| Hand-rolled lexer (~120 LOC) | Ours. | 0. | Full control. Canvas output is simple. | Fallback. Weaker for "Other" or self-hosted Canvas. |
| Python `/parse-ical` (V2-08 service) | — | Network hop plus a secret. Couples sync to a service that may not be deployed. | Same lib as V1. | ❌ V2-08 agrees (their §2.10): TS owns iCal. |

**How we use ical.js:** only as a lexer and structure parser. We extract raw values into our own `IcsDateValue` union (`date | utc | zoned(tzid) | floating`), and all instant math goes through V2-06's `src/shared/time/tz.ts` (`zonedToUtc` with explicit gap and overlap handling). Before ical.js sees the text, we **unfold at the byte level** (`CRLF` + SP/HTAB) and then decode UTF-8, because RFC 5545 folds at 75 *octets* and can split a multi-byte character ("Café" would otherwise corrupt). The lexer sits behind `lexIcs()`, so swapping libraries touches one file.

### 2.3 Time semantics (fixes the 7:59pm bug)

The user's zone is `tz = users.timezone` at sync time. Wall times are converted with `zonedToUtc(local, tz)`: gaps shift forward, overlaps take the earlier offset.

| Source value | UID kind | Stored |
|---|---|---|
| `DTSTART:…Z` | assignment | `due_at = instant`, `all_day = false` |
| `DTSTART:…Z` | calendar event | `starts_at = DTSTART`, `ends_at = DTEND ?? DTSTART` |
| `DTSTART;VALUE=DATE:D` | assignment | `due_at = zonedToUtc(D 23:59, tz)`, `all_day = true` ("fancy midnight") |
| `DTSTART;VALUE=DATE:D` | calendar event | `starts_at = zonedToUtc(D 00:00, tz)`, `ends_at = zonedToUtc((DTEND ?? D+1) 00:00, tz)`, `all_day = true` |
| `DTSTART;TZID=X:…` | any | If X is a valid IANA zone, convert in X. Otherwise use the feed VTIMEZONE via ical.js. Otherwise treat as floating. |
| Floating `DTSTART:20261015T170000` | any | Interpret in `tz` |

- **Date-only means 23:59 in the *user's* zone.** Canvas computed `all_day` in the *editor's* zone, which is invisible to us. For a student at their own school these are the same zone. Documented in §13 Q13.
- **The all-day floating date is never pushed through UTC for display.** Web-surfaces requires `allDayDate: "YYYY-MM-DD"`. We take it from the source literal (`timing_key` `D:20261015`), not from `due_at`, so UTC−x users never see a shifted day.
- **Change detection uses the source literal, not the derived instant.** `timing_key` ∈ `D:20261015 | U:20261016T035900Z | Z:America/Chicago:20261015T170000 | F:20261015T170000`. A due change is a `timing_key` change. When `users.timezone` changes, date-only instants are recomputed silently, with no false alert. `rebaseTimeline(userId, tz)` is called from V2-06's `onUserScheduleSettingsChanged` (§8.4).
- **DST:** local-day bucketing uses `[zonedToUtc(D 00:00), zonedToUtc(D+1 00:00))`, so 23-hour and 25-hour days come out right. Midnight-transition zones (America/Santiago early September, **[verify the 2026 date with `Intl` in the test]**) get the first valid instant.

### 2.4 Identity, rekeying, and the diff

- **Key:** `(user_id, 'canvas', external_id = UID)`. Never title plus date.
- **`match_key`:** the Canvas object key from the URL fragment (`assignment_412345`, `calendar_event_77`). Set **only** for `event-assignment-*`, `event-assignment-override-*`, and `event-calendar-event-*`. For sub-assignments it is `null`, because the fragment is the parent's and isn't unique.
- **Rekey rule (pure):** after UID matching, an unmatched current row and an unmatched fresh item sharing a `match_key` **1:1** are a rekey, provided the fresh UID doesn't exist in any row, including removed ones, so the unique key can't collide. `external_id` is updated in place, which keeps the row id, `done` status, and reminder anchors, and the timing comparison then emits `due_changed`. Anything not 1:1 is removed plus created.
- **Duplicate UIDs within one feed:** dedupe and keep the last (file order); counted in `warnings`.
- **Field changes:**
  - `timing_key` change → `due_changed`
  - title, course, url, or kind change → silent upsert with no change entry (course-code edits, items "moving between courses")
  - a UID returning onto a soft-removed row → `created` with `restored: true` (keeps `done`)
- **Initial batch:** the first sync after a connect or a URL change (`ical_url_fp` differs) emits a batch with `initial: true`. V2-06 uses it to create auto-nudges silently. All `deliveryHint` values are `"none"`.

### 2.5 Removal safety

- **Window:** a missing item is removed only if `anchor_at ∈ [now − 29d, now + 365d]`, a one-day margin inside Canvas's 30/366-day window. Items aging out of the feed are kept, so there's never a "Pset 1 was removed" in October.
- **Mass-removal guard:**
  - Trigger: removing **more than 50% and more than 5** of the user's future, non-done Canvas items (an empty feed counts).
  - On trigger: apply creates and updates, **defer removals**, and set `integrations.last_error = 'removal_deferred'`.
  - If the next sync (about an hour later) still lacks them, remove them.
  - This protects against partial or empty feeds during Canvas incidents and term rollovers.
- **Cap saturation:** ≥1,000 items of a kind means Canvas truncated the feed. Skip removals for that kind on that sync.
- **Soft removal:** `removed_at` is hidden from every read. The cleanup cron purges after 120 days.

### 2.6 SSRF hardening (OWASP-aligned)

The URL is attacker-controllable: a malicious user, or injected text the model tries to pass on.

1. **Normalize** (pure, `src/shared/canvas-url.ts`):
   - trim; strip `<>`, quotes, and trailing punctuation
   - `webcal://` and `http://` → `https://`
   - parse with WHATWG `URL`
   - reject: userinfo; a non-default port; IP-literal hosts (decimal, hex, and octal forms included, since WHATWG normalizes them to dotted v4 and we test after parsing); single-label hosts; a query string; `%2f`/`..` after normalization
   - lower-case the host and strip a trailing dot
   - the path must fully match `^/feeds/calendars/user_[A-Za-z0-9]{20,64}\.ics$`
   - drop the fragment
   - **re-serialize from parts** (OWASP: "build the request yourself")
   - reject if re-parsing yields a different host (OWASP: reject URLs parsers disagree on)
2. **Host policy:**
   - `instructure`: `^[a-z0-9-]+(\.[a-z0-9-]+)*\.instructure\.com$`
   - `listed`: exactly a host in `src/shared/universities.ts`
   - `unlisted`: allowed (web-surfaces requires it, so "my school isn't listed" isn't a dead end), **but only accepted when the response proves it's Canvas**: an `x-canvas-meta` header **and** `looksLikeCanvasFeed()` (PRODID `icalendar-ruby`, or a UID matching `^event-(assignment|calendar-event|assignment-override|sub-assignment)-\d+$`, or `X-WR-CALNAME` ending in `(Canvas)`). Requests stay constrained to https:443 and the fixed feed path after IP checks, which leaves negligible blind-SSRF surface.
3. **DNS:** `dns.promises.lookup(host, { all: true, verbatim: true })`. **Every** address must be public (OWASP: check all v4 and v6 addresses).
4. **Public-address policy** (`isPublicAddress`), using `node:net` `BlockList` built from the IANA special-purpose registries:
   - IPv4: `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16` (cloud metadata), `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.88.99/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4`, `240/4`, `255.255.255.255/32`
   - IPv6: `::/128`, `::1/128`, `64:ff9b::/96`, `64:ff9b:1::/48` (NAT64 can reach metadata), `100::/64`, `2001::/23`, `2001:db8::/32`, `2002::/16` (6to4), `fc00::/7`, `fe80::/10`, `ff00::/8`
   - IPv4-mapped and IPv4-compatible v6 is unwrapped and checked as v4
5. **Pinned connection (defeats DNS rebinding):** `node:https.request` with `host: hostname` (so SNI and certificate verification use the real name) and a **custom `lookup`** that returns the already-validated address and never re-resolves (OWASP: connect only to validated addresses). No `fetch`/undici, since global `fetch` can't pin without the `undici` package.
6. **Redirects** are never auto-followed (equivalent to `redirect: 'manual'`). For each 3xx, resolve `Location` against the current URL and re-run steps 1–5, including the path regex. At most **3 hops**. A redirect to a non-feed path (`/login`) → `feed_invalid`.
7. **Limits:**
   - connect 5s; headers 10s; total 20s
   - body cap **10 MiB**, streamed, counted on *decompressed* bytes when gzip (zip-bomb safe)
   - `Accept-Encoding: gzip`; `Accept: text/calendar`; `User-Agent: AriaCalendarSync/1.0 (+<APP_BASE_URL>)`; no cookies
8. **Content:**
   - 200 with `text/calendar` (also tolerate `text/plain` and `application/octet-stream`)
   - the body must start with `BEGIN:VCALENDAR` after BOM and whitespace
   - 200 `text/html` → `not_calendar`
9. **Logging:** the URL is a bearer secret. Log only `host` plus `fp8`; never the path, the body, or titles.

**Failure classes:**

| Result | Class |
|---|---|
| 200 + valid | `ok` |
| 400 + `n=public_feed`, 404, 410, redirect to login | `definitive` (`feed_not_found`) |
| 401/403 (may be a WAF blocking our egress, as `canvas.virginia.edu`'s Cloudflare showed) | `slow_transient` |
| 429, 5xx, timeout, DNS failure, TLS error, cap | `transient` |
| policy rejections (host, IP, path, redirect) | `rejected` (at connect, returned to the user; at sync, treated as definitive) |

### 2.7 Scheduling, backoff, and revocation

- **Source of truth:** `integrations.next_sync_at`. A **pg_cron statement every 5 minutes** materializes `canvas_sync` jobs for due integrations. It dedupes on the pending `dedupe_key = 'canvas_sync:<user_id>'` and skips users with a pending or running `canvas_sync` (§4). Unlike a self-re-enqueue chain, it can't die when one job dead-letters. V2-07 enqueues the same kind and key on a Canvas "due date changed" email, and the dedupe makes that safe.
- **Deterministic per-user jitter:** `slotMinute = parseInt(sha256(userId)[0..8], 16) % 60`. `next_sync_at` = the first `hour + slotMinute` more than 30 minutes after now (30–90 min, about 60 on average), plus 0–59s random.
- **Lease:** `integrations.sync_lease_until` is claimed by a conditional UPDATE (2 minutes), so connect and a scheduled job never overlap.
- **Backoff** (transient): `[5m, 15m, 45m, 2h, 6h][min(n−1, 4)]` ×0.8–1.2. It resets on success. The handler records the failure and **returns normally**, so there's no double backoff with the dispatcher.
- **Revocation:** `definitive` on **3 consecutive** syncs spanning at least 2 hours → `status = 'revoked'`, `next_sync_at = null`. Then notify **once** (`status_notified_at`) via `deliver(userId, plan, { proactive: true, reason: 'canvas_feed_revoked', idempotencyKey: 'canvas_revoked:<userId>:<fp8>' })` with a `setup` magic link. If minting is rate-limited, the copy says "text me 'canvas' for a fresh setup link".
- **Long outage:** transient or slow-transient failures for **48h** → `status = 'error'`, notify once, and keep retrying every 6h.
- **Reconnect** resets all of this.
- **Skip unchanged:** `feed_hash = sha256(body ‖ tz)`. If unchanged, skip parse and diff and just reschedule. ETag/304 is possible later **[verify that Canvas sends an ETag]**.

### 2.8 Change batches (contract with V2-06)

V2-06 consumes a `TimelineChangeBatch` (shape in §8.3) via **its** job kind `timeline_changes`:
- After every committed sync with a non-empty change list, V2-05 calls `enqueueJob({ kind: 'timeline_changes', userId, payload: batch, dedupeKey: 'tlc:<userId>:<syncRunId>' })`. `syncRunId` is a uuid per run. It's at-least-once, and V2-06 is idempotent.
- `setTimelineItemStatus` (mark done, dismiss, undo) calls V2-06's `handleTimelineChanges` **synchronously** with a `status_changed` change. It does this through the subscriber registry in `src/server/timeline/hooks.ts`, so the timeline module doesn't import V2-06 code.
- Each change carries a **`deliveryHint`** from V2-05's pure `classifyDelivery` (§8.3): the spec's "≤7 days → immediate, else next briefing" rule plus guards. **V2-06's handler makes the final decision** and owns the persistence for "next briefing" (its `briefing_notes`). That's why V2-05 needs no change-log table.
- **Syllabus changes are always `deliveryHint: "none"`** (V2-08's rule). gcal changes are `"none"` too, because that's the user's own calendar.

### 2.9 Connect paths

- **Web:**
  - Web-surfaces W5 owns the UI and calls `connectCanvas({ userId, rawUrl, schoolName })` from its server action, which checks `fresh_setup` (`canChangeIntegrations`), the rate limit, and zod.
  - `connectCanvas` itself re-checks everything security-relevant (URL policy, SSRF, its own per-user rate limit), so it is safe whichever caller uses it.
  - It runs validate → fetch → parse → initial apply **synchronously** (about 25s worst case, inside Vercel's 300s).
  - Then Aria texts the summary: `deliver(…, { proactive: false, reason: 'canvas_connected' })`.
  - **No separate `/api/canvas/connect` route** is built (web-surfaces uses a server action). If the orchestrator wants the spec's route anyway, it's a 30-line wrapper with the same checks.
- **Chat:** the student pastes the URL, and the model calls `connect_canvas`. The **tool, not the model, takes the URL from user-authored text**:
  - It scans this run's inbound messages (`messages.consumed_by_run = ctx.runId`, `direction = 'in'`), falling back to the user's inbound messages from the last 30 minutes, using `findCanvasFeedUrls`.
  - An optional `url` argument must match one of those. Otherwise the tool refuses (`not_user_authored`), enforcing friend-protection #2 against injected email or Canvas text.
  - The model never transcribes the 60-char secret, which also avoids Haiku typos.
- **After a chat connect:** the URL is **redacted** in those inbound `messages.body` rows (`[Canvas feed link saved]`), so the secret doesn't persist in history or later prompts (coordination with V2-03, §8.4).
- **Summary:** `"found 14 deadlines across 4 courses — next up: Pset 4 (CPSC 323), due Thu 11:59pm"`. Deadlines = non-removed `assignment`/`exam` items with `due_at ≥ now`. Courses = distinct `courseKey` among them. Zero is success, not an error (V1 treated it as one): "connected, but I don't see upcoming deadlines yet. That's normal before the term starts."
- **Duplicate feed:** `ical_url_fp` (HMAC-SHA256 of the normalized URL under an HKDF subkey of `APP_ENCRYPTION_KEY`) is unique across users → `already_connected_elsewhere`.
- **Profile refresh:** after a sync that changes the set of course keys, call V2-04's `refreshProfileBlock(userId)`.

### 2.10 Timeline module: one API for six consumers

| Consumer | Needs | API (names adopted from their plans) |
|---|---|---|
| Canvas sync (V2-05) | full snapshot diff with rekey, window, and guard | `applySnapshot` |
| GCal (V2-07) | window replace; single upsert; source wipe on disconnect | `replaceSourceWindow`, `upsertTimelineItem`, `deleteTimelineItems` |
| Syllabus (V2-08) | batch upsert plus prefix prune; term hint | `upsertTimelineItems`, `pruneTimelineItems`, `termHintForCourse` |
| Agent tools (V2-04) | range list, search, mark done, refs, rendering | `listTimeline`, `searchTimeline`, `markItemDone`, `resolveItemRef`, `renderTimelineForModel` |
| Briefing and alerts (V2-06) | list, urgency score, change batches, status hook | `listItems` (alias of `listTimeline`), `urgencyScore`, the `timeline_changes` batch, hook registry |
| Web `/week` and `/setup` (web-surfaces) | list with overdue; status; Canvas status | `listTimeline(userId, {from,to}, {includeDone, overdueSince})`, `setTimelineItemStatus`, `getCanvasStatus`, `connectCanvas`, `disconnectCanvas` |

- **Urgency is computed at read time** (`toView`), never stored.
- **Cross-source de-duplication at read time:** delegated to V2-08's `collapseSyllabusDuplicates(items, tz)`, called once inside `listTimeline`/`searchTimeline`. Until V2-08 lands, it's identity.
- **Search:** pure TS over the user's non-removed items in the window (a few hundred rows). Token AND-match over title and course, with a `courseKey` alias (`"323"` / `"cpsc323"` match `CPSC 323 01 (FA26)`), ranked by match quality then nearest upcoming. No trigram index and no PostgREST `or()` escaping pitfalls.
- **Refs:** the model sees `t_` + the first 8 hex chars of the uuid (V2-04's `t_` prefix). `resolveItemRef` accepts `t_xxxxxxxx` or a full uuid and queries `id between 'xxxxxxxx-0000-…' and 'xxxxxxxx-ffff-…'` for this user (index-backed). More than one row → `ambiguous`.
- **Untrusted text:** titles and courses are instructor-authored. `renderTimelineForModel` wraps the list with V2-04's `wrapUntrusted({ source: 'canvas' | 'calendar' | 'syllabus', body })`.

### 2.11 Failure modes

| Failure | Handling |
|---|---|
| Feed revoked, user removed, or school left Canvas | 400 `public_feed` / 404 ×3 over ≥2h → `revoked`; notify once with a setup link |
| WAF 403 on our egress IP | slow-transient → after 48h, `error` + notify once; **[verify]** from Vercel `iad1` |
| Huge feed | 10 MiB streaming cap; Canvas bounds it to about 2k items; O(n) parse; one RPC per sync |
| Partial or empty feed (incident, rollover) | mass-removal guard defers removals by one sync |
| Items aging out of the window | window-scoped removal |
| Extension or override (UID swap) | 1:1 `match_key` rekey → `due_changed` |
| Duplicate UIDs | dedupe, last wins, warning |
| Course code edited, or item moved courses | silent upsert |
| Assignment deleted or unpublished | soft-remove + `removed` change (V2-06 cancels nudges); a return emits `created` + `restored` |
| Item done, then the due date moves | stays `done`; `deliveryHint: none` |
| Timezone changed | `timing_key` unchanged → no change entry; `rebaseTimeline` recomputes |
| DST (23h/25h days, midnight-transition zones) | `tz.ts` gap and overlap rules; NY spring, NY fall, and Santiago fixtures |
| Concurrent connect and scheduled sync | `sync_lease_until` lease |
| Double enqueue (cron, V2-07 hint) | partial unique `dedupe_key` + `not exists pending/running` |
| Crash mid-apply | one RPC transaction (`timeline_apply`); the change batch is enqueued only after commit; the next sync recomputes |
| Crash after commit, before enqueue | that sync's batch is lost. Bounded: the next sync sees no diff. Mitigation: enqueue failure → log + retry once; acceptable for the free test (§13 Q18). |
| Prompt injection in titles or descriptions | descriptions never in context; titles wrapped untrusted; connect only from user-authored URLs |
| Secret leakage | AES-256-GCM `v1:` at rest; fingerprint in logs; redacted from chat history |

### 2.12 Cost

- **LLM: $0.** Everything here is deterministic.
- **Per sync:** one HTTPS GET (estimated 50–500 KB **[verify]**), about 10–50 ms of CPU, one RPC.
- **Free test:** 4 users → 96 syncs a day.
- **5k users:** about 120k invocations a day, mostly I/O wait (not active CPU on Vercel Fluid). Batch users per job if invocation counts ever matter.
- **Upstash:** none.

---

## 3. External facts with URLs

All accessed 2026-10-10.

1. **Canvas ICS generation (SUMMARY `[course_code]`, override suffix, UID patterns, UTC DTSTART with seconds zeroed, `VALUE=DATE` without DTEND, URL fragment set before overrides, DESCRIPTION / X-ALT-DESC when visible):** `CalendarEvent::IcalEvent#to_ics`, https://github.com/instructure/canvas-lms/blob/master/app/models/calendar_event.rb (about lines 762–885).
2. **Assignment `all_day` iff due at 23:59 in the editing zone; default due time "fancy midnight":** `all_day_interpretation`, `infer_times`, `infer_all_day`, https://github.com/instructure/canvas-lms/blob/master/app/models/abstract_assignment.rb
3. **Feed contents and window (`30.days.ago`…`366.days.from_now`, `paginate(per_page: 1000, max: 1000)`, `X-WR-CALNAME "… Calendar (Canvas)"`, `METHOD:PUBLISH`):** `public_feed`, https://github.com/instructure/canvas-lms/blob/master/app/controllers/calendar_events_api_controller.rb
4. **Feed-code resolution (`user_`, `enrollment_`, `group_membership_`, context types); invalid → `unauthorized_feed`, `status: :bad_request`:** `get_feed_context`, https://github.com/instructure/canvas-lms/blob/master/app/controllers/application_controller.rb
5. **Routes `/feeds/calendars/:feed_code(.:format)`:** https://github.com/instructure/canvas-lms/blob/master/config/routes.rb
6. **Feed uuid `SecureRandom.alphanumeric(40)`:** https://github.com/instructure/canvas-lms/blob/master/gems/canvas_slug/lib/canvas_slug.rb
7. **icalendar-ruby: `tzid: "UTC"` → `…Z`, TZID dropped; default `PRODID:icalendar-ruby`:**
   - https://github.com/icalendar/icalendar/blob/main/lib/icalendar/values/helpers/time_with_zone.rb
   - https://github.com/icalendar/icalendar/blob/main/lib/icalendar/values/date_time.rb
   - https://github.com/icalendar/icalendar/blob/main/lib/icalendar/calendar.rb
   - Canvas pins `icalendar ~> 2.9`: https://github.com/instructure/canvas-lms/blob/master/Gemfile.d/app.rb
8. **Instructure Student Guide, "How do I view the Calendar iCal feed to subscribe to an external calendar as a student?":** the link is in the Calendar sidebar; 30 days past to 366 future; up to 1,000 items; To-Do items not included. https://community.canvaslms.com/t5/Student-Guide/How-do-I-view-the-Calendar-iCal-feed-to-subscribe-to-an-external/ta-p/331
9. **Live probes (2026-10-10, `curl`/`dig` from this agent):**
   - `GET https://<host>/feeds/calendars/user_abc.ics` → `HTTP/2 400`, `text/html`, `x-canvas-meta: …o=calendar_events_api;n=public_feed…` on `yale.instructure.com`, `gatech.instructure.com`, `canvas.ucdavis.edu`, `psu.instructure.com`, `princeton.instructure.com`, `canvas.its.virginia.edu`, `arizona.instructure.com`.
   - No account → 404 with `x-canvas-meta` but no `n=public_feed`: `vanderbilt.instructure.com`, `columbia.instructure.com`.
   - Vanity domains CNAME to `<school>-vanity.instructure.com` (for example `canvas.harvard.edu`).
   - **Errors found in the V1 school list:**
     - `canvas.columbia.edu` doesn't resolve; real host `courseworks2.columbia.edu` (CNAME `columbiasce.instructure.com`)
     - `canvas.psu.edu` → 301 to an IT page; Canvas at `psu.instructure.com`
     - `canvas.princeton.edu` is an Acquia info site (403); Canvas at `princeton.instructure.com`
     - `canvas.virginia.edu` is Cloudflare (403/404); Canvas at `canvas.its.virginia.edu`
     - `canvas.arizona.edu` doesn't resolve; `arizona.instructure.com` is Canvas **[verify that students use it]**
     - `vanderbilt.instructure.com` has no account (Vanderbilt is on Brightspace)
   - Yale: `yale.instructure.com` is Canvas; `canvas.yale.edu` is not.
10. **OWASP SSRF Prevention Cheat Sheet:** allow-list and build the request yourself; allow-listing alone doesn't stop DNS rebinding; connect to validated IPs while keeping the hostname for SNI and certificates; disable redirects; check all v4 and v6 addresses; IANA registries; reject URLs parsers disagree on. https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
11. **IANA special-purpose registries:**
    - https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml
    - https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry.xhtml
12. **Node.js v22 (the repo runs v22.16.0):**
    - `net.BlockList`: https://nodejs.org/api/net.html#class-netblocklist
    - the `lookup` option of `http(s).request`: https://nodejs.org/api/http.html#httprequestoptions-callback
    - `dns.promises.lookup` `{ all, verbatim }`: https://nodejs.org/api/dns.html#dnspromiseslookuphostname-options
    - zlib: https://nodejs.org/api/zlib.html
13. **RFC 5545:** §3.1 folding at 75 octets; §3.3.5 DATE-TIME forms; §3.8.2.4 DTSTART `VALUE=DATE`. https://www.rfc-editor.org/rfc/rfc5545
14. **npm registry and GitHub API:**
    - `ical.js` 2.2.1, published 2025-08-08T06:10Z, 0 deps, MPL-2.0, exports `import: ./dist/ical.js`, `require: ./dist/ical.es5.cjs`, types `dist/types/module.d.ts`. Repo pushed 2026-10-05.
    - `node-ical` 0.27.3 (2026-10-03; deps `rrule-temporal`, `temporal-polyfill`).
    - `ts-ics` 2.4.7 (2026-09-28).
    - https://registry.npmjs.org/ical.js · https://github.com/kewisch/ical.js
15. **Vercel Functions limits:** Hobby 300s and 2 GB; I/O wait isn't active CPU. https://vercel.com/docs/functions/limitations

---

## 4. Schema delta

For the orchestrator's `003_v2_build.sql`. **Not a migration file.**

```sql
-- ══ V2-05: timeline + Canvas ══════════════════════════════════════════

-- timeline_items: all-day flag, source-literal timing key (change detection
-- independent of timezone), Canvas object key (rekey on override UID swaps),
-- soft removal, generated anchor for range queries.
alter table public.timeline_items
  add column all_day    boolean not null default false,
  add column timing_key text,
  add column match_key  text,
  add column removed_at timestamptz,
  add column anchor_at  timestamptz generated always as (coalesce(due_at, starts_at)) stored;

alter table public.timeline_items
  add constraint timeline_items_status_check
  check (status in ('upcoming','done','dismissed'));

create index timeline_items_user_anchor_idx
  on public.timeline_items (user_id, anchor_at) where removed_at is null;
create index timeline_items_user_match_idx
  on public.timeline_items (user_id, source, match_key) where match_key is not null;

-- integrations: Canvas sync bookkeeping (no secrets in clear).
alter table public.integrations
  add column ical_host            text,         -- 'yale.instructure.com' (not secret)
  add column ical_url_fp          text,         -- HMAC-SHA256(hkdf(APP_ENCRYPTION_KEY), normalized url), hex
  add column sync_lease_until     timestamptz,
  add column consecutive_failures int not null default 0,
  add column first_failure_at     timestamptz,
  add column last_error           text,         -- error CODE only
  add column last_error_at        timestamptz,
  add column feed_hash            text,         -- sha256(body || tz)
  add column status_notified_at   timestamptz;

-- Same values as V2-07's plan; keep ONE copy of this constraint in 003.
alter table public.integrations
  add constraint integrations_status_check
  check (status in ('active','error','revoked','disconnected'));

create unique index integrations_ical_url_fp_key
  on public.integrations (ical_url_fp)
  where provider = 'canvas_ical' and ical_url_fp is not null;
create index integrations_canvas_next_sync_idx
  on public.integrations (next_sync_at)
  where provider = 'canvas_ical' and status in ('active','error');

-- Atomic apply of one computed diff: rekeys → upserts → soft-removes.
-- Returns [{id, external_id}] of every touched row so TS can build the change batch.
create or replace function public.timeline_apply(
  p_user_id    uuid,
  p_source     text,
  p_rekeys     jsonb  default '[]'::jsonb,   -- [{id, new_external_id}]
  p_upserts    jsonb  default '[]'::jsonb,   -- [{external_id, kind, title, course, starts_at, ends_at, due_at, all_day, url, timing_key, match_key, raw}]
  p_remove_ids uuid[] default '{}'
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_out jsonb;
begin
  update timeline_items t
     set external_id = r.new_external_id, updated_at = v_now
    from jsonb_to_recordset(p_rekeys) as r(id uuid, new_external_id text)
   where t.id = r.id and t.user_id = p_user_id and t.source = p_source;

  insert into timeline_items as t
    (user_id, source, external_id, kind, title, course, starts_at, ends_at, due_at,
     all_day, url, timing_key, match_key, raw, removed_at, updated_at)
  select p_user_id, p_source, u.external_id, u.kind, u.title, u.course, u.starts_at,
         u.ends_at, u.due_at, coalesce(u.all_day, false), u.url, u.timing_key,
         u.match_key, u.raw, null, v_now
    from jsonb_to_recordset(p_upserts) as u(
         external_id text, kind text, title text, course text,
         starts_at timestamptz, ends_at timestamptz, due_at timestamptz,
         all_day boolean, url text, timing_key text, match_key text, raw jsonb)
  on conflict (user_id, source, external_id) do update set
         kind = excluded.kind, title = excluded.title, course = excluded.course,
         starts_at = excluded.starts_at, ends_at = excluded.ends_at,
         due_at = excluded.due_at, all_day = excluded.all_day, url = excluded.url,
         timing_key = excluded.timing_key, match_key = excluded.match_key,
         raw = excluded.raw, removed_at = null, updated_at = v_now;

  update timeline_items
     set removed_at = v_now, updated_at = v_now
   where user_id = p_user_id and source = p_source
     and id = any(p_remove_ids) and removed_at is null;

  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'external_id', t.external_id)), '[]'::jsonb)
    into v_out
    from timeline_items t
   where t.user_id = p_user_id and t.source = p_source
     and (   t.external_id in (select x->>'external_id' from jsonb_array_elements(p_upserts) x)
          or t.id = any(p_remove_ids)
          or t.id in (select (x->>'id')::uuid from jsonb_array_elements(p_rekeys) x));

  return v_out;
end;
$$;

revoke all on function public.timeline_apply(uuid, text, jsonb, jsonb, uuid[])
  from public, anon, authenticated;
grant execute on function public.timeline_apply(uuid, text, jsonb, jsonb, uuid[])
  to service_role;

-- Materialize due Canvas syncs as jobs every 5 min (DB is the source of truth).
-- Relies on the baseline partial unique index jobs(dedupe_key) where status='pending'.
select cron.schedule('canvas-sync-enqueue', '*/5 * * * *', $cron$
  insert into public.jobs (kind, user_id, run_at, dedupe_key)
  select 'canvas_sync', i.user_id, greatest(i.next_sync_at, now()), 'canvas_sync:' || i.user_id
    from public.integrations i
    join public.users u on u.id = i.user_id and u.deleted_at is null
   where i.provider = 'canvas_ical'
     and i.status in ('active','error')
     and i.next_sync_at is not null
     and i.next_sync_at <= now() + interval '5 minutes'
     and not exists (
       select 1 from public.jobs j
        where j.dedupe_key = 'canvas_sync:' || i.user_id
          and j.status in ('pending','running'))
  on conflict (dedupe_key) where status = 'pending' and dedupe_key is not null do nothing;
$cron$);

-- Daily purge of long soft-removed items.
select cron.schedule('timeline-cleanup', '17 4 * * *', $cron$
  delete from public.timeline_items where removed_at < now() - interval '120 days';
$cron$);
```

**Notes:**
- Regenerate `src/server/db/types.ts` after 003; this picks up `Functions.timeline_apply`.
- **No new tables**, so there's no new RLS to enable. Change batches travel in V2-06's `timeline_changes` job payload. If the orchestrator later wants an audit log, add a table with `enable row level security`.
- If V2-03 ships a generic periodic mechanism, swap `canvas-sync-enqueue` for it (§13 Q9).

---

## 5. Dependencies

| Package | Version | Published | Why | Notes |
|---|---|---|---|---|
| `ical.js` | **2.2.1** (exact) | 2025-08-08 | RFC 5545 lexer and parser | 0 transitive deps, MPL-2.0. Jest: if ESM resolution fails, add `moduleNameMapper: { '^ical\\.js$': '<rootDir>/node_modules/ical.js/dist/ical.es5.cjs' }`. |

**Nothing else.**
- DNS, IP policy, the pinned HTTPS client, gzip, and HMAC/HKDF use Node built-ins (`node:dns`, `node:net`, `node:https`, `node:zlib`, `node:crypto`).
- `zod` (already `^4.6.5`) for job and tool input.
- No `undici`, `ipaddr.js`, `date-fns-tz`, or `node-ical`.

---

## 6. Environment variables

| Var | Required | Default | Purpose |
|---|---|---|---|
| `APP_ENCRYPTION_KEY` | yes (exists) | — | AES-256-GCM for `enc_ical_url`. HKDF subkey (`info = "aria/ical-url-fp/v1"`) for `ical_url_fp`. |
| `APP_BASE_URL` | prod (exists) | — | User-Agent contact URL; setup links |
| `CANVAS_FEED_MAX_BYTES` | no | `10485760` | Decompressed body cap |
| `CANVAS_SYNC_DISABLED` | no | unset | `"1"` makes `canvas_sync` a no-op that reschedules (kill-switch) |
| `CANVAS_LIVE_TEST_URL` | tests only | unset | Enables the opt-in live test. **Never commit.** |

No new required env vars.

---

## 7. File plan

JSDoc on every export. No `any`. Server files never imported from `"use client"` files.

### 7.1 `src/shared/` (pure; client-safe)

**`src/shared/universities.ts`.** The salvaged 52-school list, corrected per §3.9 (Vanderbilt removed, so 51 entries), plus "Other". It merges the exports web-surfaces asked for.
```ts
export interface University { name: string; canvasDomain: string }
export const UNIVERSITIES: readonly University[];
export const OTHER_UNIVERSITY = "Other" as const;
/** Host (no scheme) for a school name, case-insensitive; null for unknown/"Other". (web-surfaces name) */
export function canvasHostForSchool(name: string | null): string | null;
/** "https://<host>" for a school, or null. (V1 canvasDomainForUniversity, renamed) */
export function canvasBaseUrlForUniversity(name: string | null): string | null;
/** "https://<host>/calendar" for the "Open Canvas" button, or null. */
export function canvasCalendarUrlForUniversity(name: string | null): string | null;
/** "https://x.edu/..." | "x.edu" → "x.edu" (lower-case, no trailing dot), or null. (web-surfaces name) */
export function normalizeCanvasHost(input: string): string | null;
/** True if host is exactly a listed Canvas domain. */
export function isListedCanvasHost(host: string): boolean;
export function universityForCanvasHost(host: string): University | null;
```

**`src/shared/canvas-url.ts`.**
```ts
export const CANVAS_FEED_PATH_RE: RegExp;     // ^/feeds/calendars/user_[A-Za-z0-9]{20,64}\.ics$
export type CanvasHostClass = "instructure" | "listed" | "unlisted";
export type FeedUrlError =
  | "empty" | "not_a_url" | "bad_scheme" | "has_credentials" | "bad_port" | "ip_literal"
  | "bad_host" | "has_query" | "course_feed" | "not_feed_path" | "parser_mismatch";
export interface CanvasFeedUrl { href: string; host: string; hostClass: CanvasHostClass }
export type NormalizeResult = { ok: true; url: CanvasFeedUrl } | { ok: false; error: FeedUrlError };
/** Full normalization + shape + host class (server and client). */
export function normalizeCanvasFeedUrl(input: string): NormalizeResult;
/** Client pre-check shape requested by web-surfaces (wrapper over normalizeCanvasFeedUrl). */
export function precheckIcalUrl(raw: string): { ok: true; normalized: string } | { ok: false; code: "empty" | "not_a_url" | "not_ical" };
export function classifyCanvasHost(host: string): CanvasHostClass;
/** Canvas-feed URLs found in free text (user chat), normalized, deduped, in order. */
export function findCanvasFeedUrls(text: string): CanvasFeedUrl[];
/** Replace feed URLs (any accepted spelling) in text with a placeholder. */
export function redactCanvasFeedUrls(text: string, placeholder?: string): string;
/** "yale.instructure.com/feeds/…a1b2" (last 4 of the id) for status UIs. */
export function feedUrlHint(url: CanvasFeedUrl): string;
```

**`src/shared/canvas-guide.ts`.** Salvaged copy (strings only), used by W5's UI and the chat tool.
```ts
export const CANVAS_GUIDE_STEPS: readonly string[];
export const CANVAS_ERROR_COPY: Record<CanvasConnectError, string>;
export interface ConnectSummaryShape { deadlines: number; courses: string[]; nextDue: { title: string; course: string | null; label: string } | null }
/** "found 14 deadlines across 4 courses — next up: Pset 4 (CPSC 323), due Thu 11:59pm" (lowercase-casual). */
export function formatConnectSummary(s: ConnectSummaryShape): string;
```

Guide steps (from `tools.tsx`, adapted to the web and the "Calendar Feed" sidebar link):
1. "Tap **Open Canvas** (or open Canvas in your browser) and go to **Calendar**."
2. "On the right (at the bottom on a phone), tap **Calendar Feed**. A box pops up with your link."
3. "Copy it and paste it here. Or just text it to Aria."

Error copy follows `tools.tsx:144-190` and `CanvasUrlInput.tsx`. For example:
- `not_ical`: "That doesn't look like a Canvas calendar feed link. It should look like `https://yourschool.instructure.com/feeds/calendars/user_….ics`."
- `unreachable`: "Couldn't reach that Canvas feed. Double-check the URL."
- `course_feed`: "That's one course's feed. Grab the one under **Calendar Feed** on your Calendar page so I get all your classes."

`CanvasConnectError` is defined in §7.2 `connect.ts` and re-exported here as a type-only import.

### 7.2 `src/server/integrations/canvas/`

**`ssrf.ts`.**
```ts
/** True only for globally routable unicast (IANA special-purpose rejected; v4-mapped v6 unwrapped). */
export function isPublicAddress(ip: string): boolean;
export interface ResolvedAddress { address: string; family: 4 | 6 }
export type Resolver = (host: string) => Promise<ResolvedAddress[]>;
export const systemResolver: Resolver;   // dns.promises.lookup(host, { all: true, verbatim: true })
export type ResolveResult = { ok: true; pinned: ResolvedAddress; all: ResolvedAddress[] } | { ok: false; error: "dns_failed" | "non_public_address" };
/** Resolve; require every address public; pin one (prefer IPv4). */
export async function resolvePublicHost(host: string, resolver?: Resolver): Promise<ResolveResult>;
```

**`fetch-feed.ts`.**
```ts
export type FeedFetchErrorCode =
  | "feed_not_found" | "forbidden" | "rate_limited" | "server_error" | "timeout"
  | "dns_failed" | "non_public_address" | "tls_error" | "too_large" | "not_calendar"
  | "redirect_rejected" | "too_many_redirects" | "network";
export type FeedFetchClass = "ok" | "definitive" | "slow_transient" | "transient" | "rejected";
export interface FeedFetchOk { ok: true; body: Uint8Array; finalUrl: CanvasFeedUrl; contentType: string; canvasMeta: boolean }
export interface FeedFetchErr { ok: false; code: FeedFetchErrorCode; cls: FeedFetchClass; status?: number }
export interface PinnedRequest { url: URL; pinned: ResolvedAddress; headers: Record<string, string>; timeoutMs: number }
export interface PinnedResponse { status: number; headers: Record<string, string | undefined>; body: AsyncIterable<Uint8Array>; abort(): void }
export interface FeedTransport { request(args: PinnedRequest): Promise<PinnedResponse> }   // injectable for tests
/** node:https with `lookup` pinned to args.pinned (never re-resolves); servername = url.hostname. */
export const httpsTransport: FeedTransport;
export interface FetchFeedOptions { resolver?: Resolver; transport?: FeedTransport; maxBytes?: number; maxRedirects?: number; totalTimeoutMs?: number }
/** SSRF-safe fetch of a normalized feed URL. Never throws for network/policy errors. */
export async function fetchCanvasFeed(url: CanvasFeedUrl, opts?: FetchFeedOptions): Promise<FeedFetchOk | FeedFetchErr>;
/** Status + headers + content-type → error/class (pure). */
export function classifyHttpFailure(status: number, headers: Record<string, string | undefined>, contentType: string): FeedFetchErr;
```

**`ics.ts`.**
```ts
export interface Wall { year: number; month: number; day: number; hour: number; minute: number; second: number }
export type IcsDateValue =
  | { kind: "date"; year: number; month: number; day: number }
  | { kind: "utc"; iso: string }
  | { kind: "zoned"; tzid: string; wall: Wall; utcFromVtimezone: string | null }
  | { kind: "floating"; wall: Wall };
export interface IcsEvent { uid: string | null; summary: string; dtstart: IcsDateValue | null; dtend: IcsDateValue | null; url: string | null; description: string | null; dtstamp: string | null }
export interface IcsCalendar { prodid: string | null; calName: string | null; events: IcsEvent[]; parseWarnings: number }
/** Byte-level unfold → UTF-8 decode → ical.js. Throws IcsParseError on non-calendar input. */
export function lexIcs(bytes: Uint8Array): IcsCalendar;
export class IcsParseError extends Error {}
/** "D:20261015" | "U:20261016T035900Z" | "Z:<tzid>:20261015T170000" | "F:20261015T170000". */
export function timingKeyOf(v: IcsDateValue): string;
```

**`parse.ts`.** Canvas → `TimelineItemInput[]` (pure).
```ts
export interface CanvasParseContext { timezone: string; host: string }
export interface ParsedCanvasFeed {
  items: TimelineItemInput[];
  counts: { assignments: number; events: number };
  warnings: { duplicateUids: number; skippedNoStart: number; skippedNoUid: number; capSaturated: { assignments: boolean; events: boolean } };
  looksLikeCanvas: boolean;
}
export function parseCanvasFeed(cal: IcsCalendar, ctx: CanvasParseContext): ParsedCanvasFeed;
/** "Lab [Part 2] [CHEM 134L]" → { title: "Lab [Part 2]", course: "CHEM 134L" }; none → course null. Linear-time regex. */
export function splitSummary(summary: string): { title: string; course: string | null };
export type CanvasUidKind = "assignment" | "assignment_override" | "sub_assignment" | "calendar_event" | "unknown";
export function uidKind(uid: string): CanvasUidKind;
/** exam iff /\b(mid-?terms?|exams?|final exam|prelims?)\b/i and not /\b(practice|review|prep|study|corrections?|wrapper|reflection)\b/i. */
export function inferKind(k: CanvasUidKind, title: string): "assignment" | "exam" | "event";
export function matchKeyOf(k: CanvasUidKind, url: string | null): string | null;
/** Same-host direct link (/courses/<cid>/assignments/<id>), else same-host calendar URL, else null. */
export function deriveItemUrl(calendarUrl: string | null, feedHost: string): string | null;
/** §2.3 (uses zonedToUtc from src/shared/time/tz.ts). */
export function resolveTiming(kind: "assignment" | "exam" | "event", k: CanvasUidKind, dtstart: IcsDateValue, dtend: IcsDateValue | null, tz: string): { dueAt: Date | null; startsAt: Date | null; endsAt: Date | null; allDay: boolean };
```
- Caps: title ≤ 300 chars, course ≤ 100, url ≤ 2048, `raw.description` ≤ 1,000 chars of plain text.
- `raw = { uid, dtstart, dtend, calendar_url, description, dtstamp }`, all literals.

**`schedule.ts`.** Pure.
```ts
export function userSlotMinute(userId: string): number;
/** First hour+slot strictly > now+30min, plus 0..59s random (rand injectable). */
export function nextHourlySync(userId: string, now: Date, rand?: () => number): Date;
/** n≥1: 5m,15m,45m,2h,6h cap, ×0.8–1.2. */
export function backoffDelayMs(n: number, rand?: () => number): number;
export type FailureDecision = { action: "retry"; at: Date } | { action: "revoke" } | { action: "error_notify"; at: Date };
export function decideAfterFailure(i: { cls: FeedFetchClass; consecutiveFailures: number; firstFailureAt: Date | null; now: Date; alreadyNotified: boolean }): FailureDecision;
```

**`store.ts`.** Integration row (DB).
```ts
export interface CanvasIntegration { id: string; userId: string; status: "active" | "error" | "revoked" | "disconnected"; host: string | null; urlFp: string | null; nextSyncAt: Date | null; syncedAt: Date | null; consecutiveFailures: number; firstFailureAt: Date | null; lastError: string | null; feedHash: string | null; statusNotifiedAt: Date | null }
export function feedUrlFingerprint(href: string): string;
export async function getCanvasIntegration(userId: string): Promise<CanvasIntegration | null>;
export async function readFeedUrl(userId: string): Promise<CanvasFeedUrl | null>;         // decrypts; never logged
/** Upsert the canvas_ical row: encrypt URL, host, fp; reset failure state; status active. Unique fp violation → "already_connected_elsewhere". */
export async function saveCanvasIntegration(userId: string, url: CanvasFeedUrl): Promise<{ ok: true; urlChanged: boolean } | { ok: false; code: "already_connected_elsewhere" }>;
export async function claimSyncLease(userId: string, ms?: number): Promise<boolean>;
export async function releaseSyncLease(userId: string): Promise<void>;
export async function recordSyncSuccess(userId: string, p: { feedHash: string; nextSyncAt: Date; lastError: "removal_deferred" | null }): Promise<void>;
export async function recordSyncFailure(userId: string, p: { code: string; decision: FailureDecision; now: Date }): Promise<void>;
export async function markStatusNotified(userId: string): Promise<void>;
export async function deleteCanvasIntegration(userId: string): Promise<void>;
```

**`sync.ts`.**
```ts
export type CanvasSyncReason = "scheduled" | "connect" | "manual" | "email_hint";
export type CanvasSyncOutcome =
  | { ok: true; skipped: "unchanged" | "lease_held" | "disabled" | null; initial: boolean; result: ApplyResult; warnings: ParsedCanvasFeed["warnings"] }
  | { ok: false; code: FeedFetchErrorCode | "parse_error" | "not_canvas" | "no_integration" | "internal"; cls: FeedFetchClass };
/** Lease → decrypt → fetch → lex → parse → applySnapshot (enqueues the change batch) → schedule next; failure bookkeeping; one-time notices. */
export async function runCanvasSync(userId: string, opts: { reason: CanvasSyncReason; now?: Date; urlOverride?: CanvasFeedUrl; initial?: boolean }): Promise<CanvasSyncOutcome>;
```

**`connect.ts`.** Names and result shape follow web-surfaces, extended.
```ts
export type CanvasConnectError =
  | "not_a_url" | "not_ical" | "course_feed" | "not_canvas" | "private_address"
  | "feed_not_found" | "unreachable" | "timeout" | "too_large" | "forbidden"
  | "rate_limited" | "already_connected_elsewhere"
  | "not_user_authored" | "no_url_found" | "multiple_urls" | "internal";
export type ConnectResult =
  | { ok: true; host: string; itemCount: number; upcomingCount: number; summary: ConnectSummaryShape; text: string }
  | { ok: false; code: CanvasConnectError; text: string };
/** Normalize → test-fetch (before saving, so a bad URL never replaces a good one) → save encrypted → initial sync → summary. Per-user rate limit 10/h. */
export async function connectCanvas(input: { userId: string; rawUrl: string; schoolName?: string | null; via?: "web" | "chat"; now?: Date }): Promise<ConnectResult>;
/** Delete the integration row; soft-remove all canvas items (emits `removed` batch → V2-06 cancels nudges). */
export async function disconnectCanvas(userId: string): Promise<void>;
export type CanvasStatusView =
  | { connected: false }
  | { connected: true; host: string; urlHint: string; syncedAt: Date | null; nextSyncAt: Date | null;
      health: "ok" | "failing" | "revoked"; lastError: CanvasConnectError | null; upcomingCount: number };
export async function getCanvasStatus(userId: string, now?: Date): Promise<CanvasStatusView>;
/** Ask for an early sync (V2-07's Canvas due-change email hint, "refresh canvas"). Dedupe canvas_sync:<userId>. */
export async function requestCanvasSync(userId: string, reason: "email_hint" | "manual"): Promise<void>;
```

**`index.ts`:** re-exports `connectCanvas`, `disconnectCanvas`, `getCanvasStatus`, `requestCanvasSync`, `runCanvasSync`, and the types.

### 7.3 `src/server/timeline/`

**`types.ts`.**
```ts
import { z } from "zod";
export type TimelineSource = "canvas" | "gcal" | "gmail" | "syllabus" | "aria";
export type TimelineKind = "assignment" | "exam" | "event" | "class" | "block";
export type TimelineStatus = "upcoming" | "done" | "dismissed";
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/** Writer input. Optional fields default as noted (V2-07/V2-08 `TimelineUpsert` is this type). */
export interface TimelineItemInput {
  externalId: string; kind: TimelineKind; title: string; course?: string | null;
  startsAt?: Date | null; endsAt?: Date | null; dueAt?: Date | null;
  allDay?: boolean;              // default false
  url?: string | null;
  timingKey?: string;            // default: ISO of (dueAt ?? startsAt); change ⇒ due_changed
  matchKey?: string | null;      // default null
  raw?: { [k: string]: JsonValue } | null;
}
export type TimelineUpsert = TimelineItemInput & { source?: TimelineSource };   // V2-08 passes source per item

export interface TimelineItem {
  id: string; userId: string; source: TimelineSource; externalId: string; kind: TimelineKind;
  title: string; course: string | null; startsAt: Date | null; endsAt: Date | null; dueAt: Date | null;
  allDay: boolean; url: string | null; timingKey: string | null; matchKey: string | null;
  status: TimelineStatus; anchorAt: Date | null; removedAt: Date | null; updatedAt: Date;
  raw: { [k: string]: JsonValue } | null;
}
export type Urgency = "overdue" | "now" | "today" | "soon" | "this_week" | "later" | "past";
/** Read view (V2-04 TimelineItemView ∪ web TimelineViewItem). Dates are Date; tools serialize. */
export interface TimelineItemView {
  id: string; ref: string;                 // "t_" + first 8 hex of id
  source: TimelineSource; kind: TimelineKind;
  title: string; course: string | null; courseKey: string | null;
  startsAt: Date | null; endsAt: Date | null; dueAt: Date | null;
  allDay: boolean; allDayDate: string | null;   // floating "YYYY-MM-DD" from timing_key / local date
  url: string | null; status: TimelineStatus;
  urgency: Urgency; urgencyScore: number; hoursUntil: number | null;
  label: string;                           // formatForChat(anchor, tz, now, {allDay})
  syllabus?: { weight_pct: number | null; topics: string[] };   // attached by collapseSyllabusDuplicates
}

/** Change batch — V2-06's contract, extended with optional V2-05 fields. */
export const TimelineChangeSchema = z.object({
  itemId: z.uuid(),
  kind: z.enum(["created", "due_changed", "status_changed", "removed"]),
  source: z.enum(["canvas", "gcal", "syllabus", "aria", "gmail"]),
  itemKind: z.enum(["assignment", "exam", "event", "class", "block"]),
  title: z.string().nullable(), course: z.string().nullable(),
  oldDueAt: z.iso.datetime().nullable(), newDueAt: z.iso.datetime().nullable(),   // anchor = due_at ?? starts_at
  status: z.enum(["upcoming", "done", "dismissed"]),
  allDay: z.boolean().optional(),
  // V2-05 extensions (optional for consumers)
  externalId: z.string().optional(),
  restored: z.boolean().optional(),
  rekeyed: z.boolean().optional(),
  deliveryHint: z.enum(["immediate", "briefing", "none"]).optional(),
});
export const TimelineChangeBatchSchema = z.object({ initial: z.boolean(), changes: z.array(TimelineChangeSchema).max(5000) });
export type TimelineChange = z.infer<typeof TimelineChangeSchema>;
export type TimelineChangeBatch = z.infer<typeof TimelineChangeBatchSchema>;
export type Delivery = "immediate" | "briefing" | "none";

export interface SnapshotScope { externalIdPrefix?: string; windowStart?: Date; windowEnd?: Date }
export interface ApplyResult { created: number; updated: number; dueChanged: number; removed: number; restored: number; rekeyed: number; unchanged: number; removalsDeferred: number; batch: TimelineChangeBatch }
export interface DayLoad { date: string; count: number; examCount: number; level: "light" | "busy" | "heavy" }
```

**`diff.ts`.** Pure. Salvaged from V1 `compute_diff` and extended.
```ts
export interface PlannedChange { externalId: string; kind: TimelineChange["kind"]; itemKind: TimelineKind; title: string; course: string | null; oldAnchor: Date | null; newAnchor: Date | null; status: TimelineStatus; allDay: boolean; restored?: boolean; rekeyed?: boolean; existingId?: string }
export interface SnapshotDiff {
  upserts: TimelineItemInput[]; rekeys: { id: string; newExternalId: string }[]; removeIds: string[];
  planned: PlannedChange[]; stats: Omit<ApplyResult, "batch">; removalsDeferred: boolean;
}
/** UID match → 1:1 match_key rekey → created/due_changed/silent-update/restored/removed with window + guard. */
export function diffSnapshot(i: { current: TimelineItem[]; fresh: TimelineItemInput[]; now: Date; scope: SnapshotScope; removalGuard: { enabled: boolean; deferredLastTime: boolean }; capSaturatedKinds?: TimelineKind[] }): SnapshotDiff;
/** Incremental (no window removals): explicit upserts and removals only. */
export function diffIncremental(i: { current: TimelineItem[]; upserts: TimelineItemInput[]; removeExternalIds: string[]; now: Date }): SnapshotDiff;
```

**`policy.ts`.** Pure.
```ts
/** §8.3 table. V2-06 makes the final call; this is the hint. */
export function classifyDelivery(c: { source: TimelineSource; itemKind: TimelineKind; kind: TimelineChange["kind"]; oldDueAt: Date | null; newDueAt: Date | null; status: TimelineStatus; initial: boolean }, now: Date): Delivery;
/** Build the batch from planned changes + RPC id map (+ hints). */
export function buildBatch(planned: PlannedChange[], idByExternalId: Map<string, string>, source: TimelineSource, initial: boolean, now: Date): TimelineChangeBatch;
```

**`urgency.ts`.** Pure. Ports the V1 thresholds.
```ts
/** overdue (<now, ≤7d ago, assignment/exam) | now (≤3h) | today (same local date or ≤24h) | soon (≤72h) | this_week (≤7d) | later | past (events). */
export function computeUrgency(item: Pick<TimelineItem, "kind" | "anchorAt" | "status">, now: Date, tz: string): Urgency;
/** Monotone score for sorting/briefing (V2-06): higher = more urgent; exams ×1.5; done/dismissed = 0. */
export function urgencyScore(item: Pick<TimelineItem, "kind" | "anchorAt" | "status">, now: Date): number;
/** Per local day: upcoming assignment+exam count; light ≤1, busy 2–3, heavy ≥4 (V1 briefing.compute_load_score). */
export function dayLoads(items: TimelineItem[], tz: string, from: string, days: number): DayLoad[];
/** 7-day level: light ≤3, busy 4–6, heavy ≥7 (V1 mobile useCards.ts:121-133). */
export function weekLoadLevel(items: TimelineItem[], now: Date): "light" | "busy" | "heavy";
```

**`view.ts`.** Pure.
```ts
export function toView(item: TimelineItem, now: Date, tz: string): TimelineItemView;
export function rankSearch(items: TimelineItem[], query: string, now: Date): TimelineItem[];
/** "[t_a1b2c3d4] Thu Oct 15, 11:59pm · CPSC 323 · Pset 4 · assignment · soon" per line, inside wrapUntrusted({source, body}). Uses formatForTool. */
export function renderTimelineForModel(views: TimelineItemView[], opts?: { max?: number; emptyText?: string }): string;
export type AgendaRange = "today" | "tomorrow" | "next_48h" | "this_week" | "next_week" | "next_7_days" | "next_14_days";
/** Local-date range → [from, to) instants in tz (tz.ts). */
export function resolveRange(range: AgendaRange | { from: string; to: string }, now: Date, tz: string): { from: Date; to: Date };
```

**`store.ts`.** DB.
```ts
export async function loadSourceItems(userId: string, source: TimelineSource, opts?: { externalIdPrefix?: string; includeRemoved?: boolean }): Promise<TimelineItem[]>;
export async function loadByExternalIds(userId: string, source: TimelineSource, ids: string[]): Promise<TimelineItem[]>;
export async function queryRange(userId: string, from: Date, to: Date, o: { kinds?: TimelineKind[]; sources?: TimelineSource[]; statuses?: TimelineStatus[]; limit?: number }): Promise<TimelineItem[]>;
export async function queryOverdue(userId: string, since: Date, before: Date): Promise<TimelineItem[]>;
/** rpc('timeline_apply') → Map<externalId, id>. */
export async function applyDiffRpc(userId: string, source: TimelineSource, d: SnapshotDiff): Promise<Map<string, string>>;
export async function updateStatus(userId: string, itemId: string, status: TimelineStatus): Promise<{ before: TimelineItem; after: TimelineItem } | null>;
export async function findByRefPrefix(userId: string, hex8: string): Promise<{ id: string }[]>;
export async function getUserTimezone(userId: string): Promise<string>;
```

**`hooks.ts`.**
```ts
export type TimelineChangeSubscriber = (userId: string, batch: TimelineChangeBatch, now: Date) => Promise<void>;
/** Synchronous subscribers for status changes (V2-06 registers handleTimelineChanges here: one line). */
export const TIMELINE_STATUS_SUBSCRIBERS: readonly TimelineChangeSubscriber[];
/** Run subscribers; log errors (no bodies), never throw. */
export async function notifyStatusSubscribers(userId: string, batch: TimelineChangeBatch, now: Date): Promise<void>;
```

**`index.ts`.** The public API (§8.1).

### 7.4 Jobs and agent tools

- `src/server/jobs/kinds/canvas-sync.ts`: `export const canvasSyncPayload` (§9.1); `export const canvasSync: JobHandler`. One line in `kinds/index.ts`.
- `src/server/agent/tools/connect-canvas.ts` and `canvas-status.ts`: `export default defineTool(...)` (§9.2). Two lines in V2-04's "agenda (V2-05)" slot block of `tools/index.ts`.

---

## 8. Interfaces provided and consumed

### 8.1 Timeline API (provided by `src/server/timeline/index.ts`)

```ts
// ── Writes ──────────────────────────────────────────────────────────────
/** Full snapshot (Canvas). Diff vs stored rows of (user, source[, prefix]); atomic RPC; window-scoped
 *  removals + mass-removal guard; enqueues {kind:"timeline_changes"} when the batch is non-empty. */
export async function applySnapshot(p: {
  userId: string; source: TimelineSource; items: TimelineItemInput[]; now?: Date; initial?: boolean;
  scope?: SnapshotScope; removalGuard?: { enabled: boolean; deferredLastTime: boolean }; capSaturatedKinds?: TimelineKind[];
}): Promise<ApplyResult>;

/** V2-07: upsert all; soft-remove rows of `source` whose anchor ∈ [from,to) and external_id ∉ items. Guard off. */
export async function replaceSourceWindow(p: { userId: string; source: "gcal" | "aria"; from: Date; to: Date; items: TimelineItemInput[]; now?: Date }): Promise<{ upserted: number; deleted: number }>;
/** V2-07: single upsert (push notification path). */
export async function upsertTimelineItem(userId: string, source: TimelineSource, item: TimelineItemInput): Promise<{ id: string }>;
/** V2-07/V2-05: soft-remove every row of a source (disconnect); emits `removed` changes. */
export async function deleteTimelineItems(userId: string, source: TimelineSource): Promise<{ deleted: number }>;
/** V2-08: batch upsert; items carry `source` (default "syllabus"). Incremental classification; no window removals. */
export async function upsertTimelineItems(userId: string, items: TimelineUpsert[]): Promise<ApplyResult>;
/** V2-08: soft-remove rows of `source` with external_id prefix and not in `keep`. */
export async function pruneTimelineItems(p: { userId: string; source: TimelineSource; externalIdPrefix: string; keep: string[] }): Promise<{ removed: number }>;

/** Mark done / dismiss / undo; owner-scoped; idempotent; runs status subscribers (V2-06 cancels nudges). */
export async function setTimelineItemStatus(userId: string, itemId: string, status: TimelineStatus): Promise<{ ok: true; item: TimelineItemView } | { ok: false; code: "not_found" }>;
/** V2-04 alias: setTimelineItemStatus(..., "done") → view or null. */
export async function markItemDone(userId: string, itemId: string): Promise<TimelineItemView | null>;
/** Recompute date-only/floating instants after a timezone change (no change entries). */
export async function rebaseTimeline(userId: string, newTimezone: string): Promise<{ updated: number }>;

// ── Reads (exclude removed; urgency computed now; tz read from users when omitted) ───
export interface ListTimelineOpts {
  includeDone?: boolean;            // web: true → statuses upcoming+done (+dismissed? no)
  statuses?: TimelineStatus[];      // V2-04/V2-06 form; overrides includeDone
  overdueSince?: Date;              // web: also upcoming items anchored in [overdueSince, from)
  includeOverdue?: boolean;         // V2-04 form: overdueSince = from − 7d
  kinds?: TimelineKind[]; sources?: TimelineSource[]; limit?: number; timezone?: string; now?: Date;
}
/** Both call styles work: listTimeline(u, {from,to}, opts) and listTimeline(u, {from,to,...opts}). Sorted by anchor; collapseSyllabusDuplicates applied. */
export async function listTimeline(userId: string, range: { from: Date; to: Date } & ListTimelineOpts, opts?: ListTimelineOpts): Promise<TimelineItemView[]>;
/** V2-06 alias. */
export const listItems: typeof listTimeline;
/** Convenience for tools: named local range. */
export async function listTimelineForRange(userId: string, range: AgendaRange | { from: string; to: string }, opts?: ListTimelineOpts): Promise<TimelineItemView[]>;
export async function searchTimeline(userId: string, query: string, opts?: { includeDone?: boolean; includePast?: boolean; limit?: number; timezone?: string; now?: Date }): Promise<TimelineItemView[]>;
export async function getTimelineItem(userId: string, itemId: string, opts?: { timezone?: string; now?: Date }): Promise<TimelineItemView | null>;
export async function resolveItemRef(userId: string, ref: string): Promise<{ ok: true; itemId: string } | { ok: false; error: "not_found" | "ambiguous" }>;
export async function getDayLoads(userId: string, from: string, days: number, opts?: { timezone?: string; now?: Date }): Promise<DayLoad[]>;
export async function getWeekLoad(userId: string, opts?: { now?: Date }): Promise<"light" | "busy" | "heavy">;
export async function summarizeUpcoming(userId: string, source: TimelineSource, opts?: { timezone?: string; now?: Date }): Promise<ConnectSummaryShape>;
/** Distinct course codes with upcoming items (profile rendering). */
export async function listCourses(userId: string, now?: Date): Promise<string[]>;
/** V2-08: min/max Canvas anchor for a courseKey (term hint), or null. */
export async function termHintForCourse(userId: string, courseKey: string): Promise<{ start: Date; end: Date } | null>;

// ── Pure helpers re-exported ─────────────────────────────────────────────
export { urgencyScore, computeUrgency, dayLoads, weekLoadLevel } from "./urgency";
export { renderTimelineForModel, resolveRange, toView } from "./view";
export { classifyDelivery } from "./policy";
export { TimelineChangeSchema, TimelineChangeBatchSchema } from "./types";
export type * from "./types";
```

**Writer obligations:**

| Writer | `externalId` | `timingKey` | `matchKey` | Other |
|---|---|---|---|---|
| V2-07 (gcal) | Google event id, prefixed with the calendar id if ids can collide across calendars | the `start.dateTime ?? start.date` literal | `null` | All-day: `allDay: true`, `startsAt` = local midnight |
| V2-08 (syllabus) | `syl:<courseKey>:<hash16>` (their scheme) | `D:YYYYMMDD` for date-only, else ISO | — | Date-only: `allDay: true`. Use the `all_day` **column** (the `allDay` field), not `raw.all_day`. Prune with `externalIdPrefix: 'syl:<courseKey>:'`. |

### 8.2 Hooks (provided)

`TIMELINE_STATUS_SUBSCRIBERS` (`src/server/timeline/hooks.ts`). V2-06 adds one line, `handleTimelineChanges`. It's invoked synchronously by `setTimelineItemStatus` with `{ initial: false, changes: [{ kind: "status_changed", … }] }`.

### 8.3 Change-batch contract (V2-05 → V2-06)

- **Transport:**
  - After each committed write with ≥1 change: `enqueueJob({ kind: "timeline_changes", userId, payload: TimelineChangeBatch, dedupeKey: "tlc:" + userId + ":" + syncRunId, runAt: now })`
  - Status changes: synchronous subscriber call
  - Disconnect: one batch of `removed` changes
- **Schema:** `TimelineChangeBatchSchema` (§7.3). It's exactly V2-06's §8 shape plus the optional `externalId`, `restored`, `rekeyed`, and `deliveryHint`. ISO strings; `oldDueAt`/`newDueAt` are the anchor (`due_at ?? starts_at`). `created` → `oldDueAt: null`; `removed` → `newDueAt: null`. The `restored` flag rides on `created`.
- **`initial: true`:** first Canvas sync after a connect or URL change. Every change is `created`, and `deliveryHint: "none"`.
- **Guarantees:** at-least-once; the batch is enqueued only after the RPC commits; order inside a batch is by anchor; no ordering across batches. Titles and courses are **untrusted**, so V2-06 wraps them (`wrapUntrusted`) before any LLM prompt and never treats them as instructions.

**`deliveryHint` (`classifyDelivery`, pure; anchor = `due_at ?? starts_at`, now = sync time):**

| kind | source | condition | hint |
|---|---|---|---|
| any | any | `initial` | `none` |
| any | `gcal`, `aria`, `gmail`, `syllabus` | — | `none` (user's own calendar; V2-08: syllabus never alerts) |
| any | canvas | item `done` or `dismissed` | `none` |
| `status_changed` | any | — | `none` (V2-06 cancels or re-arms nudges) |
| `due_changed` | canvas | `|new − old| < 60s` | `none` |
| `due_changed` | canvas | `old ∈ [now, now+7d]` **or** `new ∈ [now, now+7d]` | `immediate` |
| `due_changed` | canvas | otherwise, `new > now` | `briefing` |
| `due_changed` | canvas | both in the past | `none` |
| `created` | canvas | assignment or exam, `new ∈ [now, now+24h]` | `immediate` |
| `created` | canvas | assignment or exam, `new ∈ (now+24h, now+14d]` | `briefing` |
| `created` | canvas | otherwise | `none` |
| `removed` | canvas | assignment or exam, `old ∈ [now, now+7d]` | `briefing` |
| `removed` | canvas | otherwise | `none` |

V2-06 always processes every change for nudge bookkeeping (create, move, cancel anchored reminders) regardless of the hint. The hint only governs user-facing alert timing, and V2-06 may override it.

### 8.4 Consumed from other branches

| From | What | If not shipped yet |
|---|---|---|
| V2-02 (exists) | `db`, `Tables`, `requireEnv`, `optionalEnv`, `appBaseUrl`, `encryptSecret` / `decryptSecret` / `parseKey`, `rateLimit`, `mintMagicLink`, `maskHandle` | — |
| V2-03 | `enqueueJob({kind,userId,runAt,payload,dedupeKey})`; `JobHandler` (V2-06 states `(job, ctx:{now}) => Promise<void>`; V2-04 states `(job: Tables<"jobs">) => …`). V2-05 adapts to whatever V2-03 publishes. `canvas_sync` never throws on expected failures. | — |
| V2-03 | `deliver(userId, plan, { proactive, reason, idempotencyKey })` for the connect confirmation and revoke/error notices. Keys: `canvas_connected:<userId>:<fp8>`, `canvas_revoked:<userId>:<fp8>`, `canvas_error:<userId>:<firstFailureAt>`. | — |
| V2-03 | Permission for one scoped UPDATE redacting the feed URL in this user's inbound `messages.body` after a chat connect. | Alternatively V2-03 exposes `redactInboundBodies(userId, messageIds, fn)`. |
| V2-04 | `defineTool`, `ctx = {userId, runId, now, timezone, channel}`; `wrapUntrusted({source, id?, body})` from `@/server/agent/untrusted`; `refreshProfileBlock(userId)` | Fallback wrapper `<untrusted source="canvas">…</untrusted>` with tag neutralization, removed once V2-04 lands. |
| V2-06 | `src/shared/time/tz.ts` (`zonedToUtc`, `localDateOf`, `addLocalDays`, `isValidTimeZone`, `safeTimeZone`, `formatForChat`, `formatForTool`); the `timeline_changes` job kind and `handleTimelineChanges`; `onUserScheduleSettingsChanged` → calls `rebaseTimeline(userId, tz)` (**request to V2-06**: one line) | **T0 (§11)** creates `tz.ts` verbatim from V2-06's signatures if V2-05 starts first; V2-06 adopts it. Until the `timeline_changes` handler exists, the orchestrator registers a no-op stub so batches don't dead-letter (§13 Q16). |
| V2-07 | Enqueues `canvas_sync` (dedupe `canvas_sync:<userId>`) on Canvas due-change emails; or calls `requestCanvasSync`. | — |
| V2-08 | `courseKey` / `sameCourse` (`src/shared/course-key.ts`); `collapseSyllabusDuplicates(items, tz)` | If unshipped: identity collapse and a local `courseKey` stub (`/^([A-Z&]{2,5})\s*(\d{2,4}[A-Z]?)/`) replaced on merge. |

### 8.5 Cross-plan reconciliation (names adopted)

| Concern | Sibling expectation | This plan |
|---|---|---|
| Change transport | V2-06: job `timeline_changes`, payload `TimelineChangeBatch`, key `tlc:{userId}:{syncRunId}`; status changes via direct `handleTimelineChanges` | Adopted. My earlier `timeline_changes` table and `deadline_alert` kind were **dropped**. |
| Change fields | V2-06: `kind`, `itemKind`, ISO `oldDueAt`/`newDueAt`, `status`, `allDay?` | Adopted, plus optional `externalId`, `restored`, `rekeyed`, `deliveryHint` |
| Read API | V2-04 `listTimeline(userId, {from,to,includeOverdue,statuses,limit})`; web `listTimeline(userId,{from,to},{includeDone,overdueSince})`; V2-06 `listItems` | One `listTimeline` accepting both styles, plus a `listItems` alias |
| Search / done | V2-04 `searchTimeline`, `markItemDone`; web `setTimelineItemStatus` | All provided (`markItemDone` wraps `setTimelineItemStatus`) |
| View type | V2-04 `TimelineItemView` (ISO strings, 4 urgency values); web `TimelineViewItem` (Date, `allDay`, `allDayDate`) | One `TimelineItemView` with Dates and a 7-value urgency (superset). V2-04's tool serializes and maps `now`→`today`, `this_week`→`soon`, `past`→`later`. |
| Urgency number | V2-06 `urgencyScore(item, now)` | Provided |
| Refs | V2-04 `[t_…]` | `ref = "t_" + 8 hex` |
| Writes | V2-07 `replaceSourceWindow`, `upsertTimelineItem`, `deleteTimelineItems`; V2-08 `upsertTimelineItems`, `pruneTimelineItems`, `termHintForCourse` | All provided |
| Syllabus dedupe and course keys | V2-08 owns `collapseSyllabusDuplicates`, `courseKey` | Consumed; my `dedupeViews` was dropped |
| Time helpers | V2-06 owns `src/shared/time/tz.ts` | Consumed; my `src/shared/localtime.ts` was dropped |
| `/setup`, `/week` UI | web-surfaces W5, W7 | Not built here; my `/api/canvas/connect`, `CanvasCard`, `/week`, and status route were dropped |
| Canvas API for web | `connectCanvas({userId,rawUrl,schoolName})` → `{ok,host,itemCount,upcomingCount}`/`{ok:false,code}`; `getCanvasStatus` → `CanvasStatusView`; `disconnectCanvas` deletes row + items | Adopted, with extra fields and codes |
| School list | web: `canvasHostForSchool`, `normalizeCanvasHost`; unlisted hosts must be accepted | Adopted (unlisted accepted with the Canvas-proof check) |
| `integrations.status` check | V2-07 has the same 4 values | Identical; keep one copy |
| Untrusted wrapper | V2-04 `wrapUntrusted({source, id?, body})` | Adopted |

---

## 9. Job kinds and agent tools

### 9.1 `canvas_sync` (V2-05)

```ts
export const canvasSyncPayload = z.object({
  reason: z.enum(["scheduled", "manual", "email_hint"]).default("scheduled"),
}).strict();   // `{}` (cron/V2-07 inserts) parses as scheduled
```
- **Enqueued by:** pg_cron `canvas-sync-enqueue` (§4), V2-07 (email hint), and `requestCanvasSync`. Always `dedupeKey: "canvas_sync:<userId>"`. Connect calls `runCanvasSync` directly.
- **Handler:** `runCanvasSync(job.userId, { reason })`. Expected failures are recorded and rescheduled, and the handler returns normally; only invariant violations throw.
- **Idempotent:** via the lease, the feed-hash skip, and the diff against stored state.

### 9.2 Agent tools owned by V2-05

```ts
// src/server/agent/tools/connect-canvas.ts
export default defineTool({
  name: "connect_canvas",
  description:
    "Connect the student's Canvas calendar feed. Use ONLY when the student themselves pasted a Canvas " +
    "calendar feed link (…/feeds/calendars/user_….ics). You don't need to repeat the link; the tool finds " +
    "it in their message. Returns a short summary to tell them.",
  input: z.object({
    url: z.string().trim().max(2048).optional()
      .describe("Optional. Must be exactly a link the student sent; omit to auto-detect."),
  }).strict(),
  run: async (ctx, input) => { /* §2.9: user-authored URL → connectCanvas({via:"chat"}) → redact → {ok, text, summary} */ },
});

// src/server/agent/tools/canvas-status.ts
export default defineTool({
  name: "canvas_status",
  description: "Check whether Canvas is connected, when it last synced, and whether the feed has a problem. Can also trigger a refresh.",
  input: z.object({ refresh: z.boolean().default(false) }).strict(),
  run: async (ctx, input) => { /* getCanvasStatus; if refresh → requestCanvasSync(ctx.userId, "manual") */ },
});
```

**Notes:**
- `connect_canvas` errors: `no_url_found`, `multiple_urls` (the model asks which), `not_user_authored`. It shares the 10/hour rate limit with the web path.
- Course and title strings in tool output are wrapped with `wrapUntrusted`. Both tools set `untrustedOutput: true` (V2-04's flag).

### 9.3 Recommended inputs for V2-04's timeline tools

V2-04 owns these files. Their plan already lists `get_agenda {range}`; these are compatible extensions.

```ts
// get_agenda
z.object({
  range: z.enum(["today","tomorrow","next_48h","this_week","next_7_days","next_14_days"]).default("next_7_days"),
  kinds: z.array(z.enum(["assignment","exam","event","class","block"])).max(5).optional(),
  include_done: z.boolean().default(false),
}).strict()
// → listTimelineForRange + renderTimelineForModel (+ getDayLoads line)

// search_deadlines
z.object({ query: z.string().trim().min(1).max(100), include_past: z.boolean().default(false), limit: z.number().int().min(1).max(20).default(8) }).strict()

// mark_done
z.object({ item_ref: z.string().trim().regex(/^(t_[0-9a-f]{8}|[0-9a-f-]{36})$/), status: z.enum(["done","dismissed","upcoming"]).default("done") }).strict()
// → resolveItemRef → setTimelineItemStatus; "ambiguous" → ask
```

---

## 10. Test plan

**Runner:** Jest (foundation agent) on `tests/unit/**`. Smoke tests under `tests/smoke/**` run only with `SMOKE=1`.

**Fixtures:** real-shaped per §2.1. CRLF, 75-octet folding, header `PRODID:icalendar-ruby` / `METHOD:PUBLISH` / `X-WR-CALNAME:Test Student Calendar (Canvas)`, with `URL:` and `URL;VALUE=URI:` both present.

### 10.1 Fixtures (`tests/fixtures/canvas/`)

| File | Contents |
|---|---|
| `basic.ics` | <br>• timed assignment `DTSTART:20261016T210000Z` `SUMMARY:Problem Set 4 [CPSC 323 01 (FA26)]` `UID:event-assignment-412345`, URL `…include_contexts=course_98765…#assignment_412345` <br>• **date-only** assignment `DTSTART;VALUE=DATE:20261015` (no DTEND) `[ENGL 120]` <br>• calendar event with DTSTART/DTEND <br>• all-day account event "Fall Recess" (no course) <br>• `Midterm Exam [MATH 225]` <br>• `Midterm Review Session [MATH 225]` (stays `event`) |
| `override-before.ics` / `override-after.ics` | `event-assignment-500` due `20261015` → `event-assignment-override-77` `SUMMARY:Pset 5 (Extension) [CPSC 323]`, URL `#assignment_500`, due `20261018` |
| `subassignments.ics` | two `event-sub-assignment-*` UIDs sharing `#assignment_900` |
| `dst-ny.ics` | date-only assignments on 2026-03-08 and 2026-11-01; timed `20261101T055900Z` and `20261101T063000Z`; all-day event on 2026-03-08 |
| `tz-variants.ics` | `DTSTART;TZID=America/Chicago:20261015T170000`; floating; `TZID=Custom/Zone` with an embedded VTIMEZONE |
| `escapes-folding.ics` | `SUMMARY:Café\, crème \; notes\nline [FREN 110]` folded mid-`é`; `Lab [Part 2] [CHEM 134L]` |
| `duplicates.ics` | same UID twice (last wins) |
| `empty.ics` | header only |
| `unauthorized-feed.html` | Canvas `unauthorized_feed` HTML |
| generated in-test | 2,000 events (performance, cap saturation) |

### 10.2 Unit tests

**`tests/unit/shared/canvas-url.test.ts`:**
- **accepts:**
  - `webcal://yale.instructure.com/feeds/calendars/user_<40>.ics` → https
  - uppercase host
  - trailing dot
  - `<…>` and quotes
  - listed vanity host
  - unlisted → `hostClass: "unlisted"`
- **rejects:**
  - `http://u:p@…`
  - `:8443`
  - `https://127.0.0.1/feeds/…`, `https://2130706433/…`, `https://0x7f.1/…`, `https://[::1]/…`
  - `https://yale.instructure.com.evil.com/…` (unlisted; must later fail Canvas proof)
  - `https://evil.com/yale.instructure.com/feeds/…`
  - `https://yale.instructure.com@evil.com/…`
  - `https://evil.com\@yale.instructure.com/…`
  - `/feeds/calendars/../../api/v1`, `%2e%2e`
  - query string
  - `course_<uuid>.ics` → `course_feed`
  - IDN homoglyph → punycode → unlisted
- `precheckIcalUrl` mapping; `findCanvasFeedUrls` (punctuation, two URLs, none); `redactCanvasFeedUrls`; `feedUrlHint`

**`tests/unit/shared/universities.test.ts`:**
- sorted; no duplicate names or domains
- corrected entries present (`courseworks2.columbia.edu`, `psu.instructure.com`, `princeton.instructure.com`, `canvas.its.virginia.edu`); Vanderbilt absent
- `canvasHostForSchool("yale university ")` → `yale.instructure.com`
- `normalizeCanvasHost` cases

**`tests/unit/canvas/ics.test.ts`:** byte-level unfold keeps `é`; escapes decoded; `VALUE=DATE` / `Z` / TZID / floating mapped; `IcsParseError` on HTML; `timingKeyOf`.

**`tests/unit/canvas/parse.test.ts`:**
- `splitSummary` table
- `uidKind` and `inferKind` table ("Final Project" → assignment; "Final Exam" → exam; "Exam Review" → event; "Prelim 1" → exam)
- **date-only assignment → `2026-10-16T03:59:00Z` for America/New_York**, not 19:59 local
- the same date in America/Los_Angeles → `06:59Z`
- all-day event spans the local day; DST fixtures (spring 23h, fall 25h)
- `allDayDate` comes from `timing_key`
- `matchKeyOf` null for sub-assignments; `deriveItemUrl` (direct link; cross-host → null)
- caps; duplicate-UID last-wins; cap-saturation flags
- 2,000 events in under 500 ms

**`tests/unit/canvas/ssrf.test.ts`:**
- **false:** `10.1.2.3`, `172.16.0.1`, `192.168.1.1`, `127.0.0.1`, `0.0.0.0`, `169.254.169.254`, `100.64.0.1`, `198.18.0.1`, `224.0.0.1`, `255.255.255.255`, `::1`, `::`, `::ffff:127.0.0.1`, `::ffff:7f00:1`, `64:ff9b::a9fe:a9fe`, `fd00::1`, `fe80::1`, `ff02::1`, `2002:7f00:1::`, `2001:db8::1`
- **true:** `13.32.241.71`, `8.8.8.8`, `2600:9000:2000::1`
- `resolvePublicHost`: mixed public/private → `non_public_address`; pins v4

**`tests/unit/canvas/fetch-feed.test.ts`** (fake resolver and transport):
- 200 ok
- 302 → host resolving to `169.254.169.254` → `redirect_rejected`
- 302 → `http://` → rejected
- 302 → `/login` → `feed_not_found`
- 4 hops → `too_many_redirects`
- resolver called once per hop
- cap → `too_large` + `abort()`
- gzip bomb → `too_large`
- 400 + `n=public_feed` → `feed_not_found` / `definitive`
- 404 → definitive; 403 → slow-transient; 503 / 429 / timeout → transient
- 200 `text/html` → `not_calendar`
- transport receives the pinned address and `servername` = hostname

**`tests/unit/canvas/pinned-lookup.test.ts`:** `httpsTransport`'s `lookup` returns the pinned address for any name, and `dns.lookup` is never called (spy).

**`tests/unit/canvas/schedule.test.ts`:**
- slot stable and roughly uniform over 10k uuids
- `nextHourlySync` ∈ (now+30m, now+90m] at the slot minute
- backoff table
- `decideAfterFailure`: 3 definitive failures within <2h → retry; ≥2h → revoke; transient 48h → `error_notify` once

**`tests/unit/timeline/diff.test.ts`:**
- created / silent update / unchanged
- `due_changed` via `timing_key`
- **timezone change → upsert, no change**
- **override rekey → one rekey + `due_changed`, same row id**
- sub-assignment non-1:1 → remove + create
- rekey blocked when the new UID exists as a removed row
- restored → `created` + `restored`
- 40-day-old missing item not removed
- mass-removal guard deferred, then applied
- cap-saturated → no removals
- `initial` → all `created`
- `diffIncremental`

**`tests/unit/timeline/policy.test.ts`:**
- the full §8.3 truth table with boundaries (exactly 7d, exactly 24h, <60s, done, syllabus or gcal source, initial)
- `buildBatch` output parses with `TimelineChangeBatchSchema` and ISO strings

**`tests/unit/timeline/urgency-view.test.ts`:**
- urgency buckets at boundaries
- `urgencyScore` monotone in time; done = 0
- `dayLoads` (0/1 light, 2–3 busy, 4+ heavy); `weekLoadLevel` (3 / 4–6 / 7)
- `rankSearch` (`"323"` → CPSC 323; `"pset 4"`; past excluded)
- `renderTimelineForModel` wraps untrusted and neutralizes tags
- `resolveRange` (`this_week` on a Sunday; across DST)
- `toView.ref` matches `^t_[0-9a-f]{8}$`

### 10.3 DB smoke (`tests/smoke/timeline.smoke.test.ts`, `SMOKE=1`, real project)

1. Throwaway `users` row (`name: 'smoke-v205-<rand>'`, `America/New_York`).
2. `applySnapshot(basic, initial: true)` → counts; an enqueued `timeline_changes` job with `initial: true` (or a captured stub if V2-03 isn't merged).
3. Override after (dates relative to now) → 1 rekey; `due_changed` with `deliveryHint: "immediate"`; same item id.
4. `setTimelineItemStatus(done)` → the subscriber received `status_changed`; a later due change hints `none`.
5. `resolveItemRef("t_" + hex8)`; `listTimeline` both call styles; `overdueSince`.
6. `replaceSourceWindow` (gcal) deletes only in-window stale rows; `pruneTimelineItems` by prefix.
7. `saveCanvasIntegration` → `enc_ical_url` starts with `v1:`; `readFeedUrl` round-trips; a second user with the same fp → `already_connected_elsewhere`.
8. `claimSyncLease` twice → second `false`.
9. `timeline_apply` via the anon key → permission denied.
10. Run the cron SQL body twice → exactly one pending `canvas_sync`.
11. `finally`: delete the users (cascade) and the test `jobs` rows by `dedupe_key` / `user_id`.

### 10.4 Opt-in live test

`tests/smoke/canvas-live.smoke.test.ts` runs with `CANVAS_LIVE_TEST_URL` set. It does a real `httpsTransport` fetch → lex → parse and asserts:
- `canvasMeta === true`
- at least one item
- every assignment-UID item has a non-null course
- no date-only assignment lands at anything other than 23:59 local

---

## 11. Ordered implementation tasks

Each task is sized for one sub-agent. No sub-agent installs dependencies, writes migrations, commits, or runs `next build`. Each uses `npx tsc --noEmit`, `npx eslint <files>`, and `npm test`.

**T0 — (only if V2-06's T-task hasn't created it yet) `src/shared/time/tz.ts`.**
- Create it exactly per V2-06 §7 signatures, with V2-06's tests. V2-06 then owns it.
- Acceptance: the DST tests listed in V2-06's plan pass.

**T1 — Shared Canvas pure modules.** No deps; can start now.
- Owns: `src/shared/{universities,canvas-url,canvas-guide}.ts`, `tests/unit/shared/{universities,canvas-url}.test.ts`
- Acceptance:
  - tests pass
  - list corrections applied, and every listed domain re-probed with a throwaway script (not committed): `GET /feeds/calendars/user_x.ics` → 400 + `n=public_feed`; mismatches reported
  - no Node-only imports (W5's client imports these)
  - if web W5 already created `universities.ts`, extend it in place

**T2 — ICS lexer and Canvas parser.** Needs `ical.js@2.2.1` installed and `tz.ts`.
- Owns: `src/server/integrations/canvas/{ics,parse}.ts`, `tests/fixtures/canvas/*`, `tests/unit/canvas/{ics,parse}.test.ts`
- Acceptance: fixtures real-shaped (CRLF, folded); all parse tests pass, including date-only → 23:59 local; Jest resolves ical.js; 2,000 events in under 500 ms.

**T3 — SSRF and fetch.** Needs T1.
- Owns: `src/server/integrations/canvas/{ssrf,fetch-feed}.ts`, `tests/unit/canvas/{ssrf,fetch-feed,pinned-lookup}.test.ts`
- Acceptance: tests pass; `node:https` with a pinned `lookup` and `servername`, no global `fetch`; gzip cap on decompressed bytes; logs carry only host + fp8.

**T4 — Timeline pure core.** Needs `tz.ts`.
- Owns: `src/server/timeline/{types,diff,policy,urgency,view}.ts`, `tests/unit/timeline/*.test.ts`
- Acceptance: tests pass; the §8.3 table is table-driven; `TimelineChangeBatchSchema` matches V2-06's documented shape; no DB imports.

**T5 — Timeline store, public API, and hooks.** Needs T4, **003 applied**, and regenerated `db/types.ts`.
- Owns: `src/server/timeline/{store,hooks,index}.ts`, `tests/smoke/timeline.smoke.test.ts` (steps 1–6, 9)
- Acceptance: §8.1 is implemented, including every alias; the batch is enqueued only after RPC success; status subscribers run synchronously, and errors are swallowed and logged; smoke passes and cleans up; temporary stubs for V2-03/V2-04/V2-08 imports are isolated in one file `src/server/timeline/ports.ts` (marked `// PORT_STUB`).

**T6 — Canvas sync, connect, and job kind.** Needs T2, T3, T5.
- Owns: `src/server/integrations/canvas/{schedule,store,sync,connect,index}.ts`, `src/server/jobs/kinds/canvas-sync.ts` + one line in `kinds/index.ts`, `tests/unit/canvas/schedule.test.ts`, smoke steps 7, 8, 10
- Acceptance:
  - lease, hash skip, initial batch, guard state via `last_error`
  - backoff, revoke, and 48h error notices sent once each (idempotency keys)
  - URL never logged; kill-switch honored
  - test-fetch before save
  - `refreshProfileBlock` called on course-set change

**T7 — Agent tools.** Needs T6 and V2-04's registry.
- Owns: `src/server/agent/tools/{connect-canvas,canvas-status}.ts` + two lines in V2-04's V2-05 slot block
- Acceptance:
  - user-authored-only URL selection, unit-tested with a fake messages reader (URL in an email-derived context → `not_user_authored`)
  - redaction UPDATE scoped to the user's inbound rows
  - output wrapped untrusted
  - summary copy

**Order:** (T0 if needed) → T1 → (T2, T3, T4 in parallel) → T5 (after 003) → T6 → T7. Web W5 and W7 can start against T1 and `PORT_STUB`s as soon as T1 lands.

---

## 12. Verify when credentials arrive

With **Daniel's real Yale feed** (`yale.instructure.com`), via `CANVAS_LIVE_TEST_URL` locally, then on the deployed Vercel URL:

1. URL id shape: does it match `[A-Za-z0-9]{20,64}`? Is it 40 chars?
2. Response: `Content-Type` (expect `text/calendar`), `x-canvas-meta` on 200, gzip behavior, body size, latency. `ETag` / `If-None-Match` → 304? (decides Q17)
3. Yale `SUMMARY` course-code format, and that V2-08's `courseKey()` maps it (`CPSC 323 01 (FA26)` → `CPSC323`).
4. DTSTART mix (expect mostly `VALUE=DATE`). Three assignments spot-checked against the Canvas UI: the displayed due time must equal Canvas's.
5. URL fragment `#assignment_<id>`; the derived `/courses/<cid>/assignments/<id>` opens the assignment.
6. Overrides: if any course has section dates, confirm the `event-assignment-override-*` UID and the `(override title)` suffix.
7. Revocation signature: change one character of the id → 400 + `n=public_feed` → `feed_not_found`.
8. **From Vercel `iad1`:** fetch succeeds (no WAF 403); DNS returns only public addresses.
9. Chat connect via the Sendblue sandbox or the dev channel: summary reply; stored inbound body redacted.
10. `canvas-sync-enqueue` produces exactly one job per user per hour at the slot minute over 3 hours.
11. `timeline_changes` batches reach V2-06: an "initial" batch on connect, then a `due_changed` when an instructor moves a date (or simulate with a fixture-backed `urlOverride` in dev).
12. Re-probe the school list (T1 script) and decide on Arizona.
13. DST in practice: **2026-11-01** US fall-back. Check agenda and briefing labels that week.

---

## 13. Open questions (with recommended defaults)

| # | Question | Default |
|---|---|---|
| Q1 | Accept "Other" (unlisted) Canvas hosts? | **Yes**, after IP/DNS checks, and only if the response has `x-canvas-meta` and passes `looksLikeCanvasFeed`. Matches web-surfaces' request. |
| Q2 | Hint alerts for newly created assignments? | ≤24h → `immediate`; ≤14d → `briefing`; else `none`. V2-06 decides finally. |
| Q3 | Hint for removed assignments? | `briefing` if ≤7 days out and not done. |
| Q4 | Weight exams in the load score? | **No.** V1's unweighted counts; `examCount` exposed separately; `urgencyScore` weights exams 1.5× for sorting only. |
| Q5 | Build `/api/canvas/connect` (spec §4.12) even though W5 uses a server action? | **No.** One caller path; add the 30-line route only if a non-browser client needs it. |
| Q6 | Connect on paste without "want me to connect this?" | **Yes.** Pasting is explicit intent; reply with the summary plus "say 'disconnect canvas' to undo". |
| Q7 | Canvas links in outbound messages (spec §3.22 restricts links)? | Allow only links whose host **equals the user's verified feed host** (web-surfaces' `allowHosts`). |
| Q8 | Store DESCRIPTION text? | ≤1,000 chars plain text in `raw.description`; never in prompts by default; any future tool wraps it untrusted. |
| Q9 | Job materialization via pg_cron SQL vs a V2-03 periodic mechanism? | pg_cron SQL (§4) unless V2-03 ships an equivalent. `next_sync_at` stays the source of truth. |
| Q10 | `tz.ts` owner? | V2-06 (their §7). V2-05 creates it only via T0 if it starts first. |
| Q11 | Untrusted wrapper? | V2-04's `wrapUntrusted({source, id?, body})`. |
| Q12 | Block the same feed on two accounts? | **Yes** (unique `ical_url_fp`). |
| Q13 | Date-only due zone? | The user's `users.timezone`. Revisit if a tester's zone differs from their school's. |
| Q14 | School list fixes? | Apply the probed corrections; **remove Vanderbilt**; Arizona → `arizona.instructure.com` [verify]; "Other" catches misses. |
| Q15 | `integrations.status` values? | `active \| error \| revoked \| disconnected` (identical to V2-07; one constraint in 003). |
| Q16 | `timeline_changes` batches before V2-06's handler exists? | Orchestrator registers a no-op stub handler so jobs don't dead-letter. |
| Q17 | Conditional GET (ETag)? | Defer until §12.2 confirms; `feed_hash` already skips the work. |
| Q18 | Crash between RPC commit and batch enqueue loses one batch. | Accept for the free test (retry enqueue once, log). For production: an outbox column on `integrations` (`pending_batch jsonb`) written in the same RPC, then drained. |
| Q19 | `rebaseTimeline` trigger on timezone change? | V2-06's `onUserScheduleSettingsChanged` calls it (one line, **request to V2-06**). |
