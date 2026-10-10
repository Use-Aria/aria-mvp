import "server-only";
// OWNER: 2.6

/**
 * Reminders service (master plan §1.14 = V2-06 §7 `service.ts`; §2.2–2.4, §2.9).
 *
 * One mechanism for user reminders and automatic deadline nudges:
 * - `reminders` is the source of truth; `reminders.due_at` is always the NEXT fire instant.
 * - each scheduled row has one pending `reminder_fire` job (dedupe `reminder:<id>`, mode replace)
 *   whose `run_at` is a cache of `due_at`. Edits and cancels are plain SQL on the row plus a job
 *   replace/cancel; the fire handler re-validates against the row, so a stale job is harmless.
 * - kinds: `absolute` (fixed instant; keeps it across timezone changes), `anchored` (timeline item
 *   anchor − offset; re-timed when the due date moves), `recurring` (floating RRULE subset,
 *   follows the user's current zone).
 * - auto nudges are `origin='auto'` anchored rows, created lazily only for items due ≤36h
 *   (unique on `(anchor_item_id, offset_minutes)`), placed around quiet hours by `placeNudge`.
 *
 * Input note: the service takes RESOLVED ids. The `create_reminder` tool resolves its `t_` alias
 * (`when.item`) to `itemId` before calling `createReminder` (master plan C12).
 */
import { db } from "@/server/db";
import { appOrigin } from "@/server/env";
import { cancelJobs, enqueueJob } from "@/server/jobs/enqueue";
import { loadUserSchedule, type UserSchedule } from "@/server/proactive/settings";
import { anchoredFireAt, placeNudge } from "@/server/proactive/schedule";
import { stripUrls } from "@/server/reminders/render";
import {
  describeRecurrence,
  nextOccurrence,
  parseRRuleString,
  toRRuleString,
  validateRecurrence,
  type RecurrenceSpec,
} from "@/shared/time/rrule-lite";
import {
  formatForTool,
  parseLocalDate,
  parseLocalDateTime,
  safeTimeZone,
  startOfLocalDay,
  zonedToUtc,
  type Weekday,
} from "@/shared/time/tz";

/** When a reminder fires (tool input with the `t_` alias resolved to a timeline item id). */
export type ReminderWhen =
  | { type: "in"; minutes: number }
  /** local wall-clock "YYYY-MM-DDTHH:MM" in the user's timezone */
  | { type: "at"; local: string }
  | { type: "before_item"; itemId: string; minutesBefore: number }
  | {
      type: "recurring";
      firstLocal: string;
      freq: "daily" | "weekly" | "monthly";
      interval: number;
      byDay?: Weekday[];
      byMonthDay?: number;
      /** local "YYYY-MM-DD", inclusive */
      until?: string;
      count?: number;
    };
export interface CreateReminderInput {
  /** exact text Aria sends at fire time */
  text: string;
  when: ReminderWhen;
}
export type CreateReminderResult =
  | { ok: true; reminderId: string; firesAtLocal: string; recurrence?: string; adjusted?: "gap_shifted" | "overlap_earlier" }
  /** model-readable reason (past time, unknown item, too many…) */
  | { ok: false; error: string };

/** One reminder as listed to the agent (the tool mints `r_` / `t_` aliases from the ids). */
export interface ReminderView {
  id: string;
  text: string;
  kind: "absolute" | "anchored" | "recurring";
  origin: "user" | "auto";
  /** next fire time, or null when none is scheduled */
  nextAt: Date | null;
  anchor?: { itemId: string; title: string; course: string | null };
  /** e.g. "every Mon & Wed at 9am" */
  recurrence?: string;
}

/** What `resolveWhen` needs to know about an anchor item (owner-checked by the caller). */
export interface AnchorInfo {
  itemId: string;
  /** due_at ?? starts_at */
  anchorAt: Date | null;
  status: string;
  removed: boolean;
}

