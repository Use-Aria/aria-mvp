import "server-only";
// OWNER: 2.6

/**
 * `reminder_fire` handler body (V2-06 §7 `reminders/fire.ts`, §2.4, §2.6, §2.9; T5).
 *
 * The row is the source of truth; the job only says "look at reminder X around `dueAt`":
 * 1. not scheduled any more → no-op; row moved later (> now + 20s) → re-arm at the row's time.
 * 2. anchored on a removed/finished item → cancelled (user reminders leave a briefing note).
 * 3. late-fire policy (outage backlog): fire, fire with "(from earlier)", expire, or skip ahead.
 * 4. deliver (§1.1 flags): user reminders `priority:"requested"` (bypass quiet hours + cap),
 *    auto nudges `priority:"urgent"` with `expiresAt = deadline − 15 min`; auto nudges due within
 *    the next 30 min are coalesced into one message, and other auto nudges on the *same* item in
 *    that window are settled with it without a second line (5.5 #9). User reminders use
 *    `dedupeKey = reminder:<id>:<dueAtIso>`; auto nudges use `nudge:<itemId>:<dueAtIso>`, so a retry
 *    after a crash never double-sends and two same-item nudges at one instant (two offsets placed
 *    on the same slot, fired concurrently) send once.
 * 5. bookkeeping with a conditional update (`status='scheduled' AND due_at=<expected>`); recurring
 *    reminders are re-armed at their next occurrence.
 */
import { deliver, type DeliverOptions, type DeliverResult } from "@/server/channels/deliver";
import { textPlan } from "@/server/channels/plan";
import { db } from "@/server/db";
import { addBriefingNote } from "@/server/briefing/notes";
import { loadUserSchedule } from "@/server/proactive/settings";
import { lateFirePolicy } from "@/server/proactive/schedule";
import { renderNudge, renderUserReminder, type NudgeItem } from "@/server/reminders/render";
import { armReminder, reminderJobKey } from "@/server/reminders/service";
import { cancelJobs } from "@/server/jobs/enqueue";
import { nextOccurrence, parseRRuleString, type RecurrenceSpec } from "@/shared/time/rrule-lite";
import { formatLocalDate, localDateOf } from "@/shared/time/tz";

/** What one fire attempt did (for logs and the smoke test). */
export type FireResult =
  | { outcome: "stale" | "rescheduled" | "cancelled" | "expired" | "skipped" }
  | {
      outcome: "delivered";
      delivery: DeliverResult["status"];
      /** other items' nudges folded into this message */
      coalesced: number;
      /** further nudges on an already-listed item settled without a line of their own */
      covered: number;
      next: Date | null;
    };

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
/** A job this early relative to the row re-arms instead of firing. */
const EARLY_TOLERANCE_MS = 20_000;
/** Auto nudges due within this window are folded into the firing one. */
const COALESCE_WINDOW_MS = 30 * MIN_MS;
/** Nudges stop being useful this close to the deadline. */
const NUDGE_EXPIRES_BEFORE_DUE_MS = 15 * MIN_MS;
/** A one-off user reminder that can't go out within this long is dropped by deliver. */
const USER_EXPIRY_MS = 12 * HOUR_MS;

