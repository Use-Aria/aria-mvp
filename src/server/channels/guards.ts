import "server-only";
// OWNER: 1.2

/**
 * Delivery guards (pure, DST-safe via `@/shared/time/tz`; V2-03 §2.6, master plan §1.1, D8).
 *
 * | Class       | Opt-out | Pause | Quiet hours | Daily cap (3)   | Bundling | Follow-up quota |
 * |-------------|---------|-------|-------------|-----------------|----------|-----------------|
 * | `reply`     | drop    | —     | —           | —               | —        | —               |
 * | `routine`   | drop    | defer | defer       | defer next day  | 10 min   | defer 1h        |
 * | `urgent`    | drop    | defer | defer       | not counted     | —        | defer 1h        |
 * | `requested` | drop    | defer | bypass      | not counted     | —        | defer 1h        |
 *
 * All proactive classes also defer 30s while a conversation run holds the lease. Opt-out is the
 * one legally required drop; everything else defers. `earliestAllowedSend` iterates the
 * constraints to a fixed point (a pause ending at 23:00 then lands in quiet hours → 08:00).
 */
import { PIPELINE } from "@/server/pipeline/config";
import type { Service } from "@/server/channels/types";
import {
  addLocalDays,
  compareLocalDate,
  isInDailyWindow,
  localDateOf,
  parseHHMM,
  safeTimeZone,
  startOfLocalDay,
  toLocal,
  zonedToUtc,
  type LocalTime,
} from "@/shared/time/tz";

/** Delivery class: `reply` = `proactive: false`; the rest are `DeliverPriority`. */
export type DeliveryClass = "reply" | "routine" | "urgent" | "requested";

/** Why a delivery waits. */
export type DeferReason =
  | "paused"
  | "quiet_hours"
  | "daily_cap"
  | "bundling"
  | "followup_quota"
  | "conversation_active"
  | "not_before";

/** Guard verdict. */
export type GuardDecision =
  | { action: "send" }
  | { action: "defer"; until: Date; reason: DeferReason }
  | { action: "drop"; reason: "opted_out" | "expired" };

/** A daily quiet window `[startMin, endMin)` in local minutes since midnight; may span midnight. */
export interface QuietWindow {
  startMin: number;
  endMin: number;
}

/** Everything the guards need, loaded by `deliver`/the flush (no I/O here). */
export interface GuardState {
  /** IANA zone (invalid → default zone). */
  tz: string;
  /** Effective quiet window (`effectiveQuietWindow`). */
  quiet: QuietWindow;
  optedOut: boolean;
  pausedUntil: Date | null;
  /** Routine proactive deliveries since local midnight. */
  routineSentToday: number;
  /** Last proactive send on this channel (bundling). */
  lastProactiveAt: Date | null;
  /** A conversation run holds the user's lease. */
  conversationActive: boolean;
  /** The user texted within 24h (no follow-up quota applies). */
  windowOpen: boolean;
  /** Distinct outside-window recipients on this line in the last 24h. */
  followupRecipients24h: number;
  notBefore?: Date | null;
  expiresAt?: Date | null;
  /** Jitter added to a quiet-hours deferral (0–5 min; deliver passes a random value). */
  quietJitterMs?: number;
}

const DAY_MIN = 24 * 60;
const MAX_ITERATIONS = 12;

/**
 * Minutes since midnight of a Postgres `time` / "HH:MM" string.
 * @param t time text (e.g. "22:00", "08:00:00")
 * @param fallback used when `t` is missing or invalid
 * @returns minutes 0–1439
 */
export function clockMinutes(t: string | null | undefined, fallback: string): number {
  let lt: LocalTime;
  try {
    lt = parseHHMM(t ?? fallback);
  } catch {
    lt = parseHHMM(fallback);
  }
  return lt.hour * 60 + lt.minute;
}

/**
 * The quiet window that applies on a channel: the user's `quiet_start`/`quiet_end` (default
 * 22:00–08:00); on SMS/RCS widened to cover at least 21:00–08:00 (spec §3.22). The widened window
 * is the smallest single window covering both, so neither is ever violated.
 * `start == end` (user disabled quiet hours) means no user window.
 * @param user `users.quiet_start` / `quiet_end` (Postgres time text or null)
 * @param service transport of the channel
 * @returns the effective window
 */
