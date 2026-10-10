/**
 * Request builder + routes + pricing (V2-04 §10.1 `tests/unit/llm/request.test.ts`).
 */
import type Anthropic from "@anthropic-ai/sdk";
import { MAX_BREAKPOINTS, buildAnthropicRequest, thinkingFor } from "@/server/llm/request";
import { PRICING, ROUTES, costFor, type Route } from "@/server/llm/routes";
import type { LlmRequest } from "@/server/llm/types";

const HISTORY: Anthropic.MessageParam[] = [
  { role: "user", content: "<aria_profile>…</aria_profile>" },
  { role: "assistant", content: "hey" },
  { role: "user", content: [{ type: "text", text: "earlier" }] },
  { role: "assistant", content: [{ type: "text", text: "earlier reply" }] },
  { role: "user", content: "<aria_now>…</aria_now><new_messages>…</new_messages>" },
];

function req(p: Partial<LlmRequest> = {}): LlmRequest {
  return { route: "chat", system: "STATIC", messages: HISTORY, log: {}, ...p };
}

/** Every cache_control in render order (tools → system → messages), plus the top-level one last. */
function breakpoints(body: Anthropic.MessageCreateParamsNonStreaming): Anthropic.CacheControlEphemeral[] {
  const out: Anthropic.CacheControlEphemeral[] = [];
  for (const t of body.tools ?? []) if ("cache_control" in t && t.cache_control) out.push(t.cache_control);
  if (Array.isArray(body.system)) for (const b of body.system) if (b.cache_control) out.push(b.cache_control);
  for (const m of body.messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) if ("cache_control" in b && b.cache_control) out.push(b.cache_control);
  }
  if (body.cache_control) out.push(body.cache_control);
  return out;
}

describe("ROUTES (§1.6)", () => {
  it("matches the route table", () => {
    expect(ROUTES.chat).toEqual({ model: "claude-haiku-5-5", maxTokens: 2048, effort: "low", thinking: "adaptive", timeoutMs: 25_000, staticTtl: "1h" });
    expect(ROUTES.escalate).toMatchObject({ model: "claude-sonnet-5-5", effort: "low", thinking: "adaptive", maxTokens: 2048, staticTtl: "5m" });
    expect(ROUTES.classify).toMatchObject({ model: "claude-haiku-5-5", effort: "low", thinking: "disabled", maxTokens: 4096 });
    expect(ROUTES.memory).toMatchObject({ model: "claude-haiku-5-5", effort: "medium", maxTokens: 2048 });
    expect(ROUTES.summary).toMatchObject({ model: "claude-haiku-5-5", effort: "low", maxTokens: 512 });
    expect(ROUTES.briefing).toMatchObject({ model: "claude-haiku-5-5", effort: "medium", maxTokens: 2048 });
    expect(ROUTES.syllabus).toMatchObject({ model: "claude-sonnet-5-5", effort: "medium", maxTokens: 16_000 });
    expect(ROUTES.draft).toMatchObject({ model: "claude-sonnet-5-5", effort: "low", maxTokens: 1500 });
    expect(ROUTES.eval_judge).toMatchObject({ model: "claude-haiku-5-5", effort: "low", maxTokens: 512 });
  });
});