/** A validated fire rule. */
export type ResolvedWhen =
  | { ok: true; kind: "absolute"; dueAt: Date; adjusted?: "gap_shifted" | "overlap_earlier" }
  | { ok: true; kind: "anchored"; dueAt: Date; anchorItemId: string; offsetMinutes: number }
  | { ok: true; kind: "recurring"; dueAt: Date; spec: RecurrenceSpec; rrule: string; recurrence: string }
  | { ok: false; error: string };

type ReminderKind = "absolute" | "anchored" | "recurring";
type ReminderOrigin = "user" | "auto";

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;
/** Max scheduled user reminders per user (V2-06 §2.9 abuse limits). */
export const MAX_SCHEDULED_USER_REMINDERS = 50;
/** Max user reminders created per local day. */
export const MAX_CREATED_PER_DAY = 20;
/** Auto nudges are only materialized for items due within this horizon. */
export const AUTO_NUDGE_HORIZON_MS = 36 * HOUR_MS;
/** "at"/"in" reminders must be at least this far out. */
const MIN_LEAD_MS = 30_000;
/** Anchored reminders must fire at least this far out. */
const MIN_ANCHOR_LEAD_MS = 60_000;
/** Furthest a reminder may be scheduled. */
const MAX_AHEAD_MS = 366 * DAY_MS;
/** Reminder text cap (chars). */
const TEXT_MAX = 300;
/** Item kinds that get automatic deadline nudges. */
const NUDGE_KINDS = ["assignment", "exam"] as const;
const UNIQUE_VIOLATION = "23505";
const OFFSET_RE = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;

/**
 * Dedupe key of a reminder's pending `reminder_fire` job.
 * @param reminderId reminders.id
 * @returns "reminder:<id>"
 */
export function reminderJobKey(reminderId: string): string {
  return `reminder:${reminderId}`;
}

// ── pure validation ─────────────────────────────────────────────────────────

/**
 * Validate a `when` and compute the first fire instant (pure; no DB).
 * - "in": now + minutes.
 * - "at": local wall time in `tz` (gap → shifted forward and reported); an ISO string WITH an
 *   offset is accepted as an instant. Must be > now + 30s and < now + 366d.
 * - "before_item": anchor − minutesBefore, item must be upcoming and the fire time > now + 60s.
 * - "recurring": RRULE subset (daily/weekly/monthly), until XOR count; first occurrence after now.
 * @param when rule (item id already resolved)
 * @param tz user zone
 * @param now clock
 * @param anchor the anchor item for "before_item" (null/undefined = not found for this user)
 * @returns the resolved rule or a model-readable error
 */