export function effectiveQuietWindow(
  user: { quietStart: string | null; quietEnd: string | null },
  service: Service,
): QuietWindow {
  const own: QuietWindow = {
    startMin: clockMinutes(user.quietStart, PIPELINE.defaultQuietStart),
    endMin: clockMinutes(user.quietEnd, PIPELINE.defaultQuietEnd),
  };
  if (service === "imessage") return own;
  const floor: QuietWindow = {
    startMin: clockMinutes(PIPELINE.smsQuietStart, PIPELINE.smsQuietStart),
    endMin: clockMinutes(PIPELINE.smsQuietEnd, PIPELINE.smsQuietEnd),
  };
  return coverWindows(own, floor);
}

/**
 * Whether `at` falls in the quiet window, in the user's local time.
 * @param at instant
 * @param tz IANA zone
 * @param w quiet window
 * @returns true when quiet
 */
export function isQuiet(at: Date, tz: string, w: QuietWindow): boolean {
  const l = toLocal(at, safeTimeZone(tz));
  return isInDailyWindow(l, minToTime(w.startMin), minToTime(w.endMin));
}

/**
 * End of the quiet period containing `at` (plus jitter), DST-safe: the local end time is solved on
 * the right local date (gap → shifted forward). When `at` is not quiet, returns `at` unchanged.
 * @param at instant inside (or outside) the window
 * @param tz IANA zone
 * @param w quiet window
 * @param jitterMs added to the result (spread the morning flush)
 * @returns the instant quiet hours end
 */
export function nextQuietEnd(at: Date, tz: string, w: QuietWindow, jitterMs: number): Date {
  const zone = safeTimeZone(tz);
  if (!isQuiet(at, zone, w)) return at;
  const l = toLocal(at, zone);
  const x = l.hour * 60 + l.minute;
  const crosses = w.startMin > w.endMin;
  const endDate = crosses && x >= w.startMin ? addLocalDays(l, 1) : { year: l.year, month: l.month, day: l.day };
  let end = zonedToUtc({ ...endDate, ...minToTime(w.endMin) }, zone).instant;
  if (end.getTime() <= at.getTime()) {
    // Ambiguous fall-back hour resolved to the earlier instant: count wall minutes instead.
    const remaining = (w.endMin - x + DAY_MIN) % DAY_MIN || DAY_MIN;
    end = new Date(at.getTime() + remaining * 60_000);
  }
  return new Date(end.getTime() + Math.max(0, jitterMs));
}

/**
 * Instant the daily-cap day starts (local midnight of `now`); the cap counts routine sends since.
 * @param now current instant
 * @param tz IANA zone
 * @returns local midnight as a UTC instant
 */
export function capDayStart(now: Date, tz: string): Date {
  return startOfLocalDay(now, safeTimeZone(tz));
}

/**
 * Whether the channel is inside the provider's 24h messaging window.
 * @param lastInboundAt last inbound message time (null = never)
 * @param now current instant
 * @returns true when the user texted within 24h
 */
export function isWindowOpen(lastInboundAt: Date | null, now: Date): boolean {
  return lastInboundAt !== null && now.getTime() - lastInboundAt.getTime() < PIPELINE.windowMs;
}

/**
 * Maps `DeliverOptions` to a delivery class.
 * @param proactive `opts.proactive`
 * @param priority `opts.priority` (default "routine" when proactive)
 * @returns the class
 */
export function deliveryClass(
  proactive: boolean,
  priority?: "routine" | "urgent" | "requested",
): DeliveryClass {
  return proactive ? (priority ?? "routine") : "reply";
}

/**
 * When a routine/urgent/requested item should be flushed from the outbox (V2-03 §2.6 bundling):
 * routine → `max(now + 30s, lastProactiveAt + 10min)`; urgent/requested → now.
 * @param cls delivery class
 * @param now current instant
 * @param lastProactiveAt last proactive send (null = none)
 * @returns the outbox job's `run_at`
 */
export function outboxRunAt(cls: DeliveryClass, now: Date, lastProactiveAt: Date | null): Date {
  if (cls !== "routine") return now;
  const hold = now.getTime() + PIPELINE.routineHoldMs;
  const bundle = lastProactiveAt ? lastProactiveAt.getTime() + PIPELINE.bundleWindowMs : 0;
  return new Date(Math.max(hold, bundle));
}

/**
 * Earliest instant ≥ now at which every guard allows the send, and the constraint that pushed it
 * back the most.
 * Ignores opt-out and expiry (see `evaluateDelivery`). For `reply`, always `{at: now}`.
 * @param state guard inputs
 * @param cls delivery class
 * @param now current instant
 * @returns the instant and the binding reason (null when sendable now)
 */
