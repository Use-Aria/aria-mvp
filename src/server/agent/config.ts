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
/** Per-tool execution timeout (default; see `TOOL_TIMEOUT_OVERRIDES_MS`). */
export const TOOL_TIMEOUT_MS = 10_000;
/**
 * Per-tool timeouts that differ from `TOOL_TIMEOUT_MS`. `confirm_action` runs the pending-action
 * executor inline: a Gmail send is a token refresh + `messages.send` + (after a transient error)
 * a Sent-folder check, each up to 25s. Budget: the agent's signal aborts 30s before the 270s run
 * deadline (240s), and a confirm usually comes in the first response (one ≤25s model call, ≤50s
 * with the SDK retry), so 90s + the final call still fit under Vercel's 300s `maxDuration`. The
 * loop also stops waiting when the run's signal aborts.
 */
export const TOOL_TIMEOUT_OVERRIDES_MS: Readonly<Record<string, number>> = Object.freeze({ confirm_action: 90_000 });
/**
 * Results the loop gives the model when a tool whose side effect keeps running in the background
 * times out — not a retryable error, so the model doesn't redo it. `confirm_action` posts the
 * outcome into the chat itself when it finishes late.
 */
export const TOOL_IN_PROGRESS_RESULT: Readonly<Record<string, string>> = Object.freeze({
  confirm_action:
    "in_progress: still sending. It is NOT a failure: don't call confirm_action again and don't redo it. Tell the student it's still going through and that you'll confirm when it's done.",
});
/** A gap this long (minutes) starts a new conversation. */
export const CONVERSATION_GAP_MIN = 30;
/** Serialized `ToolResult` cap (chars). */
export const MAX_TOOL_RESULT_CHARS = 6000;
/** Reply plan caps (a link counts toward the bubble cap). */
export const MAX_BUBBLES = 3;
export const MAX_REACTIONS = 2;
/** Escalation to Sonnet is capped at this percentage of LLM turns. */
export const ESCALATION_MAX_PCT = 10;
