import "server-only";
// OWNER: 3.1

/**
 * Interim watchdog (V2-03 §2.9; master plan §1.2 "Interim and watchdog"). The pipeline starts one
 * per agent run: if nothing has been sent `ms` after the run started, it fires once (the turn
 * sends one interim bubble through `input.interim`, which is a no-op when the agent's
 * `send_interim` tool already sent one). Plain `setTimeout`, so Jest fake timers drive it.
 */

/** Handle of a running watchdog. */
export interface Watchdog {
  /** Stop the timer (idempotent; a fire already in flight still completes). */
  cancel(): void;
  /** Whether the timer has fired. */
  fired(): boolean;
}

/**
 * Starts a one-shot watchdog.
 * @param ms delay before firing (e.g. `PIPELINE.watchdogMs`)
 * @param fire called at most once; a rejection is logged, never thrown
 * @returns cancel / fired handle
 */
export function startWatchdog(ms: number, fire: () => Promise<void>): Watchdog {
  let didFire = false;
  let cancelled = false;
  const timer = setTimeout(() => {
    if (cancelled) return;
    didFire = true;
    void fire().catch((e: unknown) => {
      console.error(`[pipeline] watchdog fire failed: ${e instanceof Error ? e.name : "error"}`);
    });
  }, Math.max(0, ms));
  timer.unref?.();
  return {
    cancel() {
      cancelled = true;
      clearTimeout(timer);
    },
    fired: () => didFire,
  };
}
