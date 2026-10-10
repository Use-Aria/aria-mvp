import "server-only";
// OWNER: 4.1

/**
 * Timeline change handler (master plan §1.14; V2-06 §2.8). Called by the `timeline_changes` job
 * and synchronously by timeline status changes (lazy import in `timeline/hooks.ts`).
 *
 * Per change:
 * - `status_changed` → done/dismissed: cancel auto nudges AND the user's anchored reminders (§13 Q3).
 * - `removed` → cancel anchored reminders (a `reminder_cancelled` note when the user had one);
 *   an `item_removed` note when it was due ≤7 days (hint "briefing"); >5 removals in one batch
 *   collapse into ONE note, so a deferred mass removal (`removal_deferred`, arriving a sync late)
 *   never floods the briefing.
 * - `due_changed` (an extension arrives with `rekeyed: true`; same path) → re-time anchored
 *   reminders + nudges, then `classifyDueChange`: ≤7d → immediate alert (bundled per batch,
 *   urgent when ≤48h or moved earlier), later → `due_changed` briefing note.
 * - `created` → ensure auto nudges; due ≤24h (hint "immediate") → a "new on Canvas" line in the alert.
 * The producer's `deliveryHint` "none" (initial imports, non-Canvas sources) never alerts or
 * notes; `initial: true` batches only place nudges.
 *
 * Alerts: one bundled message per batch, `deliver(…, {deferMode:"return", expiresAt: next
 * briefing})`. Sent/queued → per-item keys claimed in `proactive_dedupe`, so a replayed or
 * overlapping batch never re-alerts an item. Deferred (quiet hours/pause; D8: urgent alerts don't
 * break quiet hours) → re-delivered persisted and linkless if it can still land before the next
 * briefing; otherwise (or `expired`) folded into briefing notes. >5 changes → one summary line +
 * a `/week` link (view purpose, only on an immediate send).
 */
import { createHash } from "node:crypto";
import { addBriefingNote } from "@/server/briefing/notes";
import { deliver, type DeliverResult } from "@/server/channels/deliver";
import { textPlan } from "@/server/channels/plan";
import { claimDedupe, deliveredKeys } from "@/server/channels/repo";
import { db } from "@/server/db";
import { loadUserSchedule } from "@/server/proactive/settings";
import { classifyDueChange } from "@/server/proactive/schedule";
import { renderDueChangeAlert, stripUrls, type DueChangeItem, type Register } from "@/server/reminders/render";
import { cancelForItem, ensureAutoNudges, recomputeAnchored } from "@/server/reminders/service";
import { mintMagicLink } from "@/server/security/magic-links";
import type { JsonValue, TimelineChange, TimelineChangeBatch } from "@/server/timeline/types";
import { formatForChat } from "@/shared/time/tz";

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;
/** More immediate changes than this → one summary line + link (no flood). */
export const ALERT_LIST_MAX = 5;
/** More removals than this in one batch → one aggregate note. */
export const REMOVAL_NOTE_MAX = 5;
/** Explicit item lists longer than this ensure nudges for all items instead (URL length). */
const ENSURE_IDS_MAX = 50;
/** A deferred alert is re-sent only if it lands at least this long before the next briefing. */
const BEFORE_BRIEFING_MARGIN_MS = 15 * MIN_MS;
/** Alert expiry when the user has no briefing scheduled. */
const DEFAULT_ALERT_TTL_MS = 12 * HOUR_MS;

/** One item that should be alerted now. */
export interface AlertCandidate {
  itemId: string;
  change: "due_changed" | "created";
  title: string;
  course: string | null;
  oldDueAt: Date | null;
  newDueAt: Date;
  urgent: boolean;
  /** per-item proactive_dedupe key */
  key: string;
}

/** One briefing note to write. */
export interface NoteCandidate {
  kind: "due_changed" | "item_removed" | "other";
  itemId: string | null;
  payload: Record<string, JsonValue>;
  dedupeKey: string;
}

/** Side effects for one batch (pure output of `planTimelineChanges`). */
export interface ChangePlan {
  /** done/dismissed items: cancel auto + user anchored reminders */
  cancelDone: string[];
  /** removed items: cancel anchored reminders (+ note when a user reminder was cancelled) */
  cancelRemoved: { itemId: string; title: string | null; course: string | null }[];
  /** re-time anchored reminders */
  recompute: { itemId: string; anchorAt: Date | null }[];
  /** ensure auto nudges: "all" items due ≤36h, or these item ids */
  ensure: "all" | string[];
  alerts: AlertCandidate[];
  notes: NoteCandidate[];
}

