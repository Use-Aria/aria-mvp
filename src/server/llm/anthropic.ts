import "server-only";
// OWNER: 1.3

/**
 * Anthropic transport: one `messages.create` call → `LlmResponse`, typed error mapping, and an
 * `llm_calls` row for every attempt (success, refusal or failure). Dependencies are injectable so
 * the flow is unit-testable without the network.
 */
import Anthropic from "@anthropic-ai/sdk";
import { LlmBadRequestError, LlmUnavailableError } from "@/server/llm/errors";
import { recordLlmCall, type LlmCallRecord } from "@/server/llm/log";
import { buildAnthropicRequest } from "@/server/llm/request";
import { ROUTES, costFor, type ModelId, type Route } from "@/server/llm/routes";
import type { LlmRequest, LlmResponse, UsageSummary } from "@/server/llm/types";

/** SDK retries once (408/409/429/5xx/connection) before we map the error. */
export const MAX_RETRIES = 1;

/** The slice of the SDK client this module uses. */
export interface MessagesClient {
  create(
    body: Anthropic.MessageCreateParamsNonStreaming,
    opts: { timeout: number; signal?: AbortSignal },
  ): Promise<Anthropic.Message & { _request_id?: string | null }>;
}

/** Injectable dependencies of `callAnthropic`. */
export interface AnthropicDeps {
  client: MessagesClient;
  record: (r: LlmCallRecord) => Promise<void>;
  now: () => number;
}

let sdk: Anthropic | null = null;

/** Lazily construct the SDK client (reads ANTHROPIC_API_KEY on first use, not at import). */
function sdkClient(): Anthropic {
  if (!sdk) sdk = new Anthropic({ maxRetries: MAX_RETRIES });
  return sdk;
}

const defaultDeps: AnthropicDeps = {
  client: { create: (body, opts) => sdkClient().messages.create(body, opts) },
  record: recordLlmCall,
  now: () => Date.now(),
};

/**
 * Normalize API usage to a `UsageSummary` (prices 1h cache writes at the 1h rate).
 * @param model model id used for pricing
 * @param u API usage
 * @returns the summary incl. cost
 */
export function toUsageSummary(model: string, u: Anthropic.Usage): UsageSummary {
  const base = {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
  return {
    ...base,
    thinkingTokens: u.output_tokens_details?.thinking_tokens ?? 0,
    costUsd: costFor(model, { ...base, cacheWrite1hTokens: u.cache_creation?.ephemeral_1h_input_tokens ?? 0 }),
  };
}

/** Zero usage (failed calls). */
export const ZERO_USAGE: UsageSummary = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  thinkingTokens: 0,
  costUsd: 0,
});

/**
 * Map an SDK failure to an LLM error, plus a short code for `llm_calls.error`.
 * Aborts (caller's signal) and non-SDK errors pass through unchanged.
 * @param err thrown value
 * @returns the error to throw and its log code
 */
export function mapLlmError(err: unknown): { error: unknown; code: string } {
  if (err instanceof Anthropic.APIUserAbortError) return { error: err, code: "aborted" };
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return { error: new LlmUnavailableError("anthropic timeout", { cause: err }), code: "timeout" };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { error: new LlmUnavailableError("anthropic connection error", { cause: err }), code: "connection" };
  }
  if (err instanceof Anthropic.APIError && typeof err.status === "number") {
    const s = err.status;
    if (s === 408 || s === 409 || s === 429 || s >= 500) {
      return { error: new LlmUnavailableError(`anthropic unavailable (${s})`, { status: s, cause: err }), code: `unavailable:${s}` };
    }
    return { error: new LlmBadRequestError(`anthropic rejected the request (${s})`, { status: s, cause: err }), code: `bad_request:${s}` };
  }
  return { error: err, code: "unknown" };
}

/**
 * Concatenate a response's text blocks.
 * @param content response content
 * @returns joined text ("" when there is none)
 */
export function textOf(content: readonly Anthropic.ContentBlock[]): string {
  let out = "";
  for (const b of content) if (b.type === "text") out += b.text;
  return out;
}

function devLine(route: Route, model: ModelId, u: UsageSummary, ms: number, stop: string | null): void {
  const env = process.env.NODE_ENV;
  if (env === "production" || env === "test") return;
  console.log(
    `[llm] ${route} ${model} in=${u.inputTokens} cr=${u.cacheReadTokens} cw=${u.cacheWriteTokens} out=${u.outputTokens} think=${u.thinkingTokens} $${u.costUsd.toFixed(6)} ${ms}ms ${stop ?? "-"}`,
  );
}

/**
 * Make one Messages API call for a route and log it to `llm_calls`.
 * @param req the request
 * @param deps injectable client/logger/clock (defaults: SDK client, `recordLlmCall`, `Date.now`)
 * @returns the normalized response plus the raw SDK message
 * @throws LlmUnavailableError (retryable) | LlmBadRequestError | the SDK abort error on `req.signal`
 */
export async function callAnthropic(
  req: LlmRequest,
  deps: AnthropicDeps = defaultDeps,
): Promise<{ response: LlmResponse; raw: Anthropic.Message }> {
  const cfg = ROUTES[req.route];
  const model = req.model ?? cfg.model;
  const body = buildAnthropicRequest(req, cfg, model);
  const started = deps.now();
  let raw: Anthropic.Message & { _request_id?: string | null };
  try {
    raw = await deps.client.create(body, { timeout: cfg.timeoutMs, ...(req.signal ? { signal: req.signal } : {}) });
  } catch (err) {
    const mapped = mapLlmError(err);
    const requestId = err instanceof Anthropic.APIError ? (err.requestID ?? undefined) : undefined;
    await deps.record({
      route: req.route,
      model,
      usage: ZERO_USAGE,
      latencyMs: deps.now() - started,
      error: mapped.code,
      ...(requestId ? { requestId } : {}),
      ...req.log,
    });
    throw mapped.error;
  }

  const latencyMs = deps.now() - started;
  const usage = toUsageSummary(model, raw.usage);
  const requestId = raw._request_id ?? null;
  const stopReason = raw.stop_reason;
  const response: LlmResponse = {
    model,
    content: raw.content,
    text: textOf(raw.content),
    stopReason,
    refusal: stopReason === "refusal" ? (raw.stop_details ?? null) : null,
    usage,
    latencyMs,
    requestId,
  };
  devLine(req.route, model, usage, latencyMs, stopReason);
  await deps.record({
    route: req.route,
    model,
    usage,
    latencyMs,
    stopReason,
    ...(requestId ? { requestId } : {}),
    ...req.log,
  });
  return { response, raw };
}