export function resolveWhen(when: ReminderWhen, tz: string, now: Date, anchor?: AnchorInfo | null): ResolvedWhen {
  const zone = safeTimeZone(tz);
  const nowMs = now.getTime();
  const inRange = (at: Date): string | null => {
    if (Number.isNaN(at.getTime())) return "that time isn't valid";
    if (at.getTime() <= nowMs + MIN_LEAD_MS) return `that time already passed (it's ${formatForTool(now, zone)} now)`;
    if (at.getTime() >= nowMs + MAX_AHEAD_MS) return "reminders can be at most a year out";
    return null;
  };

  switch (when.type) {
    case "in": {
      if (!Number.isInteger(when.minutes) || when.minutes < 1) return { ok: false, error: "minutes must be a positive whole number" };
      const dueAt = new Date(nowMs + when.minutes * MIN_MS);
      const err = dueAt.getTime() >= nowMs + MAX_AHEAD_MS ? "reminders can be at most a year out" : null;
      return err ? { ok: false, error: err } : { ok: true, kind: "absolute", dueAt };
    }
    case "at": {
      const local = parseLocalDateTime(when.local);
      let dueAt: Date;
      let adjusted: "none" | "gap_shifted" | "overlap_earlier" = "none";
      if (local) {
        const solved = zonedToUtc(local, zone);
        dueAt = solved.instant;
        adjusted = solved.adjusted;
      } else if (OFFSET_RE.test(when.local.trim()) && !Number.isNaN(Date.parse(when.local))) {
        dueAt = new Date(Date.parse(when.local));
      } else {
        return { ok: false, error: "time must look like 2026-10-13T21:00 (local, 24h)" };
      }
      const err = inRange(dueAt);
      if (err) return { ok: false, error: err };
      return adjusted === "none" ? { ok: true, kind: "absolute", dueAt } : { ok: true, kind: "absolute", dueAt, adjusted };
    }
    case "before_item": {
      if (!anchor || anchor.removed) return { ok: false, error: "unknown item: use a t_ id from get_agenda/search_deadlines" };
      if (anchor.status !== "upcoming") return { ok: false, error: `that item is already marked ${anchor.status}` };
      if (!anchor.anchorAt) return { ok: false, error: "that item has no due time to anchor to" };
      if (anchor.anchorAt.getTime() <= nowMs) {
        return { ok: false, error: `that deadline already passed (it was due ${formatForTool(anchor.anchorAt, zone)})` };
      }
      const dueAt = anchoredFireAt(anchor.anchorAt, when.minutesBefore);
      if (dueAt.getTime() <= nowMs + MIN_ANCHOR_LEAD_MS) {
        return { ok: false, error: `that's already passed: it's due ${formatForTool(anchor.anchorAt, zone)}` };
      }
      return { ok: true, kind: "anchored", dueAt, anchorItemId: anchor.itemId, offsetMinutes: when.minutesBefore };
    }
    case "recurring": {
      const dtstart = parseLocalDateTime(when.firstLocal);
      if (!dtstart) return { ok: false, error: "firstLocal must look like 2026-10-13T21:00 (local, 24h)" };
      let until: RecurrenceSpec["until"];
      if (when.until !== undefined) {
        const u = parseLocalDate(when.until);
        if (!u) return { ok: false, error: "until must be a date like 2026-12-15" };
        until = u;
      }
      const spec: RecurrenceSpec = {
        dtstart,
        freq: when.freq === "daily" ? "DAILY" : when.freq === "weekly" ? "WEEKLY" : "MONTHLY",
        interval: when.interval,
        ...(when.byDay ? { byDay: when.byDay } : {}),
        ...(when.byMonthDay !== undefined ? { byMonthDay: when.byMonthDay } : {}),
        ...(when.count !== undefined ? { count: when.count } : {}),
        ...(until ? { until } : {}),
      };
      const invalid = validateRecurrence(spec);
      if (invalid) return { ok: false, error: invalid };
      const first = nextOccurrence(spec, zone, new Date(nowMs + MIN_LEAD_MS), 0);
      if (!first) return { ok: false, error: "that repeat has no future occurrences" };
      if (first.getTime() >= nowMs + MAX_AHEAD_MS) return { ok: false, error: "the first occurrence is more than a year out" };
      return { ok: true, kind: "recurring", dueAt: first, spec, rrule: toRRuleString(spec), recurrence: describeRecurrence(spec) };
    }
  }
}

// ── internals ───────────────────────────────────────────────────────────────

interface ReminderRow {
  id: string;
  user_id: string;
  body: string;
  kind: string;
  origin: string;
  status: string;
  due_at: string | null;
  anchor_item_id: string | null;
  offset_minutes: number | null;
  rrule: string | null;
  fire_count: number;
}

const ROW_COLS = "id, user_id, body, kind, origin, status, due_at, anchor_item_id, offset_minutes, rrule, fire_count";

function sameInstant(a: string | null, b: Date): boolean {
  return a !== null && new Date(a).getTime() === b.getTime();
}

/**
 * Point a reminder at `dueAt` (status scheduled) and replace its pending `reminder_fire` job.
 * Row first (the handler re-validates against it), then the job, then `job_id`.
 * @param userId owner
 * @param reminderId reminders.id
 * @param dueAt next fire instant
 * @param extra additional column updates (e.g. fire bookkeeping)
 */
