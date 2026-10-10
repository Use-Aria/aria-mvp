# V2-06 — Reminders, Daily Briefing, Deadline Nudges & Alerts (plan)

> **Status:** Plan only. No code was changed. Author: planning agent, 2026-10-10.
> **Binding inputs:** `docs/plans/2026-10-10-v2-build-brief.md` (shared contracts), spec `docs/specs/2026-10-09-aria-v2-spec-and-architecture.md` §3.14, §3.15, §3.16, §3.22, §4.4, §5, `docs/plans/2026-10-09-aria-v2-free-testing-plan.md` (F3), `supabase/migrations/001_v2_baseline.sql`, `src/server/llm/index.ts`.
> **V1 reference ported:** `celery_worker/ai/briefing.py` (load score, exam touchpoints T-7/5/3/1/0; **fix** UTC display bug, **drop** 800-char cap), `celery_worker/sms/send.py` (midnight-spanning quiet-hours check: `t >= start OR t < end`).

---

## 1. Scope & spec refs

| In scope (V2-06 owns) | Spec |
|---|---|
| Agent tools `create_reminder`, `list_reminders`, `cancel_reminder`, plus `update_notification_settings` (briefing time / on-off, default deadline-nudge offsets) | §3.11 tool list, §3.16 |
| `reminders` lifecycle: absolute, relative ("in 20 min"), anchored (timeline item + offset, auto-recomputed when the due date moves), recurring (RRULE subset) | §3.16, §4.4 |
| Job kinds `reminder_fire`, `briefing_prepare`, `briefing_send`, `timeline_changes` (handler files + one registry line each) | §4.4 |
| Daily briefing: per-user `briefing_time`, DST-safe `next_briefing_at`, pre-generation 10–20 min early, delivery at the local time, idempotent on `(user_id, local_date)`, content assembly, Monday week view, `/week` magic link with aggregate count, empty-day and nothing-connected behavior | §3.14 |
| Deadline nudges: T-24h folded into the briefing, T-3h proactive nudge (user-tunable), suppressed when done | §3.15 |
| Due-date-change alerts from V2-05's change list: ≤7 days out → immediate alert, otherwise next briefing | §3.15 |
| Scheduling plumbing: (re)scheduling briefing jobs on signup / after each briefing / on timezone or briefing-time change; a daily reconcile sweep | §4.4 |
| Supabase Free keepalive (Vercel Hobby daily cron → route that writes through PostgREST) | free-testing plan "pauses after a week idle" |
| Shared pure time library `src/shared/time/*` (IANA/DST math with `Intl`, no deps) | brief "Timezones" convention |

**Not in scope (consumed from other branches):** the jobs table/dispatcher/pg_cron 15s tick and `deliver()` guards (V2-03), the agent loop/tool registry/persona/memory (V2-04), Canvas sync + change detection + `timeline` module + `mark_done` (V2-05), Gmail classification + email alerts + Calendar busy data (V2-07). Email alerts themselves are V2-07's; V2-06 only *mentions* important unalerted email in the briefing.

---

## 2. Analysis (options → choice → why)

### 2.1 Timezone / DST math: `Intl` vs Temporal vs a library

| Option | Verdict | Why |
|---|---|---|
| Native `Temporal` | ❌ for now | Enabled by default only in **Node 26** (nodejs.org release notes). Vercel offers **24.x (default), 22.x, 20.x** — no 26. Node 24 does not ship it unflagged **[verify]**. Local dev is Node 22.16 (`typeof Temporal === "undefined"`, checked). |
| `temporal-polyfill@1.0.5` / `@js-temporal/polyfill` | Runner-up | Correct and spec-complete, but an extra dependency for ~80 lines of logic, and the brief says "Use `Intl`". |
| `luxon` / `date-fns-tz` | ❌ | Extra dependency; brief prefers `Intl`. |
| **`Intl.DateTimeFormat(...).formatToParts` + a 2-pass offset solver** | ✅ | Zero deps, full ICU tz data ships with Node and Vercel. Prototyped in the scratchpad against real transitions (vectors in §10). **Mirror Temporal's semantics** (`disambiguation: "compatible"`: a wall time in a spring-forward gap shifts forward by the gap length; an ambiguous fall-back wall time takes the *earlier* instant), so swapping in `Temporal.ZonedDateTime` later is mechanical. |

**Algorithm (`zonedToUtc(local, tz)`):** `wall = Date.UTC(y,m,d,h,mi)`; `o1 = offset(tz, wall)`; `t = wall − o1`; `o2 = offset(tz, t)`; if `o2 ≠ o1` then `t = wall − o2` and if `offset(tz, t) ≠ o2` it's a **gap** → return `wall − min(o1, o2)` (shift forward). Otherwise check for an **overlap**: let `oMax = max(offset(t−3h), offset(t+3h))`; if `c = wall − oMax < t` and `offset(c) = oMax` return `c` (earlier instant). `offset(tz, ms)` = (UTC of the `formatToParts` wall clock) − (ms truncated to seconds). Formatters are cached per tz.

**Never** compute "tomorrow 08:00" as `+24h`; always step the *local date* and re-solve (Nov 1 2026 NY: 25h apart).

### 2.2 Recurrence: `rrule` npm vs `rrule-temporal` vs a tiny subset

| Option | Verdict | Why |
|---|---|---|
| `rrule@2.8.1` | ❌ | Last publish 2023-11-10, last push 2024-06-27, 215 open issues (npm + GitHub API, 2026-10-10). Its own README: *"Returned 'UTC' dates are always meant to be interpreted as dates in your local timezone"* — floating-UTC semantics are exactly the DST-bug surface we are trying to avoid. |
| `rrule-temporal@2.2.8` | Runner-up (V3) | Active (2.2.8 on 2026-10-01), proper tz support, but depends on the Temporal API → needs a polyfill on Node 24 (it lists only `temporal-spec` types) **[verify]**. Revisit when Vercel ships Node 26. |
| **Tiny RFC 5545 subset, own code (~150 LOC)** | ✅ | Students need "every day at 10pm", "every Mon/Wed 9am", "weekdays 8:30", "every other Fri", "the 1st of every month". Supported: `FREQ=DAILY|WEEKLY|MONTHLY`, `INTERVAL` (1–12), `BYDAY` (plain weekdays, no ordinals), `BYMONTHDAY` (single 1–31; months without that day are skipped, per RFC), `COUNT` (≤365) **or** `UNTIL` (date). Time-of-day comes from a **floating** `DTSTART` (no `TZID`), evaluated in the user's *current* `users.timezone` at compute time. Stored as a valid RFC 5545 string (`DTSTART:20261012T090000\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE`) so a later swap to `rrule-temporal` reads the same column. Anything else → tool validation error ("keep it simple: daily/weekly/monthly"). |

The model never writes RRULE text. It fills a structured `recurrence` object (§9) and code serializes it.

### 2.3 Reminder text: template vs LLM at fire time

- **User reminders → the model writes the final text at creation time** (`create_reminder.text`, persona voice, self-contained, ≤300 chars). At fire time we send it verbatim. That means $0, 0 ms of LLM latency, nothing to fail at fire time, and the ~15 s budget is all dispatch. The tool description tells the model to write text that stays true if the anchor moves ("4190 pset due in 2h 👀", not "due at 9pm").
- **Auto T-3h nudges and due-change alerts → deterministic templates** in two registers (`casual` default, `neutral`), with a small rotating phrase pool picked deterministically by `hash(itemId + date)` so repeated nudges vary. Times are pre-rendered in local time by code.
- **Briefing → LLM** (Haiku 5.5, `briefing` route, medium effort). It's the one place synthesis earns its cost (§2.9).
- Rejected: an LLM call per reminder/nudge (adds ~1–3 s and a failure mode at the exact moment that matters, for ~$0.0003 of "voice" we already get from creation-time text).

### 2.4 One mechanism for user reminders *and* auto nudges