function date(iso: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function shortHash(parts: string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}

/**
 * Per-item dedupe key of a due-change alert / note (replays and overlapping batches are no-ops).
 * @param itemId timeline item
 * @param newDueAt new anchor
 * @returns `due_change:<itemId>:<iso>`
 */
export function dueChangeKey(itemId: string, newDueAt: Date): string {
  return `due_change:${itemId}:${newDueAt.toISOString()}`;
}

function isDeadline(c: TimelineChange): boolean {
  return c.itemKind === "assignment" || c.itemKind === "exam";
}

/**
 * Plan the side effects of one change batch (pure; V2-06 §2.8 rules, see the module header).
 * @param batch change batch
 * @param now clock
 * @returns what to cancel, re-time, ensure, alert and note
 */
export function planTimelineChanges(batch: TimelineChangeBatch, now: Date): ChangePlan {
  const nowMs = now.getTime();
  const plan: ChangePlan = { cancelDone: [], cancelRemoved: [], recompute: [], ensure: [], alerts: [], notes: [] };
  const ensureIds = new Set<string>();
  let ensureAll = batch.initial;
  const removalNotes: NoteCandidate[] = [];

  for (const c of batch.changes) {
    const newDue = date(c.newDueAt);
    const oldDue = date(c.oldDueAt);
    const hint = batch.initial ? "none" : c.deliveryHint;
    switch (c.kind) {
      case "status_changed":
        if (c.status === "upcoming") ensureIds.add(c.itemId);
        else plan.cancelDone.push(c.itemId);
        break;
      case "removed": {
        plan.cancelRemoved.push({ itemId: c.itemId, title: c.title, course: c.course });
        const dueSoon = oldDue !== null && oldDue.getTime() >= nowMs && oldDue.getTime() <= nowMs + 7 * DAY_MS;
        const wanted = hint === "briefing" || (hint === undefined && isDeadline(c) && dueSoon);
        if (wanted) {
          removalNotes.push({
            kind: "item_removed",
            itemId: c.itemId,
            payload: { title: c.title, course: c.course, oldDue: c.oldDueAt },
            dedupeKey: `item_removed:${c.itemId}`,
          });
        }
        break;
      }
      case "due_changed": {
        plan.recompute.push({ itemId: c.itemId, anchorAt: newDue });
        if (hint === "none" || !newDue) break;
        const route = classifyDueChange({ oldDueAt: oldDue, newDueAt: newDue, status: c.status }, now);
        if (route.route === "alert") {
          plan.alerts.push({
            itemId: c.itemId,
            change: "due_changed",
            title: c.title ?? "untitled",
            course: c.course,
            oldDueAt: oldDue,
            newDueAt: newDue,
            urgent: route.urgent,
            key: dueChangeKey(c.itemId, newDue),
          });
        } else if (route.route === "briefing") {
          plan.notes.push({
            kind: "due_changed",
            itemId: c.itemId,
            payload: { title: c.title, course: c.course, oldDue: c.oldDueAt, newDue: c.newDueAt },
            dedupeKey: dueChangeKey(c.itemId, newDue),
          });
        }
        break;
      }
      case "created": {
        ensureIds.add(c.itemId);
        if (hint !== "immediate" || c.status !== "upcoming" || !newDue || !isDeadline(c)) break;
        const t = newDue.getTime();
        if (t >= nowMs && t <= nowMs + DAY_MS) {
          plan.alerts.push({
            itemId: c.itemId,
            change: "created",
            title: c.title ?? "untitled",
            course: c.course,
            oldDueAt: null,
            newDueAt: newDue,
            urgent: true,
            key: `new_item:${c.itemId}`,
          });
        }
        break;
      }
    }
  }

  if (removalNotes.length > REMOVAL_NOTE_MAX) {
    const ids = removalNotes.map((n) => n.itemId ?? "").sort();
    plan.notes.push({
      kind: "item_removed",
      itemId: null,
      payload: { count: removalNotes.length },
      dedupeKey: `items_removed:${shortHash(ids)}`,
    });
  } else plan.notes.push(...removalNotes);

  if (ensureIds.size > ENSURE_IDS_MAX) ensureAll = true;
  plan.ensure = ensureAll ? "all" : [...ensureIds];
  return plan;
}

/** "new on Canvas: CPSC 323: lab 2, due today 11:59pm" lines for created items. */
function renderNewItems(items: AlertCandidate[], tz: string, now: Date, register: Register): string[] {
  if (items.length === 0) return [];
  const label = (a: AlertCandidate): string => {
    const t = stripUrls(a.title, "").replace(/\s+/g, " ").trim() || "untitled";
    const c = a.course ? stripUrls(a.course, "").replace(/\s+/g, " ").trim() : "";
    const full = c && !t.toLowerCase().includes(c.toLowerCase()) ? `${c}: ${t}` : t;
    return full.length > 90 ? `${full.slice(0, 89).trimEnd()}…` : full;
  };
  if (items.length === 1) {
    const a = items[0];
    const when = formatForChat(a.newDueAt, tz, now);
    return [register === "casual" ? `new on Canvas: ${label(a)}, due ${when} 👀` : `New on Canvas: ${label(a)}, due ${when}.`];
  }
  const head = register === "casual" ? "new on Canvas:" : "New on Canvas:";
  return [`${head}\n${items.map((a) => `• ${label(a)}: ${formatForChat(a.newDueAt, tz, now)}`).join("\n")}`];
}

/**
 * Alert bubbles for one batch.
 * @param alerts items to alert (already filtered for prior delivery)
 * @param tz user zone
 * @param now clock
 * @param register casual | neutral
 * @param withLink whether a `/week` link bubble follows (summary form only)
 * @returns bubble texts and whether the summary form was used
 */
export function renderAlertBubbles(
  alerts: AlertCandidate[],
  tz: string,
  now: Date,
  register: Register,
  withLink: boolean,
): { texts: string[]; summary: boolean } {
  if (alerts.length > ALERT_LIST_MAX) {
    const n = alerts.length;
    if (withLink) {
      return {
        texts: [register === "casual" ? `${n} deadlines just changed on Canvas, here's your updated week:` : `${n} deadlines changed on Canvas. Here is your updated week:`],
        summary: true,
      };
    }
    return {
      texts: [
        register === "casual"
          ? `${n} deadlines just changed on Canvas. text me "week" and I'll send the updated list`
          : `${n} deadlines changed on Canvas. Text me "week" for the updated list.`,
      ],
      summary: true,
    };
  }
  const moves: DueChangeItem[] = alerts
    .filter((a) => a.change === "due_changed")
    .map((a) => ({ title: a.title, course: a.course, oldDueAt: a.oldDueAt, newDueAt: a.newDueAt }));
  const created = alerts.filter((a) => a.change === "created");
  return { texts: [...renderDueChangeAlert(moves, tz, now, register), ...renderNewItems(created, tz, now, register)], summary: false };
}

function errName(e: unknown): string {
  return e instanceof Error ? e.name : "unknown";
}

function noteFromAlert(a: AlertCandidate): NoteCandidate {
  return a.change === "due_changed"
    ? {
        kind: "due_changed",
        itemId: a.itemId,
        payload: { title: a.title, course: a.course, oldDue: a.oldDueAt?.toISOString() ?? null, newDue: a.newDueAt.toISOString() },
        dedupeKey: a.key,
      }
    : {
        kind: "other",
        itemId: a.itemId,
        payload: { text: `new on Canvas: ${a.title}${a.course ? ` (${a.course})` : ""}` },
        dedupeKey: a.key,
      };
}

/**
 * Process one change batch. Idempotent (at-least-once delivery). Every step runs even if an
 * earlier one fails; failures are rethrown together at the end so the job retries.
 * @param userId owner of the changed items
 * @param batch change batch (titles/courses are untrusted)
 * @param now clock
 * @returns how many alerts were sent and briefing notes written
 */
export async function handleTimelineChanges(
  userId: string,
  batch: TimelineChangeBatch,
  now: Date,
): Promise<{ alerted: number; noted: number }> {
  if (batch.changes.length === 0) return { alerted: 0, noted: 0 };
  const schedule = await loadUserSchedule(userId);
  if (!schedule || schedule.deleted) return { alerted: 0, noted: 0 };
  const plan = planTimelineChanges(batch, now);
  const failures: string[] = [];
  const step = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      failures.push(`${name}:${errName(e)}`);
    }
  };
  let noted = 0;
  let alerted = 0;
  const note = async (n: NoteCandidate): Promise<void> => {
    await addBriefingNote(userId, n.kind, n.payload, { ...(n.itemId ? { itemId: n.itemId } : {}), dedupeKey: n.dedupeKey });
    noted += 1;
  };

  for (const itemId of plan.cancelDone) await step("cancel_done", async () => void (await cancelForItem(userId, itemId, "all", "done")));
  for (const r of plan.cancelRemoved) {
    await step("cancel_removed", async () => {
      await cancelForItem(userId, r.itemId, "auto", "removed");
      const userCancelled = await cancelForItem(userId, r.itemId, "all", "removed");
      if (userCancelled > 0) {
        await note({
          kind: "other",
          itemId: null,
          payload: { text: `cancelled ${userCancelled === 1 ? "your reminder" : `${userCancelled} reminders`} for ${r.title ?? "an item"} (it disappeared from Canvas)` },
          dedupeKey: `reminder_cancelled:item:${r.itemId}`,
        });
      }
    });
  }
  for (const r of plan.recompute) await step("recompute", () => recomputeAnchored(userId, r.itemId, r.anchorAt, now));
  if (plan.ensure === "all") await step("ensure", async () => void (await ensureAutoNudges(userId, now)));
  else if (plan.ensure.length > 0) {
    const ids = plan.ensure;
    await step("ensure", async () => void (await ensureAutoNudges(userId, now, ids)));
  }
  for (const n of plan.notes) await step("note", () => note(n));

  if (plan.alerts.length > 0) {
    await step("alert", async () => {
      const done = await deliveredKeys(userId, plan.alerts.map((a) => a.key));
      const fresh = plan.alerts.filter((a) => !done.has(a.key));
      if (fresh.length === 0) return;
      alerted = await sendAlerts(userId, fresh, schedule.settings.tz, schedule.settings.register, schedule.nextBriefingAt, now, note);
    });
  }

  if (failures.length > 0) throw new Error(`handleTimelineChanges: ${failures.join(", ")}`);
  return { alerted, noted };
}