interface Row {
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

interface Item {
  id: string;
  title: string | null;
  course: string | null;
  anchor_at: string | null;
  status: string;
  removed_at: string | null;
}

const COLS = "id, user_id, body, kind, origin, status, due_at, anchor_item_id, offset_minutes, rrule, fire_count";

function asKind(k: string): "absolute" | "anchored" | "recurring" {
  return k === "anchored" || k === "recurring" ? k : "absolute";
}

/** Conditional terminal update; false when the row changed under us. */
async function settle(row: Row, status: "sent" | "cancelled" | "expired", now: Date, fired: boolean): Promise<boolean> {
  let q = db()
    .from("reminders")
    .update({
      status,
      updated_at: now.toISOString(),
      ...(fired ? { last_fired_at: now.toISOString(), fire_count: row.fire_count + 1 } : {}),
    })
    .eq("id", row.id)
    .eq("status", "scheduled");
  if (row.due_at) q = q.eq("due_at", row.due_at);
  const { data, error } = await q.select("id");
  if (error) throw new Error(`fireReminder(settle): ${error.message}`);
  return (data?.length ?? 0) > 0;
}

/** Recurring: move to the next occurrence after `after` (or finish as 'sent'). */
async function advance(row: Row, spec: RecurrenceSpec, tz: string, after: Date, now: Date, fired: boolean): Promise<Date | null> {
  const count = row.fire_count + (fired ? 1 : 0);
  const next = nextOccurrence(spec, tz, after, count);
  if (!next) {
    await settle(row, "sent", now, fired);
    return null;
  }
  await armReminder(row.user_id, row.id, next, fired ? { fire_count: count, last_fired_at: now.toISOString() } : {});
  return next;
}

async function loadItems(userId: string, ids: string[]): Promise<Map<string, Item>> {
  const out = new Map<string, Item>();
  if (ids.length === 0) return out;
  const { data, error } = await db()
    .from("timeline_items")
    .select("id, title, course, anchor_at, status, removed_at")
    .eq("user_id", userId)
    .in("id", ids);
  if (error) throw new Error(`fireReminder(items): ${error.message}`);
  for (const it of data ?? []) out.set(it.id, it);
  return out;
}

function liveAnchor(item: Item | undefined): item is Item & { anchor_at: string } {
  return item !== undefined && item.removed_at === null && item.status === "upcoming" && item.anchor_at !== null;
}

/**
 * `deliver` dedupe key of one nudge/reminder occurrence. Auto nudges key on the anchor item, so
 * sibling nudges for the same item at the same instant share one key (a concurrent second fire is
 * `suppressed:"duplicate"`); user reminders key on their own row, so they are never folded into a
 * nudge. Both are stable across retries of the same row.
 * @param row reminder id, origin and anchor item
 * @param dueAt the occurrence's due instant
 * @returns the proactive dedupe key
 */
export function fireDedupeKey(
  row: { id: string; origin: string; anchor_item_id: string | null },
  dueAt: Date,
): string {
  if (row.origin === "auto" && row.anchor_item_id) return `nudge:${row.anchor_item_id}:${dueAt.toISOString()}`;
  return `${reminderJobKey(row.id)}:${dueAt.toISOString()}`;
}

/**
 * Split the scheduled auto nudges inside the coalesce window around a firing auto nudge.
 * `coalesce`: one per other live item (each adds a line to the message). `covered`: further
 * nudges on an item the message already lists (the firing row's own item, or a duplicate of a
 * coalesced one) — settled with it, no second line. Dead anchors are left to their own job.
 * Pure; callers pass only `origin='auto'` rows.
 * @param anchorId the firing row's anchor item id
 * @param candidates other scheduled auto nudges due within the window
 * @param isLive whether an item id is a live (upcoming, not removed, dated) anchor
 * @returns rows to coalesce and rows already covered
 */
export function partitionNudgeSiblings<T extends { anchor_item_id: string | null }>(
  anchorId: string,
  candidates: T[],
  isLive: (itemId: string) => boolean,
): { coalesce: T[]; covered: T[] } {
  const seen = new Set<string>([anchorId]);
  const coalesce: T[] = [];
  const covered: T[] = [];
  for (const c of candidates) {
    const id = c.anchor_item_id;
    if (!id || !isLive(id)) continue;
    if (seen.has(id)) {
      covered.push(c);
      continue;
    }
    seen.add(id);
    coalesce.push(c);
  }
  return { coalesce, covered };
}

/**
 * Fire one reminder occurrence (the `reminder_fire` job body). Idempotent and safe against stale,
 * duplicate or early jobs.
 * @param payload job payload: reminder id + the due instant the job was armed for
 * @param now clock (the job context's `now`)
 * @returns what happened
 * @throws when delivery fails (the job retries) or on DB errors
 */
export async function fireReminder(payload: { reminderId: string; dueAt: string }, now: Date): Promise<FireResult> {
  const { data: found, error } = await db().from("reminders").select(COLS).eq("id", payload.reminderId).maybeSingle();
  if (error) throw new Error(`fireReminder: ${error.message}`);
  const row: Row | null = found;
  if (!row || row.status !== "scheduled" || !row.due_at) return { outcome: "stale" };

  const dueAt = new Date(row.due_at);
  if (dueAt.getTime() > now.getTime() + EARLY_TOLERANCE_MS) {
    await armReminder(row.user_id, row.id, dueAt);
    return { outcome: "rescheduled" };
  }

  const schedule = await loadUserSchedule(row.user_id);
  if (!schedule || schedule.deleted) {
    await settle(row, "cancelled", now, false);
    return { outcome: "cancelled" };
  }
  const tz = schedule.settings.tz;
  const kind = asKind(row.kind);
  const origin = row.origin === "auto" ? "auto" : "user";

  // Anchor checks (belt and braces: the timeline change handler cancels these earlier).
  let anchor: (Item & { anchor_at: string }) | null = null;
  if (kind === "anchored") {
    const items = await loadItems(row.user_id, row.anchor_item_id ? [row.anchor_item_id] : []);
    const item = row.anchor_item_id ? items.get(row.anchor_item_id) : undefined;
    if (!liveAnchor(item)) {
      const settled = await settle(row, "cancelled", now, false);
      if (settled && origin === "user" && (!item || item.removed_at !== null || item.anchor_at === null)) {
        await addBriefingNote(
          row.user_id,
          "reminder_cancelled",
          { text: row.body, reason: "item_removed" },
          { dedupeKey: `reminder_cancelled:${row.id}` },
        );
      }
      return { outcome: "cancelled" };
    }
    anchor = item;
  }

  let spec: RecurrenceSpec | null = null;
  if (kind === "recurring") {
    try {
      spec = parseRRuleString(row.rrule ?? "");
    } catch {
      await settle(row, "expired", now, false);
      return { outcome: "expired" };
    }
  }

  const policy = lateFirePolicy(dueAt, now, kind, origin);
  if (policy === "expire") {
    const settled = await settle(row, "expired", now, false);
    if (settled && origin === "user") {
      await addBriefingNote(
        row.user_id,
        "reminder_expired",
        { text: row.body, dueAt: dueAt.toISOString() },
        { dedupeKey: `reminder_expired:${row.id}:${row.due_at}` },
      );
    }
    return { outcome: "expired" };
  }
  if (policy === "skip_to_next" && spec) {
    await advance(row, spec, tz, now, now, false);
    return { outcome: "skipped" };
  }

  // ── build the message ──────────────────────────────────────────────────
  const dedupeKey = fireDedupeKey(row, dueAt);
  let texts: string[];
  let opts: DeliverOptions;
  const siblings: Row[] = [];
  const covered: Row[] = [];
  if (origin === "user") {
    const lateMinutes = Math.max(0, Math.floor((now.getTime() - dueAt.getTime()) / MIN_MS));
    texts = [renderUserReminder(row.body, { lateMinutes })];
    const nextAfter = spec ? nextOccurrence(spec, tz, dueAt, row.fire_count + 1) : null;
    const hardStop = dueAt.getTime() + USER_EXPIRY_MS;
    opts = {
      proactive: true,
      reason: "reminder",
      dedupeKey,
      priority: "requested",
      expiresAt: new Date(nextAfter ? Math.min(hardStop, nextAfter.getTime()) : hardStop),
    };
  } else {
    // Coalesce other auto nudges for this user firing within the next 30 minutes.
    const sib = await db()
      .from("reminders")
      .select(COLS)
      .eq("user_id", row.user_id)
      .eq("origin", "auto")
      .eq("status", "scheduled")
      .neq("id", row.id)
      .lte("due_at", new Date(now.getTime() + COALESCE_WINDOW_MS).toISOString());
    if (sib.error) throw new Error(`fireReminder(siblings): ${sib.error.message}`);
    const candidates: Row[] = sib.data ?? [];
    const items = await loadItems(
      row.user_id,
      candidates.map((c) => c.anchor_item_id).filter((x): x is string => x !== null),
    );
    // Same-item nudges in the window ride along without a second line (5.5 #9); dead anchors are
    // handled by their own job.
    const split = partitionNudgeSiblings(anchor?.id ?? "", candidates, (id) => liveAnchor(items.get(id)));
    siblings.push(...split.coalesce);
    covered.push(...split.covered);
    const list: NudgeItem[] = [];
    let earliestDue = Number.POSITIVE_INFINITY;
    for (const it of [anchor, ...siblings.map((c) => (c.anchor_item_id ? items.get(c.anchor_item_id) : undefined))]) {
      if (!it?.anchor_at) continue;
      const due = new Date(it.anchor_at);
      earliestDue = Math.min(earliestDue, due.getTime());
      list.push({ title: it.title ?? "your deadline", course: it.course, dueAt: due });
    }
    const seed = `${row.id}:${formatLocalDate(localDateOf(now, tz))}`;
    texts = renderNudge(list, tz, now, schedule.settings.register, seed);
    opts = {
      proactive: true,
      reason: "deadline_nudge",
      dedupeKey,
      priority: "urgent",
      expiresAt: new Date(earliestDue - NUDGE_EXPIRES_BEFORE_DUE_MS),
    };
  }

  const result = await deliver(row.user_id, textPlan(texts), opts);
  if (result.status === "failed") throw new Error(`fireReminder: delivery failed: ${result.error}`);

  const delivered =
    result.status === "sent" ||
    result.status === "queued" ||
    result.status === "deferred" ||
    (result.status === "suppressed" && result.reason === "duplicate");

  // Siblings (and same-item duplicates) ride along with this message (or expire with it).
  if (siblings.length + covered.length > 0) {
    const ids = [...siblings, ...covered].map((c) => c.id);
    await Promise.all(ids.map((id) => cancelJobs({ dedupeKey: reminderJobKey(id) })));
    const up = await db()
      .from("reminders")
      .update({
        status: delivered ? "sent" : "expired",
        updated_at: now.toISOString(),
        ...(delivered ? { last_fired_at: now.toISOString() } : {}),
      })
      .in("id", ids)
      .eq("status", "scheduled");
    if (up.error) throw new Error(`fireReminder(siblings): ${up.error.message}`);
  }

  let next: Date | null = null;
  if (spec) {
    next = await advance(row, spec, tz, new Date(Math.max(now.getTime(), dueAt.getTime())), now, delivered);
  } else {
    await settle(row, delivered ? "sent" : "expired", now, delivered);
    if (!delivered && origin === "user" && result.status === "suppressed" && result.reason === "expired") {
      await addBriefingNote(
        row.user_id,
        "reminder_expired",
        { text: row.body, dueAt: dueAt.toISOString() },
        { dedupeKey: `reminder_expired:${row.id}:${row.due_at}` },
      );
    }
  }
  return { outcome: "delivered", delivery: result.status, coalesced: siblings.length, covered: covered.length, next };
}