T-3h nudges are stored as `reminders` rows with `origin='auto'`, `kind='anchored'`, `offset_minutes=180` (or the user's offsets). So anchored recompute, cancel-on-done, re-arm-on-move, the job linkage, and fire-time validation are **one code path**. To bound row count, auto-nudge rows are created **lazily**: only for items due in the next 36 h, ensured by (a) the briefing prepare step, (b) the `timeline_changes` handler for created/moved items, and (c) the daily reconcile. A unique index `(anchor_item_id, offset_minutes) WHERE origin='auto'` makes "ensure" an idempotent upsert.

`reminders.due_at` is always **the next fire instant** (denormalized). The rule lives in `kind` + `anchor_item_id/offset_minutes` or `rrule`. `reminders` is the source of truth; `jobs.run_at` is a cache of it. The fire handler re-validates against `reminders.due_at`, and if the job is early (the row moved later) it reschedules itself and exits. That makes stale jobs harmless.

### 2.5 Briefing pipeline

```
users.next_briefing_at (UTC, DST-solved from briefing_time in users.timezone)
   │  job briefing_prepare  run_at = target − (10 + hash(userId) % 11) min, dedupe "briefing_prep:{userId}"
   ▼
prepare: verify target still == users.next_briefing_at (else reschedule & exit)
         → INSERT briefings(user_id, local_date) ON CONFLICT DO NOTHING (exit if sent/skipped)
         → schedule NEXT day's prepare first (the chain never breaks on a failure below)
         → ensure auto-nudges for items due ≤36h
         → load inputs → buildBriefingSnapshot (pure) → snapshot_hash
         → generateBriefingPlan (Haiku 5.5; zod-validated JSON; template fallback)
         → briefings.status='ready', plan, generated_at
         → job briefing_send run_at = target, dedupe "briefing_send:{userId}:{localDate}"
   ▼
send: reload inputs → if snapshot_hash changed materially → regenerate (one more LLM call)
      → mint /week magic link (aggregate n) → deliver(userId, plan, {proactive, reason:'briefing',
        idempotencyKey:'briefing:{userId}:{localDate}', deferMode:'return'})
      → sent: status='sent', consume briefing_notes, update users.last_briefing_sent_at
      → deferred(until): apply staleness rule (§2.6) → re-enqueue briefing_send(regenerate) or skip
```

- **Idempotency layers:** `briefings UNIQUE(user_id, local_date)`; job dedupe keys; `deliver` `idempotencyKey` (required from V2-03, §8). A double-claimed job, a retry after a crash mid-send, or a timezone change that keeps the same local date can't produce two briefings.
- **Pre-generation timing:** 10–20 min early with per-user jitter (spec). At 4 users there's no herd, but it makes 08:00 delivery exact even if the LLM call is slow. It also gives a retry window: a failed prepare retries via V2-03 backoff, and if it's still failing at target − 1 min, the send job uses the template fallback.
- **Freshness:** the hash covers the included items' `(id, due_at, status, title)`, events, unconsumed note ids and email ids. A Canvas sync landing between prepare and send triggers one regeneration.
- **Content (snapshot, all times pre-rendered local by code; the model never converts time zones):**
  - Today's deadlines (local "today", all-day items shown as "today" with no time) and tomorrow-before-noon items (the folded T-24h nudge).
  - Today's classes/events (timeline `class|event|block` from V2-05/V2-07).
  - Exam countdown at T-7/5/3/1/0 local days (ported).
  - Load: light/busy/heavy from count due ≤48h (ported thresholds 0–1 / 2–3 / 4+).
  - Changes since the last briefing (`briefing_notes`: far-out due moves, removed items, expired alerts, queued preference proposals from V2-04).
  - Up to 3 important unalerted emails since the last briefing (`email_items.importance in ('high','medium')`, `alerted_at is null`), when Gmail is connected.
  - **One suggestion**, computed deterministically: the hardest item (highest V2-05 `urgencyScore`, tiebreak by syllabus weight) and the longest free gap ≥60 min today between `max(now, briefing_time)` and 22:00 local that ends before its due time. Busy intervals come from timeline events (and V2-07's busy data if exposed). The model only phrases it.
  - Monday (local): a 7-day view grouped by day.
  - Link: `/week` magic link with `preview {kind:'week', n: count due in 7 days}` (aggregate only, per `previewTitle`), appended by **code** as `plan.link`. The model output is URL-stripped.
- **Output contract:** the model returns `{"bubbles": string[1..3]}` (each ≤320 chars, the last one invites a reply). It's parsed with zod. Two failures → `templateBriefing(snapshot)`, so a briefing is never blocked by an LLM outage.
- **Untrusted data:** Canvas titles, calendar titles and email subjects go inside `<untrusted_data source="…">` blocks with an instruction that they're data, not instructions (spec §3.22). The briefing call has **no tools**, so the worst an injection can do is change wording. URLs in model output are removed. Briefing output never writes memory.

### 2.6 Deferral & staleness ("deferred, not dropped", made concrete)

Briefings use `deferMode:'return'` so stale text is never sent. The content is **regenerated** at the deferred time:

| `until` in the user's local time (same local date) | Action |
|---|---|
| before 12:00 | regenerate the normal briefing at `until` |
| 12:00–17:59 | `kind='catchup'`: compact, only items due within 36 h plus changes; skip if empty |
| ≥18:00 or a later date | `status='skipped'`, `skip_reason='stale'`; notes stay unconsumed and roll into tomorrow |

Other proactive kinds:

| Kind | deliver flags | If suppressed |
|---|---|---|
| User reminder | `requested:true` (bypasses quiet hours + daily cap; respects opt-out + pause) | Pause → `persist` deferral; text prefixed "(from earlier)" if >30 min late |
| T-3h nudge | `urgent:true` (bypasses cap + bundling delay; respects quiet hours) with `notAfter = due_at − 15 min` | expired → drop (the deadline is passing, and the briefing already covered it) |
| Due-change alert ≤7 d | `urgent` if the new due is ≤48 h away or moved **earlier**; else normal. `notAfter = users.next_briefing_at` | expired → `briefing_notes` row (folded into the next briefing) |
| Connect-Canvas nudge | normal, `deferMode:'return'` | skip; count only successful sends |

**Quiet-hour-aware nudge placement (pure `placeNudge`):** with intended = due − offset, if intended falls in quiet hours, pull it earlier to `quiet_start − 15 min` when that is ≥ now and ≤6 h before intended. Otherwise push it later to `quiet_end` if that is ≤ due − 30 min. Otherwise don't nudge: the morning briefing lists it. Example: due 01:00 with T-3h at 22:00 (quiet) → 21:45. Due 09:00 with T-3h at 06:00 → pull would be 8 h early → push to 08:00 ≤ 08:30 ✓.

**Coalescing:** when a nudge fires, the handler claims every other scheduled auto-nudge for the same user with `due_at ≤ now + 30 min` and sends **one** message listing them. Due-change alerts are bundled per `timeline_changes` batch. A batch with >5 immediate changes, or V2-05's `initial` import flag, sends one summary line + `/week` link (no flood).

### 2.7 Scheduling plumbing

| Event | Who calls | What happens |
|---|---|---|
| User created / verified ("Hey Aria") | V2-03 identity flow → `scheduleNextBriefing(userId)` | compute `next_briefing_at`, enqueue `briefing_prepare` |
| Briefing prepared | V2-06 itself | chains next day's prepare **before** generating |
| Timezone / briefing_time / briefing_enabled / quiet hours change | whoever writes `users` (V2-04 profile tool, `/settings`, `update_notification_settings`) → `onUserScheduleSettingsChanged(userId)` | recompute `next_briefing_at` (replace job), re-place auto nudges, recompute **recurring** reminders (floating), leave absolute and anchored instants unchanged |
| Timeline change list | V2-05 enqueues `timeline_changes`; `mark_done` calls `handleTimelineChanges` directly | §2.8 |
| Daily reconcile (Vercel cron, 1×/day) | `/api/cron/daily` | heartbeat write + for every active user: fix missing/mismatched briefing job, re-sync `reminders`↔`jobs`, expire very late reminders, ensure auto nudges. This self-heals every chain. |

`next_briefing_at` rule: the earliest local date D ≥ today(tz) whose solved instant of `briefing_time` is > now + 2 min. If `briefing_time` lies in the user's quiet window, it's clamped to `quiet_end` (and the settings tool rejects that combination with a friendly error). An invalid `users.timezone` falls back to `America/New_York` and logs a warning.

### 2.8 Consuming V2-05's change list

`handleTimelineChanges(userId, changes, now)`:
- `due_changed` (|Δ| ≥5 min, item upcoming, new due in future): recompute every anchored reminder on that item (user + auto). Re-arm `sent` ones whose new fire time is in the future. Re-place auto nudges. Then classify: `min(old,new) ≤ now+7d` → immediate alert (bundled per batch). Otherwise → `briefing_notes(kind='due_changed')`.
- `created` with due ≤36 h: ensure auto nudges. If due ≤24 h and not `initial`, include a "new on Canvas" line in the batch alert.
- `status_changed` to `done|dismissed`: cancel auto nudges. Cancel user **anchored** reminders on that item too (default; §13 Q3) and let the agent mention it in its reply when the change came from `mark_done`.
- `removed`: cancel auto nudges. Cancel user anchored reminders and add `briefing_notes(kind='reminder_cancelled')`. If it was due ≤7 d, add `briefing_notes(kind='item_removed')` ("X disappeared from Canvas — maybe cancelled?").
- Idempotent: alert `idempotencyKey = due_change:{itemId}:{newDueIso}`, note `dedupe_key` likewise. Replaying a batch is a no-op.

### 2.9 Failure modes (and the handling)

| Failure | Handling |
|---|---|
| DST gap (`briefing_time 02:30`, Mar 8 NY) | `compatible` → 03:30 EDT (07:30Z). Briefing still sent once that day. |
| DST overlap (01:30, Nov 1 NY) | earlier instant (05:30Z). The `(user_id, local_date)` unique blocks a second send. |
| Naive +24h after fall-back | never used. Next briefing is solved from the local date (25 h apart on Nov 1). |
| User changes timezone mid-day | `onUserScheduleSettingsChanged` replaces the prepare job. If today's local date in the new tz was already briefed → unique row prevents a duplicate. Absolute reminders keep their instant; recurring ones follow the new tz. |
| Briefing generated, send deferred past noon | regenerate as catch-up or skip at ≥18:00 (§2.6). Stale text is never sent. |
| Duplicate job fire / retry after crash | dedupe keys + conditional claims (`UPDATE … WHERE status='scheduled' AND due_at=$expected RETURNING`) + `deliver` `idempotencyKey`. At-least-once execution, effectively-once send. |
| Reminder anchor deleted | FK `on delete set null` + `kind='anchored'` with null anchor → the fire handler cancels and adds a briefing note. The `removed` change cancels it earlier anyway. |
| Item marked done | auto nudges cancelled. The fire handler also re-checks anchor `status='upcoming'` (belt and braces). |
| Job early vs row (row moved later) | the handler sees `reminders.due_at > now + 20 s` → re-enqueues at `due_at`, exits. |
| Job missing / later than row | daily reconcile re-syncs `jobs.run_at` to `reminders.due_at`. |
| DB paused / outage → backlog of overdue reminders | one-off: fire if ≤12 h late with "(sorry, late)" prefix, else `expired` + briefing note. Recurring: skip missed occurrences, schedule the next future one. Nudges: `notAfter` drops them. |
| LLM down at briefing time | 2 attempts then `templateBriefing`. |
| Magic-link mint rate-limited (10/h) | briefing goes out without a link. |
| `view` link TTL 15 min vs a briefing read at 10:30 | if the browser already has a session, redeem routes there. Otherwise `/link-expired` → "Text Aria for a new link". Proposed fix: a `digest` purpose with a 12 h TTL (§13 Q1). |
| User sets quiet end after briefing time | briefing is clamped to quiet end; the tool explains. |
| Prompt injection via Canvas/email titles | untrusted wrapping, no tools in the briefing call, URL stripping, and reminder text from the agent is URL-checked (only our domain) and capped at 300 chars. |
| Reminder spam / abuse | ≤50 scheduled user reminders per user, ≤20 created per local day. Recurring min interval: daily. |

### 2.10 Cost per user per day

| Item | Estimate |
|---|---|
| Briefing (Haiku 5.5 at $0.10/MTok in, $0.50/MTok out): ~1.5–2.5k in + ~300–800 out incl. medium-effort thinking | ≈ $0.0005 (×1.2 for occasional regeneration) ≈ **$0.0006** |
| Reminders, nudges, due-change alerts | **$0** LLM (templates) |
| Jobs/dispatch | ~4–10 job rows/day; Vercel Hobby invocations negligible |
| **Total** | **≈ $0.0006/user/day ≈ $0.02/user/month** (spec budget $0.06) |

Raise `ROUTES.briefing.maxTokens` from 1024 to 2048. With adaptive thinking, thinking tokens count toward `max_tokens`, and medium effort can truncate a Monday week view **[verify on first runs; owner of `src/server/llm`]**.

---

## 3. External facts (with URLs)

| Fact | Source |
|---|---|
| Vercel **Hobby** cron: 100 jobs/project, **minimum interval once per day**, precision **per-hour (±59 min)**. More frequent expressions fail deployment. | https://vercel.com/docs/cron-jobs/usage-and-pricing (last_updated 2026-07-15) |
| Cron security: set `CRON_SECRET`; Vercel sends `Authorization: Bearer <CRON_SECRET>`. **No retries** on failure. Delivery is best-effort and may duplicate → make it idempotent. Local `next dev` doesn't run crons (hit the route manually). | https://vercel.com/docs/cron-jobs/manage-cron-jobs (2026-08-11) |
| Vercel Hobby function duration: default and max **300 s** (fluid compute). | https://vercel.com/docs/functions/configuring-functions/duration (2026-08-24) |
| Vercel Node runtimes: **24.x (default), 22.x, 20.x**. Pin with `engines.node`. | https://vercel.com/docs/functions/runtimes/node-js/node-js-versions |
| **Temporal enabled by default in Node 26** (V8 14.6). Node 24/22 don't have it unflagged **[verify Node 24]**. | https://nodejs.org/en/blog/release/v26.0.0 |
| Supabase Free pauses when there's insufficient "user database activity over the past week". "A few user requests to the database each day" is typically enough. Dashboard visits, API calls, or app requests count. **pg_cron is not mentioned → don't rely on it [verify]**. Warning email ~1 week before. Paid plans never pause. | https://supabase.com/docs/guides/platform/free-project-pausing |
| Supabase Cron: schedules from every second to yearly. Recommend ≤8 concurrent jobs, each ≤10 min. | https://supabase.com/docs/guides/cron |
| GitHub Actions `schedule`: min 5 min, may be delayed under load. **Disabled after 60 days of no activity in public repos.** | https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows |
| `rrule` npm: latest 2.8.1 (2023-11-10). GitHub last push 2024-06-27, 215 open issues. README: returned "UTC" dates must be interpreted as local; use UTC-represented `Date`s only. | `npm view rrule` (2026-10-10); https://github.com/jkbrzt/rrule |
| `rrule-temporal` 2.2.8 (2026-10-01), deps: `temporal-spec` only (types) → needs a Temporal runtime/polyfill **[verify README]**. `temporal-polyfill` 1.0.5 (2026-09-11). | `npm view rrule-temporal`, `npm view temporal-polyfill` |
| RFC 5545 floating DTSTART (no TZID) = local time wherever evaluated; BYMONTHDAY on months lacking the day is skipped. | https://www.rfc-editor.org/rfc/rfc5545 §3.3.5, §3.3.10 **[verify section numbers]** |

---

## 4. Schema delta (for the orchestrator's `003_v2_build.sql`; NOT a migration file)

```sql
-- ── V2-06: users — notification settings ──────────────────────────────
alter table users
  add column briefing_enabled        boolean   not null default true,
  add column deadline_nudge_minutes  int[]     not null default '{180}',   -- [] = off; user-tunable ("remind me 2h before")
  add column last_briefing_sent_at   timestamptz,
  add constraint users_nudge_minutes_card check (cardinality(deadline_nudge_minutes) <= 3);
-- Quiet hours belong to V2-03's guards. Listed here ONLY so the consolidated
-- migration contains them exactly once — drop these two lines if V2-03's delta has them.
alter table users
  add column if not exists quiet_hours_start time not null default '22:00',
  add column if not exists quiet_hours_end   time not null default '08:00';

-- ── V2-06: reminders — rule kind, origin, fire bookkeeping ────────────
alter table reminders
  add column kind          text not null default 'absolute'
                             check (kind in ('absolute','anchored','recurring')),
  add column origin        text not null default 'user'
                             check (origin in ('user','auto')),
  add column last_fired_at timestamptz,
  add column fire_count    int  not null default 0,
  add column updated_at    timestamptz not null default now(),
  add constraint reminders_status_chk
      check (status in ('scheduled','sent','cancelled','expired')),
  add constraint reminders_shape_chk check (
       (kind = 'absolute'  and anchor_item_id is null and offset_minutes is null and rrule is null)
    or (kind = 'anchored'  and offset_minutes is not null and rrule is null)
    or (kind = 'recurring' and rrule is not null and anchor_item_id is null)),
  add constraint reminders_anchor_fk
      foreign key (anchor_item_id) references timeline_items(id) on delete set null;
-- body is NOT NULL in the baseline; auto nudges store a short label (title) in body.
create unique index reminders_auto_nudge_uniq
  on reminders (anchor_item_id, offset_minutes)
  where origin = 'auto' and anchor_item_id is not null;
create index reminders_anchor_idx on reminders (anchor_item_id) where anchor_item_id is not null;
create index reminders_user_status_idx on reminders (user_id, status);

-- ── V2-06: briefings — one row per (user, local date); idempotency + audit ──
create table briefings (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  local_date    date not null,                    -- in users.timezone at prepare time
  kind          text not null default 'daily'
                  check (kind in ('daily','monday','catchup','connect_nudge','empty')),
  status        text not null default 'preparing'
                  check (status in ('preparing','ready','sent','deferred','skipped','failed')),
  target_at     timestamptz not null,
  snapshot_hash text,
  plan          jsonb,                             -- rendered bubbles; purged with 180-day retention
  skip_reason   text,
  llm_cost_usd  numeric(10,6),
  generated_at  timestamptz,
  sent_at       timestamptz,
  created_at    timestamptz not null default now(),
  unique (user_id, local_date)
);
create index briefings_user_kind_idx on briefings (user_id, kind);
alter table briefings enable row level security;

-- ── V2-06: briefing_notes — things to mention in the next briefing ────
create table briefing_notes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  kind        text not null check (kind in
                ('due_changed','item_removed','reminder_cancelled','reminder_expired',
                 'alert_expired','preference_proposal','other')),
  item_id     uuid references timeline_items(id) on delete cascade,
  payload     jsonb not null default '{}'::jsonb,  -- e.g. {title, course, oldDue, newDue}; no email bodies
  dedupe_key  text,
  created_at  timestamptz not null default now(),
  consumed_at timestamptz,
  consumed_by uuid references briefings(id) on delete set null
);
create unique index briefing_notes_dedupe
  on briefing_notes (user_id, dedupe_key) where consumed_at is null and dedupe_key is not null;
create index briefing_notes_open_idx on briefing_notes (user_id) where consumed_at is null;
alter table briefing_notes enable row level security;

-- ── V2-06: keepalive heartbeat (written via PostgREST by /api/cron/daily) ──
create table system_heartbeat (
  id      text primary key,                      -- 'daily-cron' | 'gh-actions'
  beat_at timestamptz not null default now(),
  detail  jsonb
);
alter table system_heartbeat enable row level security;
```

**Requested from other branches' deltas (not written here):** `email_items.alerted_at timestamptz` (V2-07, so the briefing skips emails already alerted). V2-05's `timeline_items` already has `status` and `due_at`. V2-06 needs V2-05 to expose all-day-ness (e.g., `raw->>'all_day'` or a column; V2-05 decides).

---

## 5. Dependencies

**None.** Uses `zod@^4.6.5` (installed), `@supabase/supabase-js` (installed), `Intl` (built in). Explicitly rejected: `rrule`, `rrule-temporal`, `temporal-polyfill`, `luxon`, `date-fns-tz` (§2.1, §2.2). Recommend pinning `"engines": {"node": "24.x"}` in `package.json` (orchestrator) so Vercel and CI match.

## 6. Env vars

| Var | Purpose | Required |
|---|---|---|
| `CRON_SECRET` | Vercel cron → `/api/cron/daily` (`Authorization: Bearer …`); also used by the optional GitHub Actions keepalive | prod: yes; dev: optional (route then accepts only localhost) |

Everything else is reused: `APP_BASE_URL` (magic links), `ANTHROPIC_API_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. Add `CRON_SECRET=` to `.env.example` (orchestrator).

---

## 7. File plan (path → purpose → exported signatures)

All exports carry JSDoc. Pure modules have no imports from `@/server/db` or `@/server/llm`.

### Pure (shared)

**`src/shared/time/tz.ts`**: IANA/DST math with `Intl` only. V2-03's quiet-hours code should import this rather than duplicate it.
```ts
export interface LocalDate { year: number; month: number; day: number }          // month 1-12
export interface LocalTime { hour: number; minute: number }
export interface LocalDateTime extends LocalDate, LocalTime {}
export type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";
export const DEFAULT_TIME_ZONE = "America/New_York";
export function isValidTimeZone(tz: string): boolean;
export function safeTimeZone(tz: string | null | undefined): string;              // invalid → DEFAULT_TIME_ZONE
export function offsetMinutes(tz: string, instant: Date): number;
export function toLocal(instant: Date, tz: string): LocalDateTime & { weekday: Weekday };
export function zonedToUtc(local: LocalDateTime, tz: string): { instant: Date; adjusted: "none" | "gap_shifted" | "overlap_earlier" };
export function localDateOf(instant: Date, tz: string): LocalDate;
export function addLocalDays(d: LocalDate, n: number): LocalDate;                 // calendar arithmetic, no tz
export function weekdayOf(d: LocalDate): Weekday;
export function compareLocalDate(a: LocalDate, b: LocalDate): -1 | 0 | 1;
export function formatLocalDate(d: LocalDate): string;                            // "2026-10-12"
export function parseHHMM(s: string): LocalTime;                                  // "08:00" | "08:00:00" (Postgres time)
export function parseLocalDateTime(s: string): LocalDateTime | null;              // "2026-10-12T21:30"
export function isInDailyWindow(t: LocalTime, start: LocalTime, end: LocalTime): boolean; // midnight-spanning
export function formatForChat(instant: Date, tz: string, now: Date, opts?: { allDay?: boolean }): string;
//   → "9pm", "today 11:59pm", "tmrw 9am", "Thu 11:59pm", "Thu Oct 15" (all-day/far) — lowercase am/pm, no leading zero
export function formatForTool(instant: Date, tz: string): string;                // "Tue Oct 13, 9:00 PM EDT" (unambiguous, for the model)
```

**`src/shared/time/rrule-lite.ts`**: the RFC 5545 subset (§2.2).
```ts
export type Freq = "DAILY" | "WEEKLY" | "MONTHLY";
export interface RecurrenceSpec {
  dtstart: LocalDateTime;           // floating
  freq: Freq;
  interval: number;                 // 1..12
  byDay?: Weekday[];                // WEEKLY (or DAILY filter)
  byMonthDay?: number;              // MONTHLY, 1..31
  count?: number;                   // 1..365
  until?: LocalDate;                // inclusive, local
}
export function validateRecurrence(spec: RecurrenceSpec): string | null;         // error message or null
export function toRRuleString(spec: RecurrenceSpec): string;                     // "DTSTART:...\nRRULE:..."
export function parseRRuleString(s: string): RecurrenceSpec;                     // throws on unsupported
export function nextOccurrence(spec: RecurrenceSpec, tz: string, after: Date, firedCount: number): Date | null;
export function describeRecurrence(spec: RecurrenceSpec): string;                // "every Mon & Wed at 9am"
```

### Pure (server)

**`src/server/proactive/schedule.ts`**
```ts
export interface QuietWindow { start: LocalTime; end: LocalTime }
export function nextBriefingAt(args: { tz: string; briefingTime: LocalTime; quiet: QuietWindow; now: Date }): { at: Date; localDate: LocalDate };
export function prepRunAt(target: Date, userId: string, now: Date): Date;        // target − (10 + hash%11) min, ≥ now
export function anchoredFireAt(anchorAt: Date, offsetMinutes: number): Date;
export function placeNudge(args: { dueAt: Date; offsetMinutes: number; tz: string; quiet: QuietWindow; now: Date }): Date | null;
export type DueChangeRoute = { route: "alert"; urgent: boolean } | { route: "briefing" } | { route: "ignore" };
export function classifyDueChange(c: { oldDueAt: Date | null; newDueAt: Date | null; status: string }, now: Date): DueChangeRoute;
export type BriefingDeferral = { action: "regenerate"; kind: "daily" | "monday" | "catchup" } | { action: "skip" };
export function briefingDeferral(until: Date, localDate: LocalDate, tz: string, baseKind: "daily" | "monday"): BriefingDeferral;
export function lateFirePolicy(dueAt: Date, now: Date, kind: "absolute" | "anchored" | "recurring", origin: "user" | "auto"):
  "fire" | "fire_late_prefix" | "expire" | "skip_to_next";
```

**`src/server/briefing/snapshot.ts`**: deterministic assembly (port of V1 load score + exam touchpoints).
```ts
export interface BriefingInputs { /* user (name, tz, briefingTime, persona register), now, items (timeline rows), events,
  notes (briefing_notes), emails (email_items subset), busy: {start: Date; end: Date}[], integrations: {canvas: boolean; google: boolean},
  isMonday: boolean } */ }
export interface BriefingSnapshot {
  kind: "daily" | "monday" | "catchup" | "connect_nudge" | "empty";
  localDateLabel: string;                       // "Mon Oct 12"
  load: "light" | "busy" | "heavy";
  dueToday: SnapshotItem[]; dueTomorrowMorning: SnapshotItem[]; week?: { day: string; items: SnapshotItem[] }[];
  events: { title: string; when: string }[];    // pre-rendered local times
  exams: { title: string; course: string | null; daysUntil: number }[];
  changes: { text: string }[]; emails: { from: string; subject: string; kind: string | null }[];
  suggestion: { itemTitle: string; gap: string } | null;
  weekCount: number;                             // for the magic-link preview
}
export interface SnapshotItem { id: string; title: string; course: string | null; when: string; weightPct: number | null }
export function computeLoad(countDue48h: number): "light" | "busy" | "heavy";
export function examTouchpoints(items: TimelineLike[], tz: string, now: Date): { item: TimelineLike; daysUntil: number }[];
export function findSuggestion(items: TimelineLike[], busy: { start: Date; end: Date }[], tz: string, now: Date, windowEnd: LocalTime): BriefingSnapshot["suggestion"];
export function buildBriefingSnapshot(inputs: BriefingInputs): BriefingSnapshot;
export function snapshotHash(s: BriefingSnapshot): string;                        // sha256 of canonical JSON (node:crypto)
export function isEmptySnapshot(s: BriefingSnapshot): boolean;
```

**`src/server/briefing/prompt.ts`**
```ts
export const BRIEFING_SYSTEM_PROMPT: string;        // persona rules, output JSON contract, 5 few-shots (normal, heavy, empty, Monday, exam)
export function renderSnapshotForModel(s: BriefingSnapshot, register: "casual" | "neutral"): string; // untrusted blocks wrap titles/subjects
```

**`src/server/briefing/template.ts`**
```ts
export function templateBriefing(s: BriefingSnapshot, register: "casual" | "neutral"): string[];  // 1–3 bubbles, LLM-free fallback
```

**`src/server/reminders/render.ts`**
```ts
export type Register = "casual" | "neutral";
export function renderUserReminder(body: string, opts: { lateMinutes: number }): string;
export function renderNudge(items: { title: string; course: string | null; dueAt: Date }[], tz: string, now: Date, register: Register, seed: string): string[];
export function renderDueChangeAlert(changes: { title: string; course: string | null; oldDueAt: Date | null; newDueAt: Date }[], tz: string, now: Date, register: Register): string[];
export function renderConnectNudge(attempt: 1 | 2 | 3, register: Register): string[];
export function stripUrls(text: string, allowOrigin: string): string;
```

### DB / side-effecting

**`src/server/proactive/settings.ts`**
```ts
export interface NotificationSettings { tz: string; briefingTime: LocalTime; briefingEnabled: boolean; nudgeMinutes: number[]; quiet: QuietWindow; register: Register }
export async function getNotificationSettings(userId: string): Promise<NotificationSettings>;
export async function updateNotificationSettings(userId: string, patch: Partial<Pick<NotificationSettings, "briefingTime" | "briefingEnabled" | "nudgeMinutes">>): Promise<NotificationSettings>;
```

**`src/server/briefing/scheduler.ts`**
```ts
export async function scheduleNextBriefing(userId: string, now?: Date): Promise<{ at: Date; localDate: string } | null>; // null if disabled/deleted
export async function onUserScheduleSettingsChanged(userId: string, now?: Date): Promise<void>;
```

**`src/server/briefing/load.ts`**
```ts
export async function loadBriefingInputs(userId: string, now: Date, kind: "daily" | "monday" | "catchup"): Promise<BriefingInputs>;
```

**`src/server/briefing/generate.ts`**
```ts
export interface BriefingPlan { bubbles: string[]; costUsd: number; source: "llm" | "template" }
export async function generateBriefingPlan(s: BriefingSnapshot, register: Register, userId: string): Promise<BriefingPlan>;
```

**`src/server/briefing/run.ts`**: handler bodies (kept out of `jobs/kinds/*` so they're testable).
```ts
export async function prepareBriefing(userId: string, payload: { targetAt: string; localDate: string }, now: Date): Promise<void>;
export async function sendBriefing(userId: string, payload: { localDate: string; regenerate?: boolean; kind?: "catchup" }, now: Date): Promise<void>;
```

**`src/server/reminders/service.ts`**
```ts
export type CreateReminderInput = CreateReminderToolInput;          // see §9
export type CreateReminderResult =
  | { ok: true; reminderId: string; firesAtLocal: string; recurrence?: string; adjusted?: "gap_shifted" | "overlap_earlier" }
  | { ok: false; error: string };                                    // model-readable reason (past time, unknown item, too many…)
export async function createReminder(userId: string, tz: string, input: CreateReminderInput, now: Date): Promise<CreateReminderResult>;
export async function listReminders(userId: string, tz: string, opts: { includeAuto: boolean; limit: number }): Promise<ReminderView[]>;
export async function cancelReminder(userId: string, reminderId: string): Promise<{ ok: boolean; error?: string }>;
export async function ensureAutoNudges(userId: string, now: Date, itemIds?: string[]): Promise<number>;     // items due ≤36h
export async function recomputeAnchored(userId: string, itemId: string, anchorAt: Date | null, now: Date): Promise<void>;
export async function cancelForItem(userId: string, itemId: string, scope: "auto" | "all", reason: string): Promise<number>;
export async function recomputeRecurring(userId: string, tz: string, now: Date): Promise<void>;
export async function reconcileReminderJobs(userId: string, now: Date): Promise<{ fixed: number }>;
```

**`src/server/reminders/fire.ts`**
```ts
export async function fireReminder(payload: { reminderId: string; dueAt: string }, now: Date): Promise<void>;
```

**`src/server/alerts/timeline-changes.ts`**
```ts
export async function handleTimelineChanges(userId: string, batch: TimelineChangeBatch, now: Date): Promise<{ alerted: number; noted: number }>;
```

**`src/server/proactive/reconcile.ts`**
```ts
export async function reconcileUser(userId: string, now: Date): Promise<ReconcileReport>;
export async function reconcileAll(now: Date): Promise<ReconcileReport[]>;     // bounded loop, ≤ 250 s total
export async function writeHeartbeat(source: "daily-cron" | "gh-actions", detail: Record<string, unknown>): Promise<void>;
```

### Job kinds (one file each + one registry line in `src/server/jobs/kinds/index.ts`)

`src/server/jobs/kinds/reminder-fire.ts`, `briefing-prepare.ts`, `briefing-send.ts`, `timeline-changes.ts`. Each one exports a `JobHandler` that zod-parses `payload` and calls the function above with `ctx.now`.

### Agent tools (one file each + one registry line in `src/server/agent/tools/index.ts`)

`src/server/agent/tools/create-reminder.ts`, `list-reminders.ts`, `cancel-reminder.ts`, `update-notification-settings.ts` via `defineTool`. Append them to the registry array in a stable position (end of the reminders group), so the cached prefix stays stable after first deploy.

### Routes / infra

- `src/app/api/cron/daily/route.ts`: `GET`. Checks `Authorization: Bearer ${CRON_SECRET}` (timing-safe compare). Calls `writeHeartbeat` (PostgREST write = "activity") then `reconcileAll`. `export const maxDuration = 300`. Returns JSON counts. Returns 500 on DB failure, which surfaces in Vercel logs/Sentry if the project paused.
- `vercel.json` (**shared file, orchestrator merges**): `{"crons":[{"path":"/api/cron/daily","schedule":"0 10 * * *"}]}`. 10:00 UTC ≈ 06:00 ET, fires 10:00–10:59.
- `.github/workflows/keepalive.yml` (optional, §13 Q6): `schedule: "23 3,15 * * *"`, `curl -fsS -H "Authorization: Bearer $CRON_SECRET" "$APP_BASE_URL/api/cron/daily?source=gh"`.
- `src/server/security/link-policy.ts` (**V2-02-owned; tiny change, §13 Q1**): add purpose `digest` (TTL 12 h, scope `view`, default target `/week`).

### Tests

`tests/unit/time/tz.test.ts`, `tests/unit/time/rrule-lite.test.ts`, `tests/unit/proactive/schedule.test.ts`, `tests/unit/briefing/snapshot.test.ts`, `tests/unit/briefing/template.test.ts`, `tests/unit/reminders/render.test.ts`, `tests/unit/reminders/create-validation.test.ts`, `tests/smoke/v2-06.smoke.test.ts` (opt-in).

---

## 8. Interfaces provided / consumed

### Provided by V2-06

| Export | Used by |
|---|---|
| `src/shared/time/tz.ts` (all) | V2-03 quiet hours/daily cap date, V2-04 "now" snapshot, V2-05 display, V2-07 slot finding |
| `scheduleNextBriefing(userId)` | V2-03 / V2-02 when a user becomes active (verified) |
| `onUserScheduleSettingsChanged(userId)` | anyone writing `users.timezone`, `briefing_time`, `briefing_enabled`, quiet hours (V2-04 profile tool, `/settings`, V2-03 quiet-hours edits) |
| `handleTimelineChanges(userId, batch, now)` + job kind `timeline_changes` | V2-05 (sync → enqueue; `mark_done` → direct call) |
| `briefing_notes` insert helper `addBriefingNote(userId, kind, payload, dedupeKey?)` (in `src/server/briefing/notes.ts`) | V2-04 queued preference proposals; V2-07 low-importance email if they prefer push to pull |
| `formatForChat` / `formatForTool` | V2-04 renderer/tools, V2-05/V2-07 tool outputs |

### Consumed — exact needs

**From V2-03 (jobs + channels):**
1. `enqueueJob({kind, userId, runAt, payload, dedupeKey, onConflict?: "replace" | "keep_earliest"})`. Default `"replace"`: overwrite `run_at` **and** `payload` of the pending row with that key, **including moving it earlier** (reminders move earlier when a due date moves up). Returns `{id}`.
2. `cancelJobByDedupeKey(key): Promise<number>`: deletes or marks `cancelled` the pending row.
3. `JobHandler = (job: {id, kind, userId, payload: unknown, runAt: Date, attempts: number}, ctx: {now: Date}) => Promise<void>`. Thrown errors → retry with backoff, dead-letter after N. `ctx.now` is injectable for tests.
4. `deliver(userId, plan: ReplyPlan, opts: DeliverOpts): Promise<DeliverResult>` with:
   ```ts
   interface DeliverOpts {
     proactive: boolean;
     reason: "briefing" | "reminder" | "deadline_nudge" | "due_change" | "connect_nudge" | string;
     idempotencyKey: string;        // REQUIRED for proactive: at most one successful send per key (record ≥30 days)
     urgent?: boolean;              // bypass daily cap + bundling delay; still quiet hours, pause, opt-out
     requested?: boolean;           // user explicitly asked for this time: bypass quiet hours + cap; still pause, opt-out
     deferMode?: "persist" | "return";  // persist (default): V2-03 stores the plan, re-runs guards at `until`; return: caller re-plans
     notAfter?: Date;               // if earliest allowed send > notAfter → {status:"expired"}, nothing persisted
     bundleKey?: string;            // optional: merge with other plans of the same key within 10 min
   }
   type DeliverResult =
     | { status: "sent"; messageIds: string[]; sentAt: Date }
     | { status: "duplicate" }                          // idempotencyKey already sent
     | { status: "deferred"; until: Date; jobId?: string }
     | { status: "expired"; earliest: Date }
     | { status: "blocked"; reason: "opted_out" | "no_channel" | "deleted" };
   ```
   Deferral semantics: on `persist`, V2-03 enqueues its own job at `until` with `{plan, opts}` and re-applies **all** guards then (another deferral is fine; `notAfter` still enforced). Bundling must never reorder bubbles inside a plan and must not delay `urgent`/`requested` sends. The daily cap counts `briefing`, `due_change` (non-urgent) and `connect_nudge`. Requested reminders and urgent sends are not counted (or counted but never blocked; V2-03 decides).
5. A pure guard helper exported for planning: `nextAllowedProactiveAt(settings, tz, from: Date, flags: {urgent?: boolean; requested?: boolean}): Date`, built on `tz.ts`, so `placeNudge` and V2-03 agree on the window.
6. The 15 s pg_cron tick and `/api/jobs/dispatch` (V2-03 owns `cron.schedule`).
7. Dev channel provider that records outbound plans (for E2E).

**From V2-04 (agent + memory):**
1. `defineTool({name, description, input, run(ctx, input)})` with `ctx = {userId, runId, now, timezone, channel}`; tool results are JSON-serializable objects returned to the model.
2. `ReplyPlan` type (assumed `{bubbles: {text: string; replyToMessageId?: string}[]; reactions?: …; link?: string}`). V2-06 builds plans with `bubbles` + `link` only.
3. Persona register: `users.persona_prefs.register ∈ {"casual","neutral"}` (or a getter). Default `"casual"`.
4. Few-shot coverage in the cached prefix: (a) "remind me 2h before it's due" → anchored reminder + optional "you sure you can finish?" pushback; (b) "always remind me 2h before deadlines" → `update_notification_settings`; (c) "remind me in 20" → `{type:"in"}`; (d) "every weekday 8:30" → recurring; (e) a reply after a nudge ("done") → `mark_done`.
5. Tool gating: state-creating tools (`create_reminder`, `update_notification_settings`) run only in turns triggered by user-authored inbound messages (friend-protection #2).
6. "Now" snapshot should list the next 3 scheduled user reminders (via `listReminders`) so the model can answer "what reminders do I have" without a tool call. Optional.

**From V2-05 (timeline):**
```ts
interface TimelineChange {
  itemId: string;
  kind: "created" | "due_changed" | "status_changed" | "removed";
  source: "canvas" | "gcal" | "syllabus" | "aria" | "gmail";
  itemKind: "assignment" | "exam" | "event" | "class" | "block";
  title: string | null; course: string | null;
  oldDueAt: string | null; newDueAt: string | null;          // ISO; for events use starts_at
  status: "upcoming" | "done" | "dismissed";
  allDay?: boolean;
}
interface TimelineChangeBatch { initial: boolean; changes: TimelineChange[] }   // initial = first import / iCal URL changed
```
- After committing a sync, enqueue `{kind:"timeline_changes", userId, payload: batch, dedupeKey: "tlc:{userId}:{syncRunId}"}` (at-least-once; V2-06 is idempotent).
- `mark_done` (or any status write) calls `handleTimelineChanges` directly with a `status_changed` change.
- Read helpers: `listItems(userId, {from, to, kinds?, statuses?})` and `urgencyScore(item, now)`.
- If V2-05 hard-deletes items, the FK `on delete set null` covers it, but a `removed` change should still be emitted first.

**From V2-07 (Google):** `email_items.importance`, `email_items.alerted_at` (set when an immediate email alert was sent). Busy intervals: either mirror the next 8 days of calendar events into `timeline_items` (`kind 'event'`) or export `getBusyIntervals(userId, from, to): Promise<{start: Date; end: Date}[]>` that reads cached data only (no live Google call at briefing time).

**From V2-02:** `mintMagicLink` (exists). Link-policy `digest` purpose (§13 Q1).

**From `src/server/llm`:** `runModel({route:"briefing", system, messages})`. Request: a `meta: {userId?: string; runId?: string; purpose?: string}` field so `llm_calls` can attribute briefing spend (gateway TODO). Raise `briefing.maxTokens` to 2048.

---

## 9. Job kinds + agent tools (zod shapes)

### Job kinds

| Kind | Enqueued by | `run_at` | `dedupe_key` | Payload (zod) |
|---|---|---|---|---|
| `reminder_fire` | `createReminder`, recompute, recurring next, reconcile | `reminders.due_at` | `reminder:{reminderId}` | `z.object({ reminderId: z.uuid(), dueAt: z.iso.datetime() })` |
| `briefing_prepare` | `scheduleNextBriefing`, prepare chain, reconcile | `target − 10..20 min` | `briefing_prep:{userId}` | `z.object({ targetAt: z.iso.datetime(), localDate: z.iso.date() })` |
| `briefing_send` | prepare; deferral re-plan | target / `until` | `briefing_send:{userId}:{localDate}` | `z.object({ localDate: z.iso.date(), regenerate: z.boolean().optional(), kind: z.enum(["catchup"]).optional() })` |
| `timeline_changes` | V2-05 | now | `tlc:{userId}:{syncRunId}` | `TimelineChangeBatchSchema` (mirrors §8) |

### Agent tools

```ts
const LocalDateTimeStr = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
  .describe("Local wall-clock time in the user's timezone, no offset, e.g. 2026-10-13T21:00");
const WeekdayEnum = z.enum(["MO","TU","WE","TH","FR","SA","SU"]);

export const CreateReminderToolInput = z.object({
  text: z.string().trim().min(1).max(300)
    .describe("Exact message Aria will send at fire time, in the user's register. Self-contained; must stay true if the deadline moves (say 'due in 2h', not 'due at 9pm'). No links."),
  when: z.discriminatedUnion("type", [
    z.object({ type: z.literal("in"), minutes: z.number().int().min(1).max(525_600) }),
    z.object({ type: z.literal("at"), local: LocalDateTimeStr }),
    z.object({ type: z.literal("before_item"),
               itemId: z.uuid().describe("timeline item id from get_agenda/search_deadlines"),
               minutesBefore: z.number().int().min(0).max(20_160) }),
    z.object({ type: z.literal("recurring"),
               firstLocal: LocalDateTimeStr,
               freq: z.enum(["daily","weekly","monthly"]),
               interval: z.number().int().min(1).max(12).default(1),
               byDay: z.array(WeekdayEnum).min(1).max(7).optional(),
               byMonthDay: z.number().int().min(1).max(31).optional(),
               until: z.iso.date().optional(),
               count: z.number().int().min(1).max(365).optional() }),
  ]),
});
// Validation (service, returns {ok:false,error} the model can act on):
//  - "at": parsed in ctx.timezone via zonedToUtc; gap → shifted + reported; must be > now+30s and < now+366d.
//    An ISO string WITH offset is also accepted (instant used as-is) for robustness.
//  - "before_item": item must belong to ctx.userId, status upcoming, anchor = due_at ?? starts_at;
//    fire = anchor − minutesBefore must be > now+60s, else error "that's already passed — it's due {formatForTool}".
//  - "recurring": validateRecurrence(); until and count are mutually exclusive; min cadence daily.
//  - text: stripUrls (only APP_BASE_URL origin survives); ≤50 scheduled user reminders; ≤20 created per local day.
// Result: {ok:true, reminderId, firesAt: "Tue Oct 13, 9:00 PM EDT", recurrence?: "every Mon & Wed at 9am", adjusted?}

export const ListRemindersToolInput = z.object({
  includeAutoNudges: z.boolean().default(false),
  limit: z.number().int().min(1).max(20).default(10),
});
// Result: [{id, text, nextAt: formatForTool, kind, anchor?: {title, course}, recurrence?}]

export const CancelReminderToolInput = z.object({
  reminderId: z.uuid().describe("id from list_reminders"),
});
// Ownership-checked; cancels the job (cancelJobByDedupeKey) then sets status='cancelled'.
// Cancelling an auto nudge is allowed and only affects that item.

export const UpdateNotificationSettingsToolInput = z.object({
  briefingTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  briefingEnabled: z.boolean().optional(),
  deadlineNudgeMinutesBefore: z.array(z.number().int().min(15).max(2_880)).max(3).optional()
    .describe("Default heads-up before every deadline; [] turns nudges off. 'remind me 2h before' → [120]"),
}).refine((v) => Object.keys(v).length > 0, "nothing to update");
// Calls updateNotificationSettings → onUserScheduleSettingsChanged. Rejects briefingTime inside quiet hours with a
// readable error. Only explicit user instructions; inferred changes go through V2-04's propose_preference.
```

---

## 10. Test plan

### Unit (Jest, `tests/unit/**`, real logic, no call-chain mocks)

**`time/tz.test.ts`**: vectors verified with the prototype on Node 22.16:

| tz | local wall | expected UTC | note |
|---|---|---|---|
| America/New_York | 2026-03-07 08:00 | 2026-03-07T13:00Z | EST |
| America/New_York | 2026-03-08 08:00 | 2026-03-08T12:00Z | EDT after spring-forward |
| America/New_York | 2026-03-08 02:30 | 2026-03-08T07:30Z | gap → 03:30 EDT, `gap_shifted` |
| America/New_York | 2026-10-31 08:00 | 2026-10-31T12:00Z | EDT |
| America/New_York | 2026-11-01 08:00 | 2026-11-01T13:00Z | EST (25 h after previous) |
| America/New_York | 2026-11-01 01:30 | 2026-11-01T05:30Z | overlap → earlier, `overlap_earlier` |
| America/Los_Angeles | 2026-11-01 08:00 | 2026-11-01T16:00Z | |
| Australia/Sydney | 2026-10-04 02:30 | 2026-10-03T16:30Z | southern-hemisphere gap |
| Australia/Sydney | 2026-10-04 08:00 | 2026-10-03T21:00Z | |
| Australia/Lord_Howe | 2026-10-04 02:15 | 2026-10-03T15:45Z | 30-min DST gap → 02:45 |
| Asia/Kolkata | 2026-10-12 08:00 | 2026-10-12T02:30Z | +05:30, no DST |
| Europe/London | 2026-10-25 01:30 | 2026-10-25T00:30Z | overlap → BST |
| America/Phoenix | 2026-03-08 08:00 | 2026-03-08T15:00Z | no DST |

Also covered: `toLocal` round-trips for 10k random instants × 6 zones (property test with a seeded PRNG), `isInDailyWindow` midnight-spanning (22:00–08:00: 23:59 ✓, 07:59 ✓, 08:00 ✗, 21:59 ✗; plus non-spanning 13:00–14:00), `safeTimeZone("Mars/Base")` → default, `formatForChat` ("today 11:59pm", "tmrw 9am", "Thu 11:59pm", all-day "Thu Oct 15", no leading zero, lowercase).

**`time/rrule-lite.test.ts`**: weekly MO,WE across the Nov 1 transition keeps 09:00 local (13:00Z→14:00Z). Daily at 02:30 on Mar 8 fires at 03:30 EDT, then 02:30 resumes. Monthly BYMONTHDAY=31 skips Nov/Feb. INTERVAL=2 weekly. COUNT exhaustion → null. UNTIL inclusive. Floating evaluation follows a tz change (same wall time, new zone). Serialize/parse round-trip. Unsupported (`BYSETPOS`, `FREQ=HOURLY`) throws.

**`proactive/schedule.test.ts`**:
- `nextBriefingAt`: now 07:55 → today 08:00. Now 08:01 → tomorrow. Across both DST transitions. `briefing_time` in the quiet window → clamped to quiet end. Invalid tz → default.
- `prepRunAt`: 10–20 min before, deterministic per userId, never < now.
- `placeNudge` cases from §2.6: 01:00 due → 21:45 previous evening. 09:00 due → 08:00. 08:20 due → null. Normal afternoon → unchanged.
- `classifyDueChange`: ≤7 d → alert. Earlier move or ≤48 h → urgent. >7 d → briefing. Δ<5 min → ignore. Past → ignore. Done → ignore.
- `briefingDeferral`: 11:59 → regenerate. 12:00 → catchup. 18:00 → skip. Next day → skip.
- `lateFirePolicy` matrix.

**`briefing/snapshot.test.ts`**: items stored as UTC render as **local** (the V1 bug regression: 03:59Z Oct 13 = "Mon 11:59pm" NY, never "Tue 3:59am"). Load thresholds 0/1→light, 2/3→busy, 4+→heavy. Exam touchpoints by **local** day (an all-day exam at 23:59:59Z isn't off by one). Monday adds the week grouping. Suggestion picks the largest gap ≥60 min before the hardest item's due and returns null when the day is full. Untrusted titles containing `</untrusted_data>` are escaped. `snapshotHash` is stable under key order and changes on a due move. `isEmptySnapshot`.

**`briefing/template.test.ts`**: 1–3 bubbles, no URLs, mentions every due-today item when ≤5, otherwise "+N more".

**`reminders/render.test.ts`**: nudge coalescing (3 items → 1–2 bubbles), register variants, `stripUrls` keeps only the app origin, alert text "moved Thu 11:59pm → Fri 5pm".

**`reminders/create-validation.test.ts`** (pure part of the service extracted as `resolveWhen(input, tz, now, anchor?)`): `in`, `at` in a gap (adjusted), past `at` → error text, ISO-with-offset accepted, `before_item` already passed → error, recurring with both until+count → error.

**Guard interaction tests** (pure, with V2-03's `nextAllowedProactiveAt` once it lands, a local stub before): requested reminder at 23:30 → fires at 23:30. T-3h nudge at 06:00 → placed 08:00. Due-change alert at 23:00, non-urgent, notAfter next briefing → expires → briefing note path chosen.

### DB smoke (`tests/smoke/v2-06.smoke.test.ts`, run with `SMOKE=1 npx jest tests/smoke`, against the real project, throwaway rows deleted in `afterAll`)

1. Insert a throwaway user (tz `America/New_York`) and two timeline items (due in 2 h and in 10 days).
2. `createReminder` for each `when` variant → `reminders` rows with the right `kind/due_at` and matching `jobs` rows (`dedupe_key reminder:{id}`, `run_at = due_at`).
3. `handleTimelineChanges` moving item 1 by +1 day → anchored `due_at` and `jobs.run_at` both moved, an alert was delivered via the dev channel (or a stub `deliver` recording calls), and a replay is a no-op (`duplicate`).
4. Moving item 2 (10 days out) → one `briefing_notes` row, no alert.
5. `status_changed → done` → auto nudges `cancelled`, jobs gone.
6. `scheduleNextBriefing` → `users.next_briefing_at` and one pending `briefing_prepare` job. Calling it twice leaves one pending job.
7. `prepareBriefing` with `runModel` real (or skipped when `ANTHROPIC_API_KEY` is absent → template) → `briefings` row `ready`, `briefing_send` job present. A second `prepareBriefing` with the same date is a no-op.
8. `reconcileUser` after manually deleting a reminder's job → the job is recreated.
9. Cleanup: delete the user (cascades) and assert no rows remain for that id.

### Dev-channel E2E (manual script, documented in the task; needs V2-03 dev provider + V2-04 loop)

1. `npm run dev`, dev channel on. Text "remind me in 2 minutes to drink water" → tool call → within ~2 min + 15 s the dev outbox shows the reminder text.
2. "what reminders do I have" → `list_reminders`. "cancel it" → `cancel_reminder`.
3. Seed a Canvas item due in 3 h 2 min → `ensureAutoNudges` → nudge arrives ~2 min later. Reply "done" → `mark_done` → a second seeded nudge is cancelled.
4. Set `briefing_time` to now+16 min via "send my briefing at HH:MM" → `briefing_prepare` runs ~now+1..6 min, `briefing_send` delivers at HH:MM ± 15 s with a `/m?k=week&n=…#t=…` link that redeems.
5. Set `channels.paused_until = now+5h` → the briefing defers. Verify the regeneration/catch-up/skip path by faking `until` (dev-only `ctx.now` override).

---

## 11. Ordered implementation tasks (one sub-agent each)

Each task: `npx tsc --noEmit`, `npx eslint <touched files>`, `npm test` green. No commits, no `npm install`, no migrations.

**T1 — Pure time library.** Files: `src/shared/time/tz.ts`, `src/shared/time/rrule-lite.ts`, `tests/unit/time/*`.
*Accept:* all §10 tz vectors + rrule cases pass. Zero imports outside `src/shared`. No `any`. `formatForChat` output matches the examples.

**T2 — Pure scheduling policy.** Files: `src/server/proactive/schedule.ts`, `tests/unit/proactive/schedule.test.ts`. Depends on T1.
*Accept:* every §10 schedule case passes. Functions are pure (inject `now`). Includes a local `nextAllowedProactiveAt` shim behind one import, to be replaced by V2-03's export (TODO noted).

**T3 — Briefing snapshot + prompt + template (pure).** Files: `src/server/briefing/{snapshot,prompt,template}.ts`, `tests/unit/briefing/*`. Depends on T1.
*Accept:* V1-bug regression test (local times) passes. Template never emits URLs. The prompt has the JSON contract plus 5 few-shots. Untrusted wrapping is escaped.

**T4 — Reminders service + render + agent tools.** Files: `src/server/reminders/{service,render}.ts`, `src/server/proactive/settings.ts`, `src/server/agent/tools/{create-reminder,list-reminders,cancel-reminder,update-notification-settings}.ts` (+4 registry lines), `tests/unit/reminders/*`. Depends on T1, T2, V2-03 `enqueueJob/cancelJobByDedupeKey`, V2-04 `defineTool`.
*Accept:* zod shapes exactly as §9. Ownership checks on every id. `resolveWhen` unit-tested. `reminders`↔`jobs` written together (job first, then row update with `job_id`). Limits enforced. Smoke steps 2 and 8 pass.

**T5 — Reminder firing + nudges.** Files: `src/server/reminders/fire.ts`, `src/server/jobs/kinds/reminder-fire.ts` (+1 registry line). Depends on T4, V2-03 `deliver`.
*Accept:* conditional claim. Early-job reschedule. Anchor done/null → cancel. Auto-nudge coalescing (±30 min). Recurring next occurrence enqueued. Late policy honored. `deliver` flags per §2.6. `idempotencyKey = reminder:{id}:{dueAtIso}`.

**T6 — Briefing scheduler + prepare/send.** Files: `src/server/briefing/{scheduler,load,generate,run,notes}.ts`, `src/server/jobs/kinds/{briefing-prepare,briefing-send}.ts` (+2 registry lines). Optional: `link-policy.ts` `digest` purpose (only if the orchestrator approves §13 Q1). Depends on T2, T3, T4 (`ensureAutoNudges`), V2-03 `deliver`, V2-05 read helpers.
*Accept:* chain scheduled before generation. `(user_id, local_date)` idempotency. Freshness-hash regeneration. Deferral matrix (§2.6). Connect-Canvas nudge ≤3 lifetime (days 1, 3, 7 after signup; counted from `briefings.kind='connect_nudge' and status='sent'`). Empty-day rule (§13 Q4). Template fallback after 2 LLM failures. `llm_cost_usd` stored. Smoke steps 6–7 pass.

**T7 — Timeline change consumer.** Files: `src/server/alerts/timeline-changes.ts`, `src/server/jobs/kinds/timeline-changes.ts` (+1 registry line). Depends on T4, T5 (render), V2-05 change contract.
*Accept:* §2.8 rules. `initial` batch → no alerts, nudges ensured only. >5 immediate → single summary. Replay idempotent. Smoke steps 3–5 pass.

**T8 — Reconcile, cron route, keepalive.** Files: `src/server/proactive/reconcile.ts`, `src/app/api/cron/daily/route.ts`, `vercel.json` (merge), optional `.github/workflows/keepalive.yml`. Depends on T4, T6.
*Accept:* 401 without the bearer token (timing-safe). Heartbeat row upserted via PostgREST. Reconcile fixes a missing briefing job and a missing reminder job. Total runtime is bounded. Works on `next dev` via `curl` with the header.

**T9 — Smoke + E2E harness.** Files: `tests/smoke/v2-06.smoke.test.ts`, short "how to run" notes inside the test file header. Depends on T4–T8.
*Accept:* all smoke steps pass against the project, and zero rows remain afterward.

Parallelism: T1 → {T2, T3} → T4 → {T5, T6, T7} → T8 → T9. T3 can run alongside T2.

---

## 12. Verify when creds arrive

1. **Supabase keepalive:** after deploy, `system_heartbeat` updates daily. Confirm with Supabase support/dashboard whether pg_cron activity alone counts (docs are silent). If the warning email ever arrives, enable the GitHub Actions backup.
2. **Vercel cron on Hobby:** deploys with `0 10 * * *` (no "Hobby accounts are limited to daily cron jobs" error). The invocation shows the `Authorization` header, and it fires within the 10:00–10:59 UTC window.
3. **pg_cron 15 s tick (V2-03) + dispatch latency:** a reminder `in 1 minute` fires within ≤15 s of `due_at` (measure p95 over 20 fires).
4. **Sendblue sandbox:** proactive (business-initiated) messages are delivered to sandbox contacts outside a recent user-initiated window. Check whether sandbox enforces any 24 h window or outbound ratio that would block briefings/reminders **[verify]**.
5. **Haiku 5.5 briefing:** real token counts (in/out/thinking) on the `briefing` route; no `max_tokens` truncation on Monday views; cost ≤$0.002.
6. **Node runtime:** `process.version` in a Vercel function = 24.x. Confirm `Intl.supportedValuesOf('timeZone')` includes the beta users' zones and `formatToParts` gives `hourCycle h23` "00" not "24" at midnight (guard in code anyway).
7. **Magic-link TTL in practice:** whether friends tap briefing links within 15 min. Decide Q1 with data.
8. **Gmail `email_items` shape** from V2-07 (importance values, `alerted_at`).

---

## 13. Open questions (with recommended defaults)

| # | Question | Recommended default |
|---|---|---|
| Q1 | Briefing `/week` link: the `view` purpose TTL is 15 min, and briefings get read hours later. | Add a `digest` purpose: TTL **12 h**, scope `view`, single-use, fragment token (preview-safe). Users with an existing 14-day session are unaffected either way. Small edit to V2-02's `link-policy.ts`. |
| Q2 | Do user-set reminders respect quiet hours? | **No.** The user asked for that time (`requested:true`). They do respect pause and opt-out. The agent may push back on 2–6am times via persona ("u sure? that's 3am lol"). |
| Q3 | Item marked done → also cancel the user's own anchored reminders? | **Yes**, and the agent mentions it ("cancelled your 2h reminder too"). |
| Q4 | Empty days. | Weekdays: a 1-bubble check-in **at most 2 empty days in a row**, then silent until there's content or it's Monday. Weekends: skip when empty. Monday: always send (week view). |
| Q5 | Users with nothing connected. | Connect-Canvas nudge in place of the briefing on days 1, 3, 7 after signup (**max 3 lifetime**), with a `setup` link. If Google is connected but not Canvas, send a normal briefing from calendar/email and add a one-line Canvas hint at most 3 times. |
| Q6 | Keepalive redundancy. | Vercel daily cron (primary) **plus** the GitHub Actions 12-hourly curl if the repo is private (no 60-day auto-disable). Skip the GH workflow if the repo is public. |
| Q7 | Default nudge offset(s). | `{180}` (T-3h) only. T-24h lives in the briefing. User range 15 min–48 h, ≤3 offsets. |
| Q8 | Daily cap accounting. | Count briefing + non-urgent alerts + connect nudges. Urgent T-3h nudges and requested reminders bypass the cap (V2-03 confirms). |
| Q9 | Absolute reminders when the user changes timezone. | Keep the **instant** (like a calendar event). Recurring reminders follow the new local time (floating). |
| Q10 | Briefing pre-generation even at 4 users. | Keep it (spec). It costs nothing extra and makes delivery exact plus gives a retry window. |
| Q11 | Retention of `briefings.plan` (contains bodies). | Purge `plan` after 180 days in the daily reconcile (matches message retention). |
| Q12 | Exam countdown touchpoints (V1: T-7/5/3/1/0). | Keep in the briefing only (no extra proactive sends). |
