import "server-only";
// OWNER: 1.2

/**
 * Interim ("one sec") lines for the 8s watchdog and the `send_interim` tool (pure; V2-03 §2.9).
 * The register comes from the shared heuristic (`@/shared/register`, master plan C5).
 */
import { computeRegisterHint, registerClass } from "@/shared/register";

/** The two template registers. */
export type InterimRegister = "casual" | "neutral";

/** Interim lines per register. Short, no promises about timing. */
export const INTERIM_POOLS: Readonly<Record<InterimRegister, readonly string[]>> = {
  casual: ["one sec 👀", "ok lemme check", "hmm lemme look", "on it, one sec", "gimme a sec 👀"],
  neutral: ["give me a sec", "one moment, checking", "let me check on that", "checking now, one sec"],
};

/**
 * Register of the user's recent texts.
 * @param recent the user's own recent texts, oldest first
 * @returns "casual" | "neutral" (no texts → casual, Aria's default voice)
 */
export function detectRegister(recent: string[]): InterimRegister {
  return registerClass(computeRegisterHint(recent));
}

/**
 * Picks an interim line.
 * @param register template register
 * @param rng random source in [0, 1) (seed it in tests)
 * @returns one line from the pool
 */
export function pickInterim(register: InterimRegister, rng: () => number = Math.random): string {
  const pool = INTERIM_POOLS[register];
  const r = rng();
  const i = Math.min(pool.length - 1, Math.max(0, Math.floor((Number.isFinite(r) ? r : 0) * pool.length)));
  return pool[i];
}
