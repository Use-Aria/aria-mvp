import "server-only";
// OWNER: 1.3

/**
 * Pure request builder (V2-04 §2.5, §7.1 `buildAnthropicRequest`).
 *
 * Breakpoints (render order tools → system → messages; the API allows 4):
 *  - BP1 on `system[0]` with the route's static TTL (caches tools + system);
 *  - BP2 (5m) on the last cacheable block of `messages[historyBreakpointIndex]`;
 *  - BP3 top-level automatic `cache_control` (5m) when `autoCacheTail`.
 * 1h entries must precede 5m entries; BP1 is always first, so that holds.
 * Never sends temperature/top_p/top_k or an assistant prefill (400 on the 5.5 models).
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { ModelId, RouteConfig } from "@/server/llm/routes";
import type { LlmRequest } from "@/server/llm/types";

/** API maximum of cache breakpoints per request. */
export const MAX_BREAKPOINTS = 4;

const EPHEMERAL_5M: Anthropic.CacheControlEphemeral = { type: "ephemeral", ttl: "5m" };

/**
 * Thinking config for a route mode on a model. "disabled" maps per model: Haiku 5.5 accepts
 * `{type:"disabled"}` (effort ≤ high); Sonnet 5.5 400s on it and takes `{type:"between_tools"}`;
 * Opus 5.5 can't disable thinking at all, so it stays adaptive. Display stays `omitted`.
 * @param model target model
 * @param mode the route's thinking mode
 * @returns the `thinking` request param
 */
export function thinkingFor(model: ModelId, mode: RouteConfig["thinking"]): Anthropic.ThinkingConfigParam {
  if (mode === "disabled") {
    if (model === "claude-haiku-5-5") return { type: "disabled" };
    if (model === "claude-sonnet-5-5") return { type: "between_tools" };
  }
  return { type: "adaptive", display: "omitted" };
}

/** Block types that can't carry `cache_control`. */
function isUncacheable(block: Anthropic.ContentBlockParam): boolean {
  return block.type === "thinking" || block.type === "redacted_thinking";
}

/**
 * Copy of `msg` with BP2 on its last cacheable block (the caller's array is never mutated —
 * the agent loop relies on an append-only history).
 */
function withHistoryBreakpoint(msg: Anthropic.MessageParam): Anthropic.MessageParam {
  if (typeof msg.content === "string") {
    return { ...msg, content: [{ type: "text", text: msg.content, cache_control: EPHEMERAL_5M }] };
  }
  const blocks = [...msg.content];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (isUncacheable(b)) continue;
    blocks[i] = { ...b, cache_control: EPHEMERAL_5M } as Anthropic.ContentBlockParam;
    return { ...msg, content: blocks };
  }
  throw new Error("buildAnthropicRequest: history breakpoint message has no cacheable block");
}

/** Count `cache_control` markers the caller already put on tools or message blocks. */
function countExistingBreakpoints(req: LlmRequest): number {
  let n = 0;
  for (const t of req.tools ?? []) if (t.cache_control) n++;
  for (const m of req.messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) if ("cache_control" in b && b.cache_control) n++;
  }
  return n;
}

/**
 * Build the Messages API body for one call. Pure.
 * @param req the LLM request
 * @param cfg the route's config
 * @param model resolved model (`req.model ?? cfg.model`)
 * @returns non-streaming create params
 * @throws Error on an out-of-range `historyBreakpointIndex` or more than 4 breakpoints
 */
export function buildAnthropicRequest(req: LlmRequest, cfg: RouteConfig, model: ModelId): Anthropic.MessageCreateParamsNonStreaming {
  let messages = req.messages;
  let breakpoints = 1 + countExistingBreakpoints(req);

  if (req.historyBreakpointIndex !== undefined) {
    const i = req.historyBreakpointIndex;
    if (!Number.isInteger(i) || i < 0 || i >= messages.length) {
      throw new Error(`buildAnthropicRequest: historyBreakpointIndex ${i} out of range`);
    }
    messages = [...messages];
    messages[i] = withHistoryBreakpoint(messages[i]);
    breakpoints++;
  }
  if (req.autoCacheTail) breakpoints++;
  if (breakpoints > MAX_BREAKPOINTS) {
    throw new Error(`buildAnthropicRequest: ${breakpoints} cache breakpoints (max ${MAX_BREAKPOINTS})`);
  }

  const outputConfig: Anthropic.OutputConfig = { effort: cfg.effort };
  if (req.outputFormat) outputConfig.format = req.outputFormat;

  return {
    model,
    max_tokens: req.maxTokens ?? cfg.maxTokens,
    thinking: thinkingFor(model, cfg.thinking),
    output_config: outputConfig,
    system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral", ttl: cfg.staticTtl } }],
    ...(req.tools && req.tools.length > 0 ? { tools: req.tools } : {}),
    ...(req.toolChoice ? { tool_choice: req.toolChoice } : {}),
    ...(req.autoCacheTail ? { cache_control: EPHEMERAL_5M } : {}),
    messages,
  };
}
