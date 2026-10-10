import "server-only";
// OWNER: 3.2

/**
 * Escalation to Sonnet 5.5 (V2-04 §2.6; master plan §1.2, §8 risk 9).
 *
 * Deterministic rules, no learned router:
 *  - pre-run (decided before the first call, so the whole run stays on one model):
 *    frustration regex, repetition (token Jaccard ≥ 0.6 vs. the student's last 15 min),
 *    scheduling negotiation (third open `find_free_slots` back-and-forth in 30 min, or > 2 explicit
 *    constraints in the new inbound), and stickiness (previous run escalated for scheduling < 10 min
 *    ago and that negotiation is still open);
 *  - mid-run (at most once, never switches back): two failed tool iterations, or the same tool with
 *    the same arguments called twice.
 *
 * The cap is atomic and hard: the `claim_escalation` RPC takes an advisory lock, counts LLM runs
 * (`model is not null and not is_eval`, trailing 7 days, global) and allows the claim iff
 * `(escalated + 1) * 100 ≤ pct * total`; `budgetAllows` mirrors that formula for tests.
 */
import type { PreflightSignals, RecentRun } from "@/server/agent/context/build";
import { ESCALATION_MAX_PCT } from "@/server/agent/config";
import { db } from "@/server/db";
import { optionalEnv } from "@/server/env";

/** Why a run escalated (written to `agent_runs.escalation_reason`). */
export type EscalationReason = "frustration" | "repetition" | "scheduling" | "scheduling_sticky" | "tool_failures";

/** Token-Jaccard threshold for "the student is repeating themselves". */
export const REPEAT_JACCARD = 0.6;
/** Messages shorter than this (in distinct tokens) never count as a repetition. */
const REPEAT_MIN_TOKENS = 3;
/** Stickiness window after a scheduling escalation. */
export const STICKY_MS = 10 * 60_000;
/** Open negotiation runs (find_free_slots without create_block) before this run that trigger escalation. */
const NEGOTIATION_RUNS = 2;
/** Explicit scheduling constraints in the new inbound above which the run escalates. */
const MAX_CONSTRAINTS = 2;
/** Failed tool iterations that trigger a mid-run escalation. */
export const FAILED_ITERATIONS_TO_ESCALATE = 2;

