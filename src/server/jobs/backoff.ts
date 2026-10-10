import "server-only";
// OWNER: 1.1

/**
 * Retry backoff for failed jobs (V2-03 §2.11): `min(15s × 2^(attempt − 1), 1h)` ± 20% jitter,
 * never above the 1h cap. Pure: no DB, no clock.
 */

/** Delay before the first retry. */
export const BACKOFF_BASE_MS = 15_000;
/** Hard ceiling on any retry delay (jitter included). */
export const BACKOFF_MAX_MS = 60 * 60_000;
/** Jitter as a fraction of the base delay (±). */
export const BACKOFF_JITTER = 0.2;

/**
 * Delay before retrying a job whose `attempt`-th run failed.
 * @param attempt 1-based attempt number that just failed (values < 1 are treated as 1)
 * @param rng uniform random source in [0, 1); injectable for deterministic tests
 * @returns delay in ms: base `15s·2^(attempt−1)` capped at 1h, scaled by a factor in [0.8, 1.2), then capped at 1h again
 */
export function retryDelayMs(attempt: number, rng: () => number = Math.random): number {
  const n = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  // 2^(n-1) overflows to Infinity for huge n; Math.min handles that.
  const base = Math.min(BACKOFF_BASE_MS * 2 ** (n - 1), BACKOFF_MAX_MS);
  const r = Math.min(Math.max(rng(), 0), 1);
  const factor = 1 + (r * 2 - 1) * BACKOFF_JITTER;
  return Math.min(Math.round(base * factor), BACKOFF_MAX_MS);
}