/** Deliver one bundled alert; returns items alerted (0 when folded into notes or suppressed). */
async function sendAlerts(
  userId: string,
  alerts: AlertCandidate[],
  tz: string,
  register: Register,
  nextBriefingAt: Date | null,
  now: Date,
  note: (n: NoteCandidate) => Promise<void>,
): Promise<number> {
  const keys = alerts.map((a) => a.key).sort();
  const bundleKey = `tlc_alert:${userId}:${shortHash(keys)}`;
  const urgent = alerts.some((a) => a.urgent);
  const expiresAt = nextBriefingAt && nextBriefingAt.getTime() > now.getTime() ? nextBriefingAt : new Date(now.getTime() + DEFAULT_ALERT_TTL_MS);

  let link: string | null = null;
  if (alerts.length > ALERT_LIST_MAX) {
    try {
      link = await mintMagicLink({ userId, purpose: "view", preview: { kind: "week" } });
    } catch (e) {
      console.warn(`[alerts] link mint failed: ${errName(e)}`);
    }
  }
  const first = renderAlertBubbles(alerts, tz, now, register, link !== null);
  let result: DeliverResult = await deliver(userId, textPlan(first.texts, link), {
    proactive: true,
    reason: "due_change",
    dedupeKey: bundleKey,
    priority: urgent ? "urgent" : "routine",
    expiresAt,
    deferMode: "return",
  });

  if (result.status === "deferred") {
    if (result.until.getTime() <= expiresAt.getTime() - BEFORE_BRIEFING_MARGIN_MS) {
      // Still useful before the next briefing: persist a linkless version (the view link would expire).
      const later = renderAlertBubbles(alerts, tz, now, register, false);
      result = await deliver(userId, textPlan(later.texts), {
        proactive: true,
        reason: "due_change",
        dedupeKey: `${bundleKey}:later`,
        priority: urgent ? "urgent" : "routine",
        expiresAt,
      });
    } else {
      result = { status: "suppressed", reason: "expired" };
    }
  }

  switch (result.status) {
    case "sent":
    case "queued":
    case "deferred": {
      for (const k of keys) await claimDedupe(userId, k);
      await clearStaleNotes(userId, alerts.filter((a) => a.change === "due_changed").map((a) => a.itemId));
      return alerts.length;
    }
    case "suppressed":
      if (result.reason === "duplicate") {
        for (const k of keys) await claimDedupe(userId, k);
        return 0;
      }
      if (result.reason === "expired") {
        // Can't land before the next briefing: the briefing mentions it instead.
        for (const a of alerts) await note(noteFromAlert(a));
      }
      return 0;
    case "failed":
      throw new Error(`alert delivery failed: ${result.error}`);
  }
}

/** Older unconsumed due_changed notes for items we just alerted would repeat stale news. */
async function clearStaleNotes(userId: string, itemIds: string[]): Promise<void> {
  if (itemIds.length === 0) return;
  const { error } = await db()
    .from("briefing_notes")
    .delete()
    .eq("user_id", userId)
    .eq("kind", "due_changed")
    .is("consumed_at", null)
    .in("item_id", itemIds);
  if (error) console.warn(`[alerts] clearing stale notes failed: ${error.code ?? "db"}`);
}