const FRUSTRATION_RES: readonly RegExp[] = [
  /\bthat'?s (?:wrong|not (?:right|what i (?:said|asked|meant)))\b/i,
  /\bi (?:already |just )?(?:said|told you)\b/i,
  /\bwtf\b/i,
  /\bwhat the (?:hell|heck|fuck)\b/i,
  /\bare you (?:even )?(?:listening|serious|kidding)\b/i,
  /\bno+!+/i,
  /\bnot what i (?:said|asked|meant)\b/i,
  /\byou(?:'re| are) (?:not listening|wrong|useless)\b/i,
];

/**
 * Whether one inbound text reads as frustrated: a frustration phrase, two or more `?!`-style
 * bursts, or an all-caps run of ≥ 12 letters.
 * @param text the student's message
 * @returns true when frustrated
 */
export function isFrustrated(text: string): boolean {
  if (FRUSTRATION_RES.some((re) => re.test(text))) return true;
  if ((text.match(/(?:\?+!+|!+\?+)[?!]*/g) ?? []).length >= 2) return true;
  const caps = text.match(/[A-Z][A-Z\s'!?.,]{10,}[A-Z]/g) ?? [];
  return caps.some((run) => run.replace(/[^A-Z]/g, "").length >= 12);
}

/** Lowercased word tokens (letters, digits, apostrophes). */
function tokens(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []).map((t) => t.replace(/'/g, "")).filter((t) => t.length > 0));
}

/**
 * Token-set Jaccard similarity of two texts.
 * @param a first text
 * @param b second text
 * @returns |A∩B| / |A∪B| in [0, 1] (0 when both are empty)
 */
export function tokenJaccard(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 && tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

const CONSTRAINT_RES: readonly RegExp[] = [
  // time windows / relational times: "between 2 and 5", "from 3 to 6", "after 5", "not before 10am", "by noon"
  /\bbetween\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s+and\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?/gi,
  /\bfrom\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*(?:to|-|until|till)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?/gi,
  /\b(?:not\s+)?(?:before|after|by|until|till|past)\s+(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|noon|midnight|lunch|dinner|class)\b/gi,
  // durations: "2 hours", "90 min", "2h", "an hour"
  /\b(?:\d+(?:\.\d+)?\s*(?:hours?|hrs?|h|minutes?|mins?|m)|an?\s+hour|half\s+an?\s+hour)\b/gi,
  // days: weekdays, today/tonight/tomorrow, weekend
  /\b(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?s?\b/gi,
  /\b(?:today|tonight|tomorrow|tmrw|tmr|this weekend|next week|weekend)\b/gi,
];

/**
 * Number of explicit scheduling constraints (time windows, durations, days) in a text.
 * @param text the student's message
 * @returns count of distinct constraint mentions
 */
export function countConstraints(text: string): number {
  const found = new Set<string>();
  for (const re of CONSTRAINT_RES) {
    for (const m of text.matchAll(re)) found.add(m[0].toLowerCase().replace(/\s+/g, " ").trim());
  }
  return found.size;
}

/** A run left a scheduling negotiation open: it searched slots and didn't create a block. */
function opensNegotiation(r: RecentRun): boolean {
  return r.toolNames.includes("find_free_slots") && !r.toolNames.includes("create_block");
}

/**
 * Open scheduling-negotiation runs since the last `create_block` (V2-04 §2.6 counter).
 * @param runs this user's recent runs, newest first
 * @returns number of consecutive (newest-first) runs that searched slots without booking
 */
export function openNegotiationRuns(runs: readonly RecentRun[]): number {
  let n = 0;
  for (const r of runs) {
    if (r.toolNames.includes("create_block")) break;
    if (opensNegotiation(r)) n++;
  }
  return n;
}

/**
 * Pre-run escalation rules. Checked in order: stickiness, frustration, repetition, scheduling.
 * @param s signals from the context builder (`BuiltContext.signals`)
 * @param now the run's clock
 * @returns the reason to escalate, or null to stay on Haiku
 */
export function preflightEscalation(s: PreflightSignals, now: Date): EscalationReason | null {
  const last = s.recentRuns[0];
  if (
    last &&
    last.escalated &&
    (last.escalationReason === "scheduling" || last.escalationReason === "scheduling_sticky") &&
    now.getTime() - last.startedAt.getTime() < STICKY_MS &&
    openNegotiationRuns(s.recentRuns) > 0
  ) {
    return "scheduling_sticky";
  }
  if (s.newTexts.some(isFrustrated)) return "frustration";
  for (const t of s.newTexts) {
    if (tokens(t).size < REPEAT_MIN_TOKENS) continue;
    if (s.recentUserTexts.some((r) => tokens(r.text).size >= REPEAT_MIN_TOKENS && tokenJaccard(t, r.text) >= REPEAT_JACCARD)) {
      return "repetition";
    }
  }
  if (openNegotiationRuns(s.recentRuns) >= NEGOTIATION_RUNS) return "scheduling";
  if (s.newTexts.some((t) => countConstraints(t) > MAX_CONSTRAINTS)) return "scheduling";
  return null;
}

/** Mid-run signals tracked by the loop. */
export interface IterationStats {
  /** tool-executing iterations that returned at least one counted `is_error` result */
  failedIterations: number;
  /** the same tool with the same arguments was called twice in this run */
  repeatedCall: boolean;
}

/**
 * Mid-run escalation rule: two failed tool iterations, or a repeated identical call.
 * @param s the loop's iteration stats
 * @returns "tool_failures" or null
 */
export function midRunEscalation(s: IterationStats): EscalationReason | null {
  return s.failedIterations >= FAILED_ITERATIONS_TO_ESCALATE || s.repeatedCall ? "tool_failures" : null;
}

/**
 * Mirror of the `claim_escalation` SQL cap (the current run is included in `total`).
 * @param escalated escalated LLM runs in the window
 * @param total LLM runs in the window, including the current one
 * @param pct cap percentage
 * @returns true when one more escalation fits the cap
 */
export function budgetAllows(escalated: number, total: number, pct: number): boolean {
  return (escalated + 1) * 100 <= pct * total;
}

/**
 * Escalation cap from `AGENT_ESCALATION_CAP_PCT` (integer 0–100), default 10.
 * @returns the cap percentage
 */
export function escalationCapPct(): number {
  const raw = optionalEnv("AGENT_ESCALATION_CAP_PCT");
  if (raw === undefined || raw.trim() === "") return ESCALATION_MAX_PCT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 100) return ESCALATION_MAX_PCT;
  return n;
}

/**
 * Atomically claim an escalation for a run via the `claim_escalation` RPC. On success the RPC sets
 * `agent_runs.escalated` and `escalation_reason`. The run's `model` must already be written so the
 * RPC counts it. Never throws: an RPC error is logged and treated as "not allowed".
 * @param runId the `agent_runs` id
 * @param reason why the run escalates
 * @param pct cap percentage (default `escalationCapPct()`)
 * @returns true when the escalation was granted
 */
export async function claimEscalation(runId: string, reason: EscalationReason, pct: number = escalationCapPct()): Promise<boolean> {
  try {
    const { data, error } = await db().rpc("claim_escalation", { p_run: runId, p_reason: reason, p_pct: pct });
    if (error) {
      console.warn("agent.escalation: claim failed", { runId, code: error.code });
      return false;
    }
    return data === true;
  } catch (e) {
    console.warn("agent.escalation: claim threw", { runId, error: e instanceof Error ? e.name : "error" });
    return false;
  }
}
