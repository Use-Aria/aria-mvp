import "server-only";
// OWNER: 1.3

/**
 * Route table, pricing and cost (master plan §1.6; V2-04 §2.2, §2.5, §2.12).
 *
 * Call sites name a ROUTE (what the call is for); the route pins model, effort, thinking,
 * max_tokens, timeout and the static-prefix cache TTL. Effort and thinking are held constant per
 * route on purpose: the resolved values are rendered into the prompt, so changing them
 * invalidates the cache (V2-04 §2.5 "silent invalidators").
 */

/** What a model call is for. */
export type Route =
  | "chat" // main agent turn (voice + tools)
  | "escalate" // hard scheduling negotiation / repeated tool failures (≤10% of turns)
  | "classify" // email / deadline classification (structured output)
  | "memory" // background fact extraction
  | "summary" // rolling conversation summary
  | "briefing" // daily briefing synthesis
  | "syllabus" // PDF parsing — the Python parser makes the call; TS only prices it
  | "draft" // email drafts (outside the 10% escalation cap; soft cap 20/day)
  | "eval_judge"; // eval harness judge

/** Model ids Aria may call or price. */
export type ModelId = "claude-haiku-5-5" | "claude-sonnet-5-5" | "claude-opus-5-5";

/** Per-route model settings. */
export interface RouteConfig {
  model: ModelId;
  /** Includes thinking tokens. */
  maxTokens: number;
  effort: "low" | "medium" | "high";
  thinking: "adaptive" | "disabled";
  /** Per-request HTTP timeout (ms). */
  timeoutMs: number;
  /** TTL of the BP1 breakpoint on the static system prefix. */
  staticTtl: "5m" | "1h";
}

/** The route table (master plan §1.6). */
export const ROUTES: Readonly<Record<Route, RouteConfig>> = {
  chat: { model: "claude-haiku-5-5", maxTokens: 2048, effort: "low", thinking: "adaptive", timeoutMs: 25_000, staticTtl: "1h" },
  escalate: { model: "claude-sonnet-5-5", maxTokens: 2048, effort: "low", thinking: "adaptive", timeoutMs: 25_000, staticTtl: "5m" },
  classify: { model: "claude-haiku-5-5", maxTokens: 4096, effort: "low", thinking: "disabled", timeoutMs: 30_000, staticTtl: "5m" },
  memory: { model: "claude-haiku-5-5", maxTokens: 2048, effort: "medium", thinking: "adaptive", timeoutMs: 30_000, staticTtl: "5m" },
  summary: { model: "claude-haiku-5-5", maxTokens: 512, effort: "low", thinking: "adaptive", timeoutMs: 20_000, staticTtl: "5m" },
  briefing: { model: "claude-haiku-5-5", maxTokens: 2048, effort: "medium", thinking: "adaptive", timeoutMs: 45_000, staticTtl: "5m" },
  syllabus: { model: "claude-sonnet-5-5", maxTokens: 16_000, effort: "medium", thinking: "adaptive", timeoutMs: 120_000, staticTtl: "5m" },
  draft: { model: "claude-sonnet-5-5", maxTokens: 1500, effort: "low", thinking: "adaptive", timeoutMs: 45_000, staticTtl: "5m" },
  eval_judge: { model: "claude-haiku-5-5", maxTokens: 512, effort: "low", thinking: "adaptive", timeoutMs: 30_000, staticTtl: "5m" },
};

/** $/MTok. `cacheWrite` is the 5-minute write; `cacheWrite1h` the 1-hour write. */
export interface ModelPricing {
  in: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  out: number;
}

/**
 * Anthropic first-party prices, $/MTok (platform.claude.com/docs/en/about-claude/pricing,
 * fetched 2026-10-10). Haiku 5.5 rates are for prompts ≤ 100K tokens; `costFor` applies the
 * 5× long-prompt tier. Sonnet/Opus 5.5 cache reads are 0.05× base input.
 */
export const PRICING: Readonly<Record<ModelId, ModelPricing>> = {
  "claude-haiku-5-5": { in: 0.1, cacheRead: 0.01, cacheWrite: 0.125, cacheWrite1h: 0.2, out: 0.5 },
  "claude-sonnet-5-5": { in: 2, cacheRead: 0.1, cacheWrite: 2.5, cacheWrite1h: 4, out: 10 },
  "claude-opus-5-5": { in: 4, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8, out: 20 },
};

/** Haiku 5.5 prompts above this many input tokens (incl. cache reads/writes) bill at 5×. */
export const HAIKU_LONG_PROMPT_TOKENS = 100_000;
const HAIKU_LONG_PROMPT_MULTIPLIER = 5;

/** Token counts `costFor` prices. `cacheWrite1hTokens` (a subset of `cacheWriteTokens`) is optional. */
export interface CostInput {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Portion of `cacheWriteTokens` written with the 1h TTL; the rest is priced as 5m writes. */
  cacheWrite1hTokens?: number;
}

/**
 * Whether `model` is a model id this module prices.
 * @param model any model string
 * @returns true for a `ModelId`
 */
export function isModelId(model: string): model is ModelId {
  return Object.prototype.hasOwnProperty.call(PRICING, model);
}

/**
 * USD cost of one call (= V2-08's `costForModel`). `inputTokens` is the uncached remainder, as the
 * API reports it. Unknown models cost 0.
 * @param model model id (as sent or as returned by the API)
 * @param u token counts; `cacheWrite1hTokens` splits writes by TTL when known
 * @returns cost in USD (unrounded)
 */
export function costFor(model: string, u: CostInput): number {
  if (!isModelId(model)) return 0;
  const p = PRICING[model];
  const write1h = Math.min(Math.max(u.cacheWrite1hTokens ?? 0, 0), u.cacheWriteTokens);
  const write5m = u.cacheWriteTokens - write1h;
  const promptTokens = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  const mult = model === "claude-haiku-5-5" && promptTokens > HAIKU_LONG_PROMPT_TOKENS ? HAIKU_LONG_PROMPT_MULTIPLIER : 1;
  return (
    (mult *
      (u.inputTokens * p.in +
        u.cacheReadTokens * p.cacheRead +
        write5m * p.cacheWrite +
        write1h * p.cacheWrite1h +
        u.outputTokens * p.out)) /
    1_000_000
  );
}
