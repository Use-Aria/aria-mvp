import "server-only";
// OWNER: 1.3

/**
 * Best-effort `llm_calls` insert (master plan §1.6; columns per migration 003 §3). Never throws and
 * never blocks a turn for long: the insert races a short timeout. Rows hold counts, ids and
 * codes only — never prompt or response text.
 */
import { db } from "@/server/db";
import type { Database, Json } from "@/server/db/types";
import type { Route } from "@/server/llm/routes";
import type { LlmLogMeta, UsageSummary } from "@/server/llm/types";

type LlmCallInsert = Database["public"]["Tables"]["llm_calls"]["Insert"];

/** Max time `recordLlmCall` waits for the insert before giving up (the insert may still land). */
export const LLM_LOG_TIMEOUT_MS = 1500;

/** Input of `recordLlmCall`. */
export type LlmCallRecord = {
  route: Route;
  model: string;
  usage: UsageSummary;
  latencyMs: number;
  /** Defaults to "anthropic". */
  provider?: string;
  stopReason?: string | null;
  /** Short error code (e.g. "unavailable:429"); never a provider message body. */
  error?: string;
  requestId?: string;
} & LlmLogMeta;

/**
 * Map a record to an `llm_calls` insert row. Pure.
 * @param r the call record
 * @returns the row
 */
export function toLlmCallRow(r: LlmCallRecord): LlmCallInsert {
  return {
    route: r.route,
    model: r.model,
    provider: r.provider ?? "anthropic",
    input_tokens: r.usage.inputTokens,
    output_tokens: r.usage.outputTokens,
    cache_read: r.usage.cacheReadTokens,
    cache_write: r.usage.cacheWriteTokens,
    thinking_tokens: r.usage.thinkingTokens,
    cost_usd: Math.round(r.usage.costUsd * 1e6) / 1e6, // numeric(10,6)
    latency_ms: Math.round(r.latencyMs),
    stop_reason: r.stopReason ?? null,
    error: r.error ?? null,
    request_id: r.requestId ?? null,
    user_id: r.userId ?? null,
    run_id: r.runId ?? null,
    job_id: r.jobId ?? null,
    iteration: r.iteration ?? null,
    meta: (r.meta ?? null) as Json | null,
  };
}

/**
 * Insert one `llm_calls` row. Best-effort: logs a warning (code only) on failure, never throws.
 * @param r route, model, usage, latency, outcome and attribution
 * @returns resolves when the row is written, the insert failed, or the timeout passed
 */
export async function recordLlmCall(r: LlmCallRecord): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const row = toLlmCallRow(r);
    const insert = (async () => {
      const { error } = await db().from("llm_calls").insert(row);
      if (error) console.warn(`[llm] llm_calls insert failed: ${error.code ?? "unknown"}`);
    })();
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        console.warn("[llm] llm_calls insert timed out");
        resolve();
      }, LLM_LOG_TIMEOUT_MS);
    });
    await Promise.race([insert.catch(() => console.warn("[llm] llm_calls insert threw")), timeout]);
  } catch {
    console.warn("[llm] llm_calls insert skipped");
  } finally {
    if (timer) clearTimeout(timer);
  }
}