export function earliestAllowedSend(
  state: GuardState,
  cls: DeliveryClass,
  now: Date,
): { at: Date; reason: DeferReason | null } {
  if (cls === "reply") return { at: now, reason: null };
  const tz = safeTimeZone(state.tz);
  const nowMs = now.getTime();
  let t = nowMs;
  // Reported reason = the constraint that pushed the send back the most (a cap that moves it to
  // tomorrow beats the quiet hours it then lands in; quiet hours beat a 30s lease wait).
  const pushed = new Map<DeferReason, number>();
  const bump = (to: number, why: DeferReason): boolean => {
    if (to <= t) return false;
    pushed.set(why, (pushed.get(why) ?? 0) + (to - t));
    t = to;
    return true;
  };

  if (state.notBefore) bump(state.notBefore.getTime(), "not_before");
  if (state.conversationActive) bump(nowMs + PIPELINE.conversationActiveDeferMs, "conversation_active");
  if (!state.windowOpen && state.followupRecipients24h >= PIPELINE.followupQuota) {
    bump(nowMs + PIPELINE.followupQuotaDeferMs, "followup_quota");
  }
  if (cls === "routine" && state.lastProactiveAt) {
    bump(state.lastProactiveAt.getTime() + PIPELINE.bundleWindowMs, "bundling");
  }

  const today = localDateOf(now, tz);
  for (let i = 0; i < MAX_ITERATIONS; i += 1) {
    let moved = false;
    if (state.pausedUntil) moved = bump(state.pausedUntil.getTime(), "paused") || moved;
    if (
      cls === "routine" &&
      state.routineSentToday >= PIPELINE.proactiveDailyCap &&
      compareLocalDate(localDateOf(new Date(t), tz), today) === 0
    ) {
      const tomorrow = zonedToUtc({ ...addLocalDays(today, 1), hour: 0, minute: 0 }, tz).instant;
      moved = bump(tomorrow.getTime(), "daily_cap") || moved;
    }
    if (cls !== "requested" && isQuiet(new Date(t), tz, state.quiet)) {
      moved = bump(nextQuietEnd(new Date(t), tz, state.quiet, state.quietJitterMs ?? 0).getTime(), "quiet_hours") || moved;
    }
    if (!moved) break;
  }
  let reason: DeferReason | null = null;
  let most = 0;
  for (const [why, ms] of pushed) {
    if (ms > most) {
      most = ms;
      reason = why;
    }
  }
  return { at: new Date(t), reason };
}

/**
 * Full guard verdict for one delivery at `now`.
 * Opt-out drops every class (replies included); an item whose earliest allowed send is after
 * `expiresAt` (or that is already expired) is dropped as `expired`; otherwise send or defer.
 * @param state guard inputs
 * @param cls delivery class
 * @param now current instant
 * @returns send / defer (until, reason) / drop (reason)
 */
export function evaluateDelivery(state: GuardState, cls: DeliveryClass, now: Date): GuardDecision {
  if (state.optedOut) return { action: "drop", reason: "opted_out" };
  if (cls === "reply") return { action: "send" };
  if (state.expiresAt && state.expiresAt.getTime() < now.getTime()) return { action: "drop", reason: "expired" };
  const { at, reason } = earliestAllowedSend(state, cls, now);
  if (state.expiresAt && at.getTime() > state.expiresAt.getTime()) return { action: "drop", reason: "expired" };
  if (reason === null || at.getTime() <= now.getTime()) return { action: "send" };
  return { action: "defer", until: at, reason };
}

// ── internals ───────────────────────────────────────────────────────────────

function minToTime(m: number): LocalTime {
  const v = ((m % DAY_MIN) + DAY_MIN) % DAY_MIN;
  return { hour: Math.floor(v / 60), minute: v % 60 };
}

function arcLength(w: QuietWindow): number {
  return (w.endMin - w.startMin + DAY_MIN) % DAY_MIN;
}

/** Smallest single arc (on the 24h circle) covering both windows. */
function coverWindows(a: QuietWindow, b: QuietWindow): QuietWindow {
  const la = arcLength(a);
  const lb = arcLength(b);
  if (la === 0) return b;
  if (lb === 0) return a;
  const fromA = Math.max(la, ((b.startMin - a.startMin + DAY_MIN) % DAY_MIN) + lb);
  const fromB = Math.max(lb, ((a.startMin - b.startMin + DAY_MIN) % DAY_MIN) + la);
  const [start, len] = fromA <= fromB ? [a.startMin, fromA] : [b.startMin, fromB];
  const capped = Math.min(len, DAY_MIN - 1); // never a full-day window (that reads as "none")
  return { startMin: start, endMin: (start + capped) % DAY_MIN };
}
