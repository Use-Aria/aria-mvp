import "server-only";
// OWNER: 2.6

/**
 * Pure scheduling policy for proactive sends (V2-06 §2.6, §2.7, §2.9; §7 `proactive/schedule.ts`).
 * No I/O; every function takes `now`. Quiet-hour math reuses the delivery guards
 * (`isQuiet` / `nextQuietEnd` from `channels/guards.ts`) so placement and delivery agree on the
 * window (orchestrator notes, Wave 1).
 */
import { isQuiet, nextQuietEnd, type QuietWindow as GuardQuietWindow } from "@/server/channels/guards";
import {
  addLocalDays,
  compareLocalDate,
  isInDailyWindow,
  localDateOf,
  safeTimeZone,
  toLocal,
  zonedToUtc,
  type LocalDate,
  type LocalTime,
} from "@/shared/time/tz";

/** Daily quiet window in local wall-clock time (may wrap midnight; start == end means none). */
export interface QuietWindow {
  start: LocalTime;
  end: LocalTime;
}

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

/** A briefing must be at least this far in the future to count as "next". */
export const BRIEFING_MIN_LEAD_MS = 2 * MIN_MS;
/** Nudges pulled before quiet hours land this long before quiet starts. */
export const NUDGE_PULL_BEFORE_QUIET_MS = 15 * MIN_MS;
/** A nudge may be pulled at most this much earlier than intended. */
export const NUDGE_MAX_PULL_MS = 6 * HOUR_MS;
/** A nudge pushed to quiet end must still land this long before the deadline. */
export const NUDGE_MIN_LEAD_AFTER_PUSH_MS = 30 * MIN_MS;
/** A due move smaller than this is noise (V2-06 §2.8). */
export const DUE_CHANGE_MIN_DELTA_MS = 5 * MIN_MS;
/** Due changes within this horizon alert immediately; later ones go to the briefing. */
export const DUE_CHANGE_ALERT_HORIZON_MS = 7 * DAY_MS;
/** Due changes landing within this horizon (or moving earlier) are urgent. */
export const DUE_CHANGE_URGENT_HORIZON_MS = 48 * HOUR_MS;
/** User reminders later than this get a "(from earlier)" prefix. */
export const LATE_PREFIX_AFTER_MS = 30 * MIN_MS;
/** One-off user reminders later than this expire instead of firing. */
export const LATE_EXPIRE_AFTER_MS = 12 * HOUR_MS;
/** Auto nudges later than this expire (the deadline is close; the briefing covered it). */
export const NUDGE_LATE_EXPIRE_AFTER_MS = 60 * MIN_MS;

/**
 * Converts the local-time window to the guards' minutes form.
 * @param q quiet window
 * @returns `{startMin, endMin}`
 */
export function toGuardWindow(q: QuietWindow): GuardQuietWindow {
  return { startMin: q.start.hour * 60 + q.start.minute, endMin: q.end.hour * 60 + q.end.minute };
}

/**
 * Converts the guards' minutes form to a local-time window.
 * @param w guard window
 * @returns `{start, end}`
 */
export function fromGuardWindow(w: GuardQuietWindow): QuietWindow {
  const t = (m: number): LocalTime => ({ hour: Math.floor(m / 60) % 24, minute: m % 60 });
  return { start: t(w.startMin), end: t(w.endMin) };
}

/** FNV-1a 32-bit (deterministic per-user jitter / phrase choice). */
export function stableHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Next briefing instant: the earliest local date D ≥ today(tz) whose solved instant of
 * `briefingTime` is more than 2 min after `now`. A briefing time inside the quiet window is
 * clamped to quiet end. DST-safe (local date stepped, then re-solved; gap → shifted forward).
 * @param args zone (invalid → default), briefing time, quiet window, clock
 * @returns the instant and its local date
 */
export function nextBriefingAt(args: {
  tz: string;
  briefingTime: LocalTime;
  quiet: QuietWindow;
  now: Date;
}): { at: Date; localDate: LocalDate } {
  const tz = safeTimeZone(args.tz);
  const time = isInDailyWindow(args.briefingTime, args.quiet.start, args.quiet.end) ? args.quiet.end : args.briefingTime;
  const today = localDateOf(args.now, tz);
  const min = args.now.getTime() + BRIEFING_MIN_LEAD_MS;
  for (let i = 0; i < 4; i += 1) {
    const d = addLocalDays(today, i);
    const at = zonedToUtc({ ...d, ...time }, tz).instant;
    if (at.getTime() > min) return { at, localDate: d };
  }
  // Unreachable for real zones (offsets < 1 day); keep a total function.
  const d = addLocalDays(today, 4);
  return { at: zonedToUtc({ ...d, ...time }, tz).instant, localDate: d };
}

/**
 * When to run `briefing_prepare`: `target − (10 + hash(userId) % 11)` minutes, never before `now`.
 * @param target briefing delivery instant
 * @param userId per-user jitter seed
 * @param now clock
 * @returns the prepare job's run time
 */
export function prepRunAt(target: Date, userId: string, now: Date): Date {
  const leadMin = 10 + (stableHash(userId) % 11);
  return new Date(Math.max(target.getTime() - leadMin * MIN_MS, now.getTime()));
}

/**
 * Fire time of an anchored reminder (no quiet-hour placement; user reminders are `requested`).
 * @param anchorAt item anchor (due_at ?? starts_at)
 * @param offsetMinutes minutes before the anchor
 * @returns anchor − offset
 */
export function anchoredFireAt(anchorAt: Date, offsetMinutes: number): Date {
  return new Date(anchorAt.getTime() - offsetMinutes * MIN_MS);
}