export async function armReminder(
  userId: string,
  reminderId: string,
  dueAt: Date,
  extra: { fire_count?: number; last_fired_at?: string } = {},
): Promise<void> {
  const iso = dueAt.toISOString();
  const up = await db()
    .from("reminders")
    .update({ due_at: iso, status: "scheduled", updated_at: new Date().toISOString(), ...extra })
    .eq("id", reminderId)
    .eq("user_id", userId);
  if (up.error) throw new Error(`armReminder: ${up.error.message}`);
  const job = await enqueueJob({
    kind: "reminder_fire",
    userId,
    runAt: dueAt,
    payload: { reminderId, dueAt: iso },
    dedupeKey: reminderJobKey(reminderId),
    mode: "replace",
  });
  const link = await db().from("reminders").update({ job_id: job.id }).eq("id", reminderId);
  if (link.error) throw new Error(`armReminder(job_id): ${link.error.message}`);
}

/**
 * Cancel the pending fire job(s) of these reminders (running jobs are left to their handler,
 * which re-checks the row).
 * @param ids reminders.id values
 */
async function disarm(ids: readonly string[]): Promise<void> {
  await Promise.all(ids.map((id) => cancelJobs({ dedupeKey: reminderJobKey(id) })));
}

/** Set a terminal status on rows that are still scheduled (jobs cancelled first). */
async function finish(userId: string, ids: string[], status: "cancelled" | "expired" | "sent"): Promise<number> {
  if (ids.length === 0) return 0;
  await disarm(ids);
  const { data, error } = await db()
    .from("reminders")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .in("id", ids)
    .eq("status", "scheduled")
    .select("id");
  if (error) throw new Error(`reminders(${status}): ${error.message}`);
  return data?.length ?? 0;
}

async function loadAnchor(userId: string, itemId: string): Promise<AnchorInfo | null> {
  const { data, error } = await db()
    .from("timeline_items")
    .select("id, anchor_at, status, removed_at")
    .eq("id", itemId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`loadAnchor: ${error.message}`);
  if (!data) return null;
  return {
    itemId: data.id,
    anchorAt: data.anchor_at ? new Date(data.anchor_at) : null,
    status: data.status,
    removed: data.removed_at !== null,
  };
}

// ── public API ──────────────────────────────────────────────────────────────

/**
 * Validate and schedule a reminder (row + `reminder_fire` job). Text is stripped of foreign links
 * and capped at 300 chars. Limits: ≤50 scheduled user reminders, ≤20 created per local day.
 * @param userId owner
 * @param tz user timezone
 * @param input text + when (item id already resolved)
 * @param now clock
 * @returns created reminder or a model-readable error
 * @throws on DB/job errors (the row is removed again if the job can't be created)
 */