describe("buildAnthropicRequest", () => {
  it("BP1 on system[0] with ttl 1h (chat) / 5m (escalate)", () => {
    const chat = buildAnthropicRequest(req(), ROUTES.chat, "claude-haiku-5-5");
    expect(chat.system).toEqual([{ type: "text", text: "STATIC", cache_control: { type: "ephemeral", ttl: "1h" } }]);
    const esc = buildAnthropicRequest(req({ route: "escalate" }), ROUTES.escalate, "claude-sonnet-5-5");
    expect(esc.system).toEqual([{ type: "text", text: "STATIC", cache_control: { type: "ephemeral", ttl: "5m" } }]);
  });

  it("BP2 on the indexed message's last block, without mutating the caller's history", () => {
    const before = JSON.stringify(HISTORY);
    const body = buildAnthropicRequest(req({ historyBreakpointIndex: 3 }), ROUTES.chat, "claude-haiku-5-5");
    expect(body.messages[3]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "earlier reply", cache_control: { type: "ephemeral", ttl: "5m" } }],
    });
    expect(body.messages[4]).toBe(HISTORY[4]);
    expect(JSON.stringify(HISTORY)).toBe(before);
    const str = buildAnthropicRequest(req({ historyBreakpointIndex: 1 }), ROUTES.chat, "claude-haiku-5-5");
    expect(str.messages[1].content).toEqual([{ type: "text", text: "hey", cache_control: { type: "ephemeral", ttl: "5m" } }]);
  });

  it("BP2 skips thinking blocks (they can't carry cache_control)", () => {
    const msgs: Anthropic.MessageParam[] = [
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "a" },
          { type: "thinking", thinking: "", signature: "sig" },
        ],
      },
    ];
    const body = buildAnthropicRequest(req({ messages: msgs, historyBreakpointIndex: 1 }), ROUTES.chat, "claude-haiku-5-5");
    expect(body.messages[1].content).toEqual([
      { type: "text", text: "a", cache_control: { type: "ephemeral", ttl: "5m" } },
      { type: "thinking", thinking: "", signature: "sig" },
    ]);
  });

  it("top-level automatic tail breakpoint only when asked", () => {
    expect(buildAnthropicRequest(req(), ROUTES.chat, "claude-haiku-5-5").cache_control).toBeUndefined();
    expect(buildAnthropicRequest(req({ autoCacheTail: true }), ROUTES.chat, "claude-haiku-5-5").cache_control).toEqual({
      type: "ephemeral",
      ttl: "5m",
    });
  });

  it("never more than 4 breakpoints, and 1h entries precede 5m entries", () => {
    const body = buildAnthropicRequest(req({ historyBreakpointIndex: 3, autoCacheTail: true }), ROUTES.chat, "claude-haiku-5-5");
    const bps = breakpoints(body);
    expect(bps).toHaveLength(3);
    expect(bps.length).toBeLessThanOrEqual(MAX_BREAKPOINTS);
    const ttls = bps.map((b) => b.ttl ?? "5m");
    expect(ttls).toEqual(["1h", "5m", "5m"]);
    expect(ttls.lastIndexOf("1h")).toBeLessThan(ttls.indexOf("5m"));

    const crowded: Anthropic.MessageParam[] = [
      { role: "user", content: [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }] },
      { role: "assistant", content: [{ type: "text", text: "b", cache_control: { type: "ephemeral" } }] },
      { role: "user", content: "c" },
    ];
    expect(() =>
      buildAnthropicRequest(req({ messages: crowded, historyBreakpointIndex: 2, autoCacheTail: true }), ROUTES.chat, "claude-haiku-5-5"),
    ).toThrow(/breakpoints/);
    expect(() => buildAnthropicRequest(req({ historyBreakpointIndex: 9 }), ROUTES.chat, "claude-haiku-5-5")).toThrow(/out of range/);
  });

  it("thinking + effort per route; no sampling params; format and tool_choice pass through", () => {
    const fmt: Anthropic.JSONOutputFormat = { type: "json_schema", schema: { type: "object", properties: {}, additionalProperties: false } };
    const tools: Anthropic.Tool[] = [{ name: "t", description: "d", input_schema: { type: "object" } }];
    const chat = buildAnthropicRequest(req({ outputFormat: fmt, tools, toolChoice: { type: "none" } }), ROUTES.chat, "claude-haiku-5-5");
    expect(chat.thinking).toEqual({ type: "adaptive", display: "omitted" });
    expect(chat.output_config).toEqual({ effort: "low", format: fmt });
    expect(chat.max_tokens).toBe(2048);
    expect(chat.tools).toBe(tools);
    expect(chat.tool_choice).toEqual({ type: "none" });
    for (const k of ["temperature", "top_p", "top_k"]) expect(chat).not.toHaveProperty(k);

    const plain = buildAnthropicRequest(req(), ROUTES.chat, "claude-haiku-5-5");
    expect(plain).not.toHaveProperty("tool_choice");
    expect(plain).not.toHaveProperty("tools");
    expect(plain.output_config).toEqual({ effort: "low" });

    const classify = buildAnthropicRequest(req({ route: "classify" }), ROUTES.classify, "claude-haiku-5-5");
    expect(classify.thinking).toEqual({ type: "disabled" });
    expect(classify.max_tokens).toBe(4096);
    const memory = buildAnthropicRequest(req({ route: "memory", maxTokens: 300 }), ROUTES.memory, "claude-haiku-5-5");
    expect(memory.output_config).toEqual({ effort: "medium" });
    expect(memory.max_tokens).toBe(300);
  });

  it("thinkingFor maps 'disabled' per model (Sonnet → between_tools, Opus stays adaptive)", () => {
    expect(thinkingFor("claude-haiku-5-5", "disabled")).toEqual({ type: "disabled" });
    expect(thinkingFor("claude-sonnet-5-5", "disabled")).toEqual({ type: "between_tools" });
    expect(thinkingFor("claude-opus-5-5", "disabled")).toEqual({ type: "adaptive", display: "omitted" });
    expect(thinkingFor("claude-sonnet-5-5", "adaptive")).toEqual({ type: "adaptive", display: "omitted" });
  });

  it("is byte-stable for identical input", () => {
    const routes: Route[] = ["chat", "escalate", "classify"];
    for (const r of routes) {
      const a = JSON.stringify(buildAnthropicRequest(req({ route: r, historyBreakpointIndex: 2 }), ROUTES[r], ROUTES[r].model));
      const b = JSON.stringify(buildAnthropicRequest(req({ route: r, historyBreakpointIndex: 2 }), ROUTES[r], ROUTES[r].model));
      expect(a).toBe(b);
    }
  });
});