/**
 * Quiet-hour-aware auto-nudge placement (V2-06 §2.6). With intended = due − offset:
 * - not quiet → intended (null if it already passed);
 * - quiet → pull earlier to quiet start − 15 min when that is ≥ now and ≤ 6h before intended;
 *   otherwise push to quiet end when that is ≤ due − 30 min; otherwise null (the briefing covers it).
 * @param args deadline, offset, zone, quiet window (use the channel's effective window), clock
 * @returns fire instant, or null for "don't nudge"
 */
export function placeNudge(args: {
  dueAt: Date;
  offsetMinutes: number;
  tz: string;
  quiet: QuietWindow;
  now: Date;
}): Date | null {
  const tz = safeTimeZone(args.tz);
  const nowMs = args.now.getTime();
  const dueMs = args.dueAt.getTime();
  const intended = new Date(dueMs - args.offsetMinutes * MIN_MS);
  if (dueMs <= nowMs) return null;
  const w = toGuardWindow(args.quiet);
  if (!isQuiet(intended, tz, w)) return intended.getTime() >= nowMs - MIN_MS ? intended : null;

  // Start of the quiet period that contains `intended`.
  const l = toLocal(intended, tz);
  const x = l.hour * 60 + l.minute;
  const crosses = w.startMin > w.endMin;
  const startDate: LocalDate = crosses && x < w.endMin ? addLocalDays(l, -1) : { year: l.year, month: l.month, day: l.day };
  const quietStart = zonedToUtc({ ...startDate, ...args.quiet.start }, tz).instant;
  const pull = quietStart.getTime() - NUDGE_PULL_BEFORE_QUIET_MS;
  if (pull >= nowMs && intended.getTime() - pull <= NUDGE_MAX_PULL_MS) return new Date(pull);

  const push = nextQuietEnd(intended, tz, w, 0).getTime();
  if (push >= nowMs && push <= dueMs - NUDGE_MIN_LEAD_AFTER_PUSH_MS) return new Date(push);
  return null;
}

/** Where a due-date change goes (V2-06 §2.8). */
export type DueChangeRoute = { route: "alert"; urgent: boolean } | { route: "briefing" } | { route: "ignore" };

/**
 * Route a due-date change: ignore noise/past/done; alert when either end is within 7 days
 * (urgent when the new due is ≤48h away or it moved earlier); otherwise fold into the briefing.
 * @param c old/new due and the item status
 * @param now clock
 * @returns the route
 */
export function classifyDueChange(
  c: { oldDueAt: Date | null; newDueAt: Date | null; status: string },
  now: Date,
): DueChangeRoute {
  if (c.status !== "upcoming" || !c.newDueAt) return { route: "ignore" };
  const nowMs = now.getTime();
  const next = c.newDueAt.getTime();
  if (next <= nowMs) return { route: "ignore" };
  const prev = c.oldDueAt?.getTime() ?? null;
  if (prev !== null && Math.abs(next - prev) < DUE_CHANGE_MIN_DELTA_MS) return { route: "ignore" };
  const soonest = prev === null ? next : Math.min(prev, next);
  if (soonest <= nowMs + DUE_CHANGE_ALERT_HORIZON_MS) {
    const urgent = next <= nowMs + DUE_CHANGE_URGENT_HORIZON_MS || (prev !== null && next < prev);
    return { route: "alert", urgent };
  }
  return { route: "briefing" };
}

/** What to do with a briefing whose delivery was deferred (V2-06 §2.6 staleness table). */
export type BriefingDeferral = { action: "regenerate"; kind: "daily" | "monday" | "catchup" } | { action: "skip" };

/**
 * Deferred briefing policy by the local time of `until` on the briefing's local date:
 * before 12:00 → regenerate as usual; 12:00–17:59 → compact catch-up; ≥18:00 or a later date → skip.
 * @param until when delivery becomes possible
 * @param localDate the briefing's local date
 * @param tz user zone
 * @param baseKind the original kind
 * @returns regenerate (with kind) or skip
 */
export function briefingDeferral(
  until: Date,
  localDate: LocalDate,
  tz: string,
  baseKind: "daily" | "monday",
): BriefingDeferral {
  const l = toLocal(until, safeTimeZone(tz));
  if (compareLocalDate(l, localDate) !== 0) return { action: "skip" };
  if (l.hour < 12) return { action: "regenerate", kind: baseKind };
  if (l.hour < 18) return { action: "regenerate", kind: "catchup" };
  return { action: "skip" };
}

/**
 * Late-fire policy for a reminder job running at `now` for an occurrence due at `dueAt`
 * (outage backlog, V2-06 §2.9):
 * - auto nudge: fire ≤60 min late, else expire;
 * - recurring: fire ≤30 min late, else skip to the next future occurrence;
 * - one-off user reminder: fire ≤30 min late, "(from earlier)" prefix ≤12h, else expire.
 * @param dueAt the occurrence's scheduled instant
 * @param now clock
 * @param kind reminder kind
 * @param origin user or auto
 * @returns the action
 */
export function lateFirePolicy(
  dueAt: Date,
  now: Date,
  kind: "absolute" | "anchored" | "recurring",
  origin: "user" | "auto",
): "fire" | "fire_late_prefix" | "expire" | "skip_to_next" {
  const late = now.getTime() - dueAt.getTime();
  if (origin === "auto") return late <= NUDGE_LATE_EXPIRE_AFTER_MS ? "fire" : "expire";
  if (late <= LATE_PREFIX_AFTER_MS) return "fire";
  if (kind === "recurring") return "skip_to_next";
  return late <= LATE_EXPIRE_AFTER_MS ? "fire_late_prefix" : "expire";
}