export async function createReminder(userId: string, tz: string, input: CreateReminderInput, now: Date): Promise<CreateReminderResult> {
  const zone = safeTimeZone(tz);
  const text = stripUrls(input.text, appOrigin()).slice(0, TEXT_MAX).trim();
  if (!text) return { ok: false, error: "reminder text is empty (links are removed)" };

  const anchor = input.when.type === "before_item" ? await loadAnchor(userId, input.when.itemId) : undefined;
  const resolved = resolveWhen(input.when, zone, now, anchor);
  if (!resolved.ok) return resolved;

  const [scheduled, today] = await Promise.all([
    db()
      .from("reminders")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("origin", "user")
      .eq("status", "scheduled"),
    db()
      .from("reminders")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("origin", "user")
      .gte("created_at", startOfLocalDay(now, zone).toISOString()),
  ]);
  if (scheduled.error) throw new Error(`createReminder(count): ${scheduled.error.message}`);
  if (today.error) throw new Error(`createReminder(count): ${today.error.message}`);
  if ((scheduled.count ?? 0) >= MAX_SCHEDULED_USER_REMINDERS) {
    return { ok: false, error: `too many reminders scheduled (max ${MAX_SCHEDULED_USER_REMINDERS}); cancel some first` };
  }
  if ((today.count ?? 0) >= MAX_CREATED_PER_DAY) {
    return { ok: false, error: `that's the daily limit of ${MAX_CREATED_PER_DAY} new reminders; try again tomorrow` };
  }

  const ins = await db()
    .from("reminders")
    .insert({
      user_id: userId,
      body: text,
      kind: resolved.kind,
      origin: "user",
      status: "scheduled",
      due_at: resolved.dueAt.toISOString(),
      anchor_item_id: resolved.kind === "anchored" ? resolved.anchorItemId : null,
      offset_minutes: resolved.kind === "anchored" ? resolved.offsetMinutes : null,
      rrule: resolved.kind === "recurring" ? resolved.rrule : null,
    })
    .select("id")
    .single();
  if (ins.error) throw new Error(`createReminder: ${ins.error.message}`);
  const reminderId = ins.data.id;
  try {
    await armReminder(userId, reminderId, resolved.dueAt);
  } catch (e) {
    await db().from("reminders").delete().eq("id", reminderId);
    throw e;
  }
  return {
    ok: true,
    reminderId,
    firesAtLocal: formatForTool(resolved.dueAt, zone),
    ...(resolved.kind === "recurring" ? { recurrence: resolved.recurrence } : {}),
    ...(resolved.kind === "absolute" && resolved.adjusted ? { adjusted: resolved.adjusted } : {}),
  };
}

/**
 * Scheduled reminders, soonest first.
 * @param userId owner
 * @param tz user timezone (used to describe recurrences)
 * @param opts include automatic nudges; max rows
 * @returns reminder views
 */
export async function listReminders(userId: string, tz: string, opts: { includeAuto: boolean; limit: number }): Promise<ReminderView[]> {
  void tz; // recurrence descriptions are zone-free (floating wall time)
  let q = db()
    .from("reminders")
    .select(ROW_COLS)
    .eq("user_id", userId)
    .eq("status", "scheduled")
    .order("due_at", { ascending: true, nullsFirst: false })
    .limit(Math.max(1, Math.min(opts.limit, 100)));
  if (!opts.includeAuto) q = q.eq("origin", "user");
  const { data, error } = await q;
  if (error) throw new Error(`listReminders: ${error.message}`);
  const rows: ReminderRow[] = data ?? [];
  const anchorIds = [...new Set(rows.map((r) => r.anchor_item_id).filter((x): x is string => x !== null))];
  const anchors = new Map<string, { title: string; course: string | null }>();
  if (anchorIds.length > 0) {
    const items = await db().from("timeline_items").select("id, title, course").eq("user_id", userId).in("id", anchorIds);
    if (items.error) throw new Error(`listReminders(items): ${items.error.message}`);
    for (const it of items.data ?? []) anchors.set(it.id, { title: it.title ?? "untitled", course: it.course });
  }
  return rows.map((r): ReminderView => {
    const view: ReminderView = {
      id: r.id,
      text: r.body,
      kind: r.kind as ReminderKind,
      origin: r.origin as ReminderOrigin,
      nextAt: r.due_at ? new Date(r.due_at) : null,
    };
    const a = r.anchor_item_id ? anchors.get(r.anchor_item_id) : undefined;
    if (r.anchor_item_id && a) view.anchor = { itemId: r.anchor_item_id, ...a };
    if (r.rrule) {
      try {
        view.recurrence = describeRecurrence(parseRRuleString(r.rrule));
      } catch {
        view.recurrence = "repeating";
      }
    }
    return view;
  });
}

/**
 * Cancel one reminder (job cancelled first, then status 'cancelled'). Ownership-checked.
 * Cancelling an auto nudge only affects that item (the unique row stays cancelled).
 * @param userId owner
 * @param reminderId reminders.id
 * @returns ok, or a reason
 */