describe("costFor / PRICING", () => {
  it("has 5.5 prices incl. Opus 4/0.2/5/20", () => {
    expect(PRICING["claude-opus-5-5"]).toEqual({ in: 4, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8, out: 20 });
    expect(PRICING["claude-sonnet-5-5"]).toMatchObject({ in: 2, cacheRead: 0.1, cacheWrite: 2.5, out: 10 });
    expect(PRICING["claude-haiku-5-5"]).toMatchObject({ in: 0.1, cacheRead: 0.01, cacheWrite: 0.125, cacheWrite1h: 0.2, out: 0.5 });
  });

  it("matches hand-computed values with the cache read/write split", () => {
    // Haiku: 1000 in, 8000 read, 2000 write (5m), 300 out
    // = (1000*0.1 + 8000*0.01 + 2000*0.125 + 300*0.5) / 1e6 = (100 + 80 + 250 + 150) / 1e6
    expect(costFor("claude-haiku-5-5", { inputTokens: 1000, cacheReadTokens: 8000, cacheWriteTokens: 2000, outputTokens: 300 })).toBeCloseTo(580e-6, 12);
    // same, but 1500 of the writes are 1h: 500*0.125 + 1500*0.2 = 62.5 + 300
    expect(
      costFor("claude-haiku-5-5", { inputTokens: 1000, cacheReadTokens: 8000, cacheWriteTokens: 2000, cacheWrite1hTokens: 1500, outputTokens: 300 }),
    ).toBeCloseTo((100 + 80 + 362.5 + 150) / 1e6, 12);
    // Sonnet: 2000 in, 10000 read, 0 write, 500 out = 4000 + 1000 + 5000
    expect(costFor("claude-sonnet-5-5", { inputTokens: 2000, cacheReadTokens: 10_000, cacheWriteTokens: 0, outputTokens: 500 })).toBeCloseTo(0.01, 12);
    // Opus: 1M in + 1M out = 4 + 20
    expect(costFor("claude-opus-5-5", { inputTokens: 1e6, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1e6 })).toBeCloseTo(24, 9);
    expect(costFor("gpt-6", { inputTokens: 1e6, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1e6 })).toBe(0);
  });

  it("applies Haiku's 5× tier above 100K prompt tokens (incl. cache tokens)", () => {
    const at = costFor("claude-haiku-5-5", { inputTokens: 50_000, cacheReadTokens: 50_000, cacheWriteTokens: 0, outputTokens: 0 });
    expect(at).toBeCloseTo((50_000 * 0.1 + 50_000 * 0.01) / 1e6, 12);
    const over = costFor("claude-haiku-5-5", { inputTokens: 50_001, cacheReadTokens: 50_000, cacheWriteTokens: 0, outputTokens: 1000 });
    expect(over).toBeCloseTo((5 * (50_001 * 0.1 + 50_000 * 0.01 + 1000 * 0.5)) / 1e6, 12);
  });
});
