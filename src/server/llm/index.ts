import "server-only";
// OWNER: 1.3

/**
 * Aria V2 — LLM access layer (master plan §1.6; V2-04 §7.1). Every model call goes through here.
 *
 * Call sites name a ROUTE (what the call is for); `ROUTES` maps it to model, effort, thinking,
 * max_tokens, timeout and cache TTL, so model/cost decisions live in one place. Every call writes
 * one `llm_calls` row (best-effort).
 *
 *   callModel     — full control: tools, output format, tool_choice, cache breakpoints (agent loop)
 *   runStructured — one zod-validated structured-output call (classify, memory, briefing, …)
 *   runModel      — legacy plain-text helper (signature kept; now logs)
 *   recordLlmCall — log a call made elsewhere (the Python parser's syllabus calls)
 *   withLlmCostScope — attribute logged call costs to a scope (agent loop: tool-internal calls)
 */
import type Anthropic from "@anthropic-ai/sdk";
import { callAnthropic } from "@/server/llm/anthropic";
import type { Route } from "@/server/llm/routes";
import type { LlmLogMeta, LlmRequest, LlmResponse } from "@/server/llm/types";

export { ROUTES, PRICING, costFor, isModelId, HAIKU_LONG_PROMPT_TOKENS } from "@/server/llm/routes";
export type { Route, ModelId, RouteConfig, ModelPricing, CostInput } from "@/server/llm/routes";
export type { UsageSummary, LlmLogMeta, LlmRequest, LlmResponse } from "@/server/llm/types";
export { LlmUnavailableError, LlmBadRequestError, LlmRefusalError } from "@/server/llm/errors";
export { recordLlmCall } from "@/server/llm/log";
export type { LlmCallRecord } from "@/server/llm/log";
export { withLlmCostScope, reportLlmCost } from "@/server/llm/cost-scope";
export { runStructured, structuredFormat } from "@/server/llm/structured";
export type { StructuredInput, StructuredResult } from "@/server/llm/structured";
export { jsonSchemaFor } from "@/server/llm/schema";

/**
 * One Messages API call (tools, `output_config.format`, `tool_choice`, cache breakpoints).
 * Refusals are returned in `refusal`, not thrown. Logs to `llm_calls`.
 * @param req the request
 * @returns normalized response (content verbatim, incl. thinking blocks)
 * @throws LlmUnavailableError (retryable) | LlmBadRequestError | the SDK abort error on `req.signal`
 */
export async function callModel(req: LlmRequest): Promise<LlmResponse> {
  return (await callAnthropic(req)).response;
}

/** Input of the legacy `runModel`. */
export interface RunInput {
  route: Route;
  /** stable prefix — cached across turns */
  system: string;
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
}

/** Result of the legacy `runModel`. */
export interface RunResult {
  text: string;
  stopReason: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
  };
  raw: Anthropic.Message;
}

/**
 * Run one model call for a route and return its text (legacy helper; signature unchanged).
 * The system prompt gets BP1 with the route's TTL. Now logs to `llm_calls`.
 * @param input route, system prompt, messages, optional tools, optional attribution
 * @returns text, stop reason, usage and the raw SDK message
 * @throws LlmUnavailableError | LlmBadRequestError
 */
export async function runModel(input: RunInput & { log?: LlmLogMeta }): Promise<RunResult> {
  const { response, raw } = await callAnthropic({
    route: input.route,
    system: input.system,
    messages: input.messages,
    ...(input.tools ? { tools: input.tools } : {}),
    log: input.log ?? {},
  });
  const u = response.usage;
  return {
    text: response.text,
    stopReason: response.stopReason,
    usage: {
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens,
      cacheWriteTokens: u.cacheWriteTokens,
      costUsd: u.costUsd,
    },
    raw,
  };
}
