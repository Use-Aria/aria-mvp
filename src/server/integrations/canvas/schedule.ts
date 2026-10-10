import "server-only";
// OWNER: 1.4

/**
 * Canvas sync timing (V2-05 §2.7, §7.2 `schedule.ts`). Pure apart from the default `Math.random`.
 * - Hourly at a deterministic per-user minute (spreads load), 30–90 min out, plus 0–59s jitter.
 * - Transient backoff 5m, 15m, 45m, 2h, 6h (×0.8–1.2); the handler records and returns normally.
 * - Revoke after 3 consecutive definitive failures spanning ≥ 2h; error-notify once after 48h of
 *   transient failures and keep retrying every 6h.
 */
import { createHash } from "node:crypto";
import type { FeedFetchClass } from "@/server/integrations/canvas/fetch-feed";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const BACKOFF_MS: readonly number[] = [5 * MINUTE_MS, 15 * MINUTE_MS, 45 * MINUTE_MS, 2 * HOUR_MS, 6 * HOUR_MS];
/** Definitive failures needed (consecutive) before revoking. */
export const REVOKE_AFTER_FAILURES = 3;
/** Minimum span of a definitive streak before revoking. */
export const REVOKE_MIN_SPAN_MS = 2 * HOUR_MS;
/** Transient streak length after which the user is told once. */
export const LONG_OUTAGE_MS = 48 * HOUR_MS;
/** Retry interval during a long outage. */
export const LONG_OUTAGE_RETRY_MS = 6 * HOUR_MS;

/**
 * Deterministic minute-of-hour for a user's hourly sync.
 * @param userId user uuid
 * @returns `parseInt(sha256(userId)[0..8], 16) % 60`
 */
export function userSlotMinute(userId: string): number {
  const hex = createHash("sha256").update(userId, "utf8").digest("hex").slice(0, 8);
  return parseInt(hex, 16) % 60;
}

/**
 * Next scheduled sync: the first `hour + slotMinute` (UTC hours) strictly after `now + 30min`,
 * so in (now+30m, now+90m], plus 0–59 whole seconds of jitter.
 * @param userId user uuid
 * @param now clock
 * @param rand uniform [0,1) source (default `Math.random`)
 * @returns the next `next_sync_at`
 */
export function nextHourlySync(userId: string, now: Date, rand: () => number = Math.random): Date {
  const threshold = now.getTime() + 30 * MINUTE_MS;
  const hourStart = threshold - (((threshold % HOUR_MS) + HOUR_MS) % HOUR_MS);
  let at = hourStart + userSlotMinute(userId) * MINUTE_MS;
  if (at <= threshold) at += HOUR_MS;
  return new Date(at + Math.floor(clamp01(rand()) * 60) * 1000);
}

/**
 * Transient-failure backoff.
 * @param n consecutive failures including this one (values < 1 are treated as 1)
 * @param rand uniform [0,1) source (default `Math.random`)
 * @returns delay in ms: [5m, 15m, 45m, 2h, 6h][min(n−1, 4)] × (0.8–1.2)
 */
export function backoffDelayMs(n: number, rand: () => number = Math.random): number {
  const idx = Math.min(Math.max(Math.floor(Number.isFinite(n) ? n : 1), 1) - 1, BACKOFF_MS.length - 1);
  return Math.round(BACKOFF_MS[idx] * (0.8 + 0.4 * clamp01(rand())));
}

/** What to do after a failed sync. */
export type FailureDecision = { action: "retry"; at: Date } | { action: "revoke" } | { action: "error_notify"; at: Date };

/**
 * Decides the follow-up for a failed sync. `rejected` (policy) counts as definitive at sync time.
 * @param i.cls failure class of this sync
 * @param i.consecutiveFailures failures in the current streak, including this one
 * @param i.firstFailureAt start of the streak (null → this failure starts it)
 * @param i.now clock
 * @param i.alreadyNotified the user was already told about this outage (`status_notified_at`)
 * @param i.rand optional jitter source for the retry delay
 * @returns retry at a time, revoke, or notify once and retry in 6h
 */
export function decideAfterFailure(i: {
  cls: FeedFetchClass;
  consecutiveFailures: number;
  firstFailureAt: Date | null;
  now: Date;
  alreadyNotified: boolean;
  rand?: () => number;
}): FailureDecision {
  const now = i.now.getTime();
  const span = i.firstFailureAt ? now - i.firstFailureAt.getTime() : 0;
  const n = Math.max(1, i.consecutiveFailures);

  if (i.cls === "definitive" || i.cls === "rejected") {
    if (n >= REVOKE_AFTER_FAILURES && span >= REVOKE_MIN_SPAN_MS) return { action: "revoke" };
    return { action: "retry", at: new Date(now + backoffDelayMs(n, i.rand)) };
  }

  if (span >= LONG_OUTAGE_MS) {
    const at = new Date(now + LONG_OUTAGE_RETRY_MS);
    return i.alreadyNotified ? { action: "retry", at } : { action: "error_notify", at };
  }
  return { action: "retry", at: new Date(now + backoffDelayMs(n, i.rand)) };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x) || x < 0) return 0;
  return x >= 1 ? 0.999999 : x;
}
