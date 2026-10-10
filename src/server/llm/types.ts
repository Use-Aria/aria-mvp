import "server-only";
// OWNER: 1.3

/**
 * Request/response contracts of the LLM module (master plan §1.6 = V2-04 §7.1). Re-exported from
 * `@/server/llm`; import from there.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { JsonValue } from "@/server/timeline/types";
import type { ModelId, Route } from "@/server/llm/routes";

/** Token + cost summary of one model call. */
export interface UsageSummary {
  /** Uncached input remainder (API `input_tokens`). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Subset of `outputTokens` spent on thinking. */
  thinkingTokens: number;
  costUsd: number;
}

/** Attribution written to `llm_calls` with every call. `meta` must never hold content. */
export interface LlmLogMeta {
  userId?: string;
  runId?: string;
  jobId?: string;
  iteration?: number;
  meta?: Record<string, JsonValue>;
}

/** One model call. */
export interface LlmRequest {
  route: Route;
  /** Override the route's model (same effort/thinking/TTL settings). */
  model?: ModelId;
  /** Static, byte-stable prefix. Gets BP1 with the route's `staticTtl`. */
  system: string;
  /** Deterministic registry order (part of the cached prefix). */
  tools?: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
  outputFormat?: Anthropic.JSONOutputFormat;
  /** Sent only when set (a change invalidates the messages cache). */
  toolChoice?: Anthropic.ToolChoice;
  /** Index of the last history message: BP2 (5m) goes on its last cacheable block. */
  historyBreakpointIndex?: number;
  /** Top-level automatic breakpoint on the last cacheable block (BP3, 5m). */
  autoCacheTail?: boolean;
  /** Override the route's `maxTokens` (e.g. `runStructured`). */
  maxTokens?: number;
  log: LlmLogMeta;
  signal?: AbortSignal;
}

/** Result of one model call. Refusals are returned, not thrown. */
export interface LlmResponse {
  model: ModelId;
  /** Verbatim (incl. thinking blocks) — append as-is to continue a tool loop. */
  content: Anthropic.ContentBlock[];
  /** All text blocks joined. */
  text: string;
  stopReason: Anthropic.StopReason | null;
  /** `stop_details` when `stopReason === "refusal"`, else null. */
  refusal: Anthropic.RefusalStopDetails | null;
  usage: UsageSummary;
  latencyMs: number;
  requestId: string | null;
}
