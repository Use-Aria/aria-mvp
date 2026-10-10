import "server-only";
// OWNER: 1.3

/**
 * Agent constants (V2-04 §7.2 `config.ts`, §2.5, §2.6, §8.3). Pure values only.
 */

/** Model ⇄ tool iterations before the forced final call (`tool_choice: none`). */
export const MAX_TOOL_ITERATIONS = 6;
/** Interim watchdog: send one "on it" bubble if the run is still going after this long. */
export const INTERIM_WATCHDOG_MS = 8000;
/** History window bounds (messages). */
export const WINDOW_MIN = 20;
export const WINDOW_MAX = 30;
/** Hard cap if the summary job lags. */
export const WINDOW_HARD_MAX = 40;
/** Token budgets of the per-user context blocks (estimated with `estimateTokens`). */
export const BUDGET = Object.freeze({ profile: 400, prefs: 600, agenda: 500, summary: 300 });
/** Max active preference rows rendered into context. */
export const PREFS_MAX_ROWS = 30;
/** Per-tool execution timeout. */
export const TOOL_TIMEOUT_MS = 10_000;
/** A gap this long (minutes) starts a new conversation. */
export const CONVERSATION_GAP_MIN = 30;
/** Serialized `ToolResult` cap (chars). */
export const MAX_TOOL_RESULT_CHARS = 6000;
/** Reply plan caps (a link counts toward the bubble cap). */
export const MAX_BUBBLES = 3;
export const MAX_REACTIONS = 2;
/** Escalation to Sonnet is capped at this percentage of LLM turns. */
export const ESCALATION_MAX_PCT = 10;