export async function cancelReminder(userId: string, reminderId: string): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await db().from("reminders").select("id, status").eq("id", reminderId).eq("user_id", userId).maybeSingle();
  if (error) throw new Error(`cancelReminder: ${error.message}`);
  if (!data) return { ok: false, error: "no such reminder" };
  if (data.status !== "scheduled") return { ok: false, error: `that reminder is already ${data.status}` };
  const n = await finish(userId, [reminderId], "cancelled");
  return n === 1 ? { ok: true } : { ok: false, error: "that reminder just fired or was already cancelled" };
}

/**
 * Place auto nudges for upcoming deadlines (assignments/exams, not all-day) due ≤36h, one per
 * configured offset, around quiet hours. Idempotent: existing scheduled rows are re-placed when
 * their slot changed, rows for offsets the user no longer has are deleted, and sent/cancelled
 * rows are left alone.
 * @param userId owner
 * @param now clock
 * @param itemIds restrict to these items
 * @returns nudges newly placed or re-placed
 */
export async function ensureAutoNudges(userId: string, now: Date, itemIds?: string[]): Promise<number> {
  if (itemIds && itemIds.length === 0) return 0;
  const s = await loadUserSchedule(userId);
  if (!s || s.deleted) return 0;
  const offsets = s.settings.nudgeMinutes;

  // 1. Drop scheduled auto rows for offsets no longer configured (delete, so re-adding works).
  let staleQ = db().from("reminders").select("id, offset_minutes").eq("user_id", userId).eq("origin", "auto").eq("status", "scheduled");
  if (itemIds) staleQ = staleQ.in("anchor_item_id", itemIds);
  const staleRes = await staleQ;
  if (staleRes.error) throw new Error(`ensureAutoNudges(stale): ${staleRes.error.message}`);
  const stale = (staleRes.data ?? []).filter((r) => r.offset_minutes === null || !offsets.includes(r.offset_minutes)).map((r) => r.id);
  if (stale.length > 0) {
    await disarm(stale);
    const del = await db().from("reminders").delete().eq("user_id", userId).in("id", stale);
    if (del.error) throw new Error(`ensureAutoNudges(delete): ${del.error.message}`);
  }
  if (offsets.length === 0) return 0;

  // 2. Items due within the horizon.
  let itemQ = db()
    .from("timeline_items")
    .select("id, anchor_at, title")
    .eq("user_id", userId)
    .eq("status", "upcoming")
    .is("removed_at", null)
    .eq("all_day", false)
    .in("kind", [...NUDGE_KINDS])
    .gt("anchor_at", now.toISOString())
    .lte("anchor_at", new Date(now.getTime() + AUTO_NUDGE_HORIZON_MS).toISOString());
  if (itemIds) itemQ = itemQ.in("id", itemIds);
  const itemRes = await itemQ;
  if (itemRes.error) throw new Error(`ensureAutoNudges(items): ${itemRes.error.message}`);
  const items = (itemRes.data ?? []).filter((i): i is typeof i & { anchor_at: string } => i.anchor_at !== null);
  if (items.length === 0) return 0;

  const exRes = await db()
    .from("reminders")
    .select(ROW_COLS)
    .eq("user_id", userId)
    .eq("origin", "auto")
    .in("anchor_item_id", items.map((i) => i.id));
  if (exRes.error) throw new Error(`ensureAutoNudges(existing): ${exRes.error.message}`);
  const existing = new Map<string, ReminderRow>();
  for (const r of exRes.data ?? []) existing.set(`${r.anchor_item_id}:${r.offset_minutes}`, r);

  let placed = 0;
  for (const item of items) {
    for (const offset of offsets) {
      const at = placeNudge({ dueAt: new Date(item.anchor_at), offsetMinutes: offset, tz: s.settings.tz, quiet: s.effectiveQuiet, now });
      const ex = existing.get(`${item.id}:${offset}`);
      if (!ex) {
        if (!at) continue;
        const ins = await db()
          .from("reminders")
          .insert({
            user_id: userId,
            body: (item.title ?? "deadline").slice(0, TEXT_MAX),
            kind: "anchored",
            origin: "auto",
            status: "scheduled",
            due_at: at.toISOString(),
            anchor_item_id: item.id,
            offset_minutes: offset,
          })
          .select("id")
          .single();
        if (ins.error) {
          if (ins.error.code === UNIQUE_VIOLATION) continue; // concurrent ensure won
          throw new Error(`ensureAutoNudges(insert): ${ins.error.message}`);
        }
        await armReminder(userId, ins.data.id, at);
        placed += 1;
      } else if (ex.status === "scheduled") {
        if (!at) await finish(userId, [ex.id], "expired");
        else if (!sameInstant(ex.due_at, at)) {
          await armReminder(userId, ex.id, at);
          placed += 1;
        }
      }
    }
  }
  return placed;
}

/**
 * Re-time every anchored reminder on an item after its anchor moved (null = item gone → all
 * cancelled). User rows: anchor − offset (fire ASAP if that passed but the deadline hasn't).
 * Auto rows: re-placed around quiet hours, or expired when there's no slot. Sent/expired rows
 * whose new fire time is in the future are re-armed; cancelled rows never are. Then auto nudges
 * are ensured for the item (it may have moved into the 36h window).
 * @param userId owner
 * @param itemId timeline item
 * @param anchorAt new anchor
 * @param now clock
 */
export async function recomputeAnchored(userId: string, itemId: string, anchorAt: Date | null, now: Date): Promise<void> {
  if (!anchorAt) {
    await cancelForItem(userId, itemId, "all", "anchor_removed");
    return;
  }
  const { data, error } = await db()
    .from("reminders")
    .select(ROW_COLS)
    .eq("user_id", userId)
    .eq("anchor_item_id", itemId)
    .eq("kind", "anchored")
    .in("status", ["scheduled", "sent", "expired"]);
  if (error) throw new Error(`recomputeAnchored: ${error.message}`);
  const rows: ReminderRow[] = data ?? [];
  let schedule: UserSchedule | null = null;
  if (rows.some((r) => r.origin === "auto")) schedule = await loadUserSchedule(userId);
  const nowMs = now.getTime();

  for (const r of rows) {
    const offset = r.offset_minutes ?? 0;
    if (r.origin === "user") {
      const fire = anchoredFireAt(anchorAt, offset);
      if (fire.getTime() > nowMs + MIN_LEAD_MS) {
        if (r.status !== "scheduled" || !sameInstant(r.due_at, fire)) await armReminder(userId, r.id, fire);
      } else if (r.status === "scheduled") {
        if (anchorAt.getTime() > nowMs) await armReminder(userId, r.id, now);
        else await finish(userId, [r.id], "expired");
      }
      continue;
    }
    if (!schedule || schedule.deleted) continue;
    const at = placeNudge({ dueAt: anchorAt, offsetMinutes: offset, tz: schedule.settings.tz, quiet: schedule.effectiveQuiet, now });
    if (at && at.getTime() > nowMs) {
      if (r.status !== "scheduled" || !sameInstant(r.due_at, at)) await armReminder(userId, r.id, at);
    } else if (r.status === "scheduled") {
      await finish(userId, [r.id], "expired");
    }
  }
  await ensureAutoNudges(userId, now, [itemId]);
}

/**
 * Cancel scheduled reminders anchored on an item.
 * @param userId owner
 * @param itemId timeline item
 * @param scope auto nudges only, or all (user anchored reminders too)
 * @param reason log reason (e.g. "done", "removed")
 * @returns reminders cancelled
 */
export async function cancelForItem(userId: string, itemId: string, scope: "auto" | "all", reason: string): Promise<number> {
  let q = db()
    .from("reminders")
    .select("id")
    .eq("user_id", userId)
    .eq("anchor_item_id", itemId)
    .eq("status", "scheduled");
  if (scope === "auto") q = q.eq("origin", "auto");
  const { data, error } = await q;
  if (error) throw new Error(`cancelForItem: ${error.message}`);
  const n = await finish(userId, (data ?? []).map((r) => r.id), "cancelled");
  if (n > 0) console.info(`[reminders] cancelled ${n} anchored reminder(s): ${reason}`);
  return n;
}

/**
 * Recompute next occurrences of recurring reminders (timezone change: same local wall time in
 * the new zone). Exhausted rules end as 'sent'; unparseable ones expire.
 * @param userId owner
 * @param tz new timezone
 * @param now clock
 */
export async function recomputeRecurring(userId: string, tz: string, now: Date): Promise<void> {
  const zone = safeTimeZone(tz);
  const { data, error } = await db()
    .from("reminders")
    .select(ROW_COLS)
    .eq("user_id", userId)
    .eq("kind", "recurring")
    .eq("status", "scheduled");
  if (error) throw new Error(`recomputeRecurring: ${error.message}`);
  for (const r of (data ?? []) as ReminderRow[]) {
    let spec: RecurrenceSpec;
    try {
      spec = parseRRuleString(r.rrule ?? "");
    } catch {
      await finish(userId, [r.id], "expired");
      continue;
    }
    const next = nextOccurrence(spec, zone, now, r.fire_count);
    if (!next) await finish(userId, [r.id], "sent");
    else if (!sameInstant(r.due_at, next)) await armReminder(userId, r.id, next);
  }
}

/**
 * Repair missing/stale `reminder_fire` jobs (daily reconcile): every scheduled reminder gets a
 * pending/running job whose `run_at` and payload match `due_at`; pending jobs whose reminder is no
 * longer scheduled are cancelled.
 * @param userId owner
 * @param now clock
 * @returns jobs fixed
 */
export async function reconcileReminderJobs(userId: string, now: Date): Promise<{ fixed: number }> {
  const [remRes, jobRes] = await Promise.all([
    db().from("reminders").select("id, due_at, status").eq("user_id", userId).eq("status", "scheduled"),
    db()
      .from("jobs")
      .select("id, dedupe_key, run_at, payload, status")
      .eq("user_id", userId)
      .eq("kind", "reminder_fire")
      .in("status", ["pending", "running"]),
  ]);
  if (remRes.error) throw new Error(`reconcileReminderJobs: ${remRes.error.message}`);
  if (jobRes.error) throw new Error(`reconcileReminderJobs(jobs): ${jobRes.error.message}`);
  const jobs = new Map<string, { run_at: string; payload: unknown; status: string }>();
  for (const j of jobRes.data ?? []) if (j.dedupe_key) jobs.set(j.dedupe_key, j);

  let fixed = 0;
  const live = new Set<string>();
  for (const r of remRes.data ?? []) {
    const key = reminderJobKey(r.id);
    live.add(key);
    if (!r.due_at) {
      fixed += await finish(userId, [r.id], "expired");
      continue;
    }
    const dueAt = new Date(r.due_at);
    const job = jobs.get(key);
    if (job?.status === "running") continue;
    const payloadDue = (job?.payload as { dueAt?: unknown } | undefined)?.dueAt;
    const matches =
      job !== undefined &&
      sameInstant(job.run_at, dueAt) &&
      typeof payloadDue === "string" &&
      new Date(payloadDue).getTime() === dueAt.getTime();
    if (!matches) {
      await armReminder(userId, r.id, dueAt);
      fixed += 1;
    }
  }
  for (const [key, job] of jobs) {
    if (job.status === "pending" && !live.has(key)) fixed += await cancelJobs({ dedupeKey: key, userId });
  }
  void now;
  return { fixed };
}
