/**
 * callAnthropic flow with a fake client (no network): response normalization, refusals returned,
 * typed error mapping, one `llm_calls` record per attempt; runStructured parse/refusal/truncation;
 * recordLlmCall never throws.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { db } from "@/server/db";
import { callAnthropic, mapLlmError, type AnthropicDeps, type MessagesClient } from "@/server/llm/anthropic";
import { LlmBadRequestError, LlmRefusalError, LlmUnavailableError } from "@/server/llm/errors";
import { LLM_LOG_TIMEOUT_MS, recordLlmCall, type LlmCallRecord } from "@/server/llm/log";
import { runStructured, structuredFormat } from "@/server/llm/structured";

jest.mock("@/server/db", () => ({ db: jest.fn() }));
const dbMock = jest.mocked(db) as unknown as jest.Mock;

const USAGE: Anthropic.Usage = {
  input_tokens: 120,
  output_tokens: 80,
  cache_read_input_tokens: 4000,
  cache_creation_input_tokens: 1000,
  cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 0 },
  output_tokens_details: { thinking_tokens: 30 },
  inference_geo: null,
  server_tool_use: null,
  service_tier: "standard",
};

function message(p: Partial<Anthropic.Message> = {}): Anthropic.Message & { _request_id?: string | null } {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    container: null,
    diagnostics: null,
    content: [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: "hel", citations: null },
      { type: "text", text: "lo", citations: null },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: USAGE,
    _request_id: "req_123",
    ...p,
  };
}

function deps(reply: () => Promise<Anthropic.Message & { _request_id?: string | null }>) {
  const records: LlmCallRecord[] = [];
  const calls: { body: Anthropic.MessageCreateParamsNonStreaming; opts: { timeout: number; signal?: AbortSignal } }[] = [];
  let t = 1000;
  const client: MessagesClient = {
    create: async (body, opts) => {
      calls.push({ body, opts });
      t += 250;
      return reply();
    },
  };
  const d: AnthropicDeps = { client, record: async (r) => void records.push(r), now: () => t };
  return { d, records, calls };
}

describe("callAnthropic", () => {
  it("normalizes the response and logs one row with attribution", async () => {
    const { d, records, calls } = deps(async () => message());
    const { response, raw } = await callAnthropic(
      { route: "chat", system: "S", messages: [{ role: "user", content: "hi" }], log: { userId: "u1", runId: "r1", iteration: 2 } },
      d,
    );
    expect(calls[0].opts.timeout).toBe(25_000);
    expect(calls[0].body.model).toBe("claude-haiku-5-5");
    expect(response.text).toBe("hello");
    expect(response.content).toBe(raw.content); // verbatim, incl. the thinking block
    expect(response.requestId).toBe("req_123");
    expect(response.latencyMs).toBe(250);
    expect(response.refusal).toBeNull();
    expect(response.usage).toMatchObject({ inputTokens: 120, outputTokens: 80, cacheReadTokens: 4000, cacheWriteTokens: 1000, thinkingTokens: 30 });
    // 120*0.1 + 4000*0.01 + 1000*0.2 (1h) + 80*0.5 = 12 + 40 + 200 + 40
    expect(response.usage.costUsd).toBeCloseTo(292e-6, 12);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ route: "chat", model: "claude-haiku-5-5", userId: "u1", runId: "r1", iteration: 2, stopReason: "end_turn", requestId: "req_123", latencyMs: 250 });
    expect(records[0].error).toBeUndefined();
  });

  it("returns refusals (not thrown) with stop_details", async () => {
    const details: Anthropic.RefusalStopDetails = { type: "refusal", category: "cyber", explanation: null };
    const { d, records } = deps(async () => message({ stop_reason: "refusal", stop_details: details, content: [] }));
    const { response } = await callAnthropic({ route: "escalate", system: "S", messages: [{ role: "user", content: "x" }], log: {} }, d);
    expect(response.model).toBe("claude-sonnet-5-5");
    expect(response.refusal).toEqual(details);
    expect(records[0].stopReason).toBe("refusal");
  });

  it("maps provider failures to typed errors and still logs the attempt", async () => {
    const rate = new Anthropic.RateLimitError(429, undefined, "slow down", new Headers());
    const { d, records } = deps(async () => Promise.reject(rate));
    const err = await callAnthropic({ route: "chat", system: "S", messages: [{ role: "user", content: "x" }], log: { jobId: "j1" } }, d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmUnavailableError);
    expect((err as LlmUnavailableError).status).toBe(429);
    expect((err as LlmUnavailableError).retryable).toBe(true);
    expect(records).toEqual([expect.objectContaining({ error: "unavailable:429", jobId: "j1", usage: expect.objectContaining({ costUsd: 0 }) })]);
  });

  it("mapLlmError: 5xx/529/timeout/connection → unavailable; 4xx → bad request; abort passes through", () => {
    const h = new Headers();
    expect(mapLlmError(new Anthropic.InternalServerError(529, undefined, "overloaded", h)).error).toBeInstanceOf(LlmUnavailableError);
    expect(mapLlmError(new Anthropic.APIConnectionTimeoutError()).code).toBe("timeout");
    expect(mapLlmError(new Anthropic.APIConnectionError({ message: "x" })).error).toBeInstanceOf(LlmUnavailableError);
    const bad = mapLlmError(new Anthropic.BadRequestError(400, undefined, "bad", h));
    expect(bad.error).toBeInstanceOf(LlmBadRequestError);
    expect(bad.code).toBe("bad_request:400");
    expect(mapLlmError(new Anthropic.AuthenticationError(401, undefined, "no", h)).error).toBeInstanceOf(LlmBadRequestError);
    const abort = new Anthropic.APIUserAbortError();
    expect(mapLlmError(abort)).toEqual({ error: abort, code: "aborted" });
    const other = new TypeError("boom");
    expect(mapLlmError(other).error).toBe(other);
  });
});

describe("runStructured", () => {
  const Schema = z.strictObject({ label: z.enum(["a", "b"]), score: z.number().min(0).max(1) });

  it("sends the $schema-free format and parses + validates the output", async () => {
    const { d, calls } = deps(async () => message({ content: [{ type: "text", text: '{"label":"a","score":0.5}', citations: null }] }));
    const r = await runStructured({ route: "classify", system: "S", user: "x", schema: Schema, maxTokens: 256 }, d);
    expect(r.data).toEqual({ label: "a", score: 0.5 });
    expect(r.model).toBe("claude-haiku-5-5");
    expect(calls[0].body.max_tokens).toBe(256);
    expect(calls[0].body.thinking).toEqual({ type: "disabled" });
    expect(calls[0].body.output_config?.format?.type).toBe("json_schema");
    expect(JSON.stringify(calls[0].body.output_config)).not.toContain("$schema");
    expect(structuredFormat(Schema)).toBe(structuredFormat(Schema)); // memoized
  });

  it("throws LlmBadRequestError when the output violates constraints the grammar can't express", async () => {
    const { d } = deps(async () => message({ content: [{ type: "text", text: '{"label":"a","score":7}', citations: null }] }));
    await expect(runStructured({ route: "classify", system: "S", user: "x", schema: Schema }, d)).rejects.toBeInstanceOf(LlmBadRequestError);
  });

  it("throws LlmRefusalError on refusal and LlmBadRequestError on max_tokens", async () => {
    const refused = deps(async () => message({ stop_reason: "refusal", stop_details: { type: "refusal", category: "general_harms", explanation: null }, content: [] }));
    const err = await runStructured({ route: "memory", system: "S", user: "x", schema: Schema }, refused.d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmRefusalError);
    expect((err as LlmRefusalError).category).toBe("general_harms");
    const cut = deps(async () => message({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"label":', citations: null }] }));
    await expect(runStructured({ route: "memory", system: "S", user: "x", schema: Schema }, cut.d)).rejects.toThrow(/max_tokens/);
  });
});

describe("recordLlmCall", () => {
  const rec: LlmCallRecord = {
    route: "chat",
    model: "claude-haiku-5-5",
    usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, thinkingTokens: 1, costUsd: 0.0000123456789 },
    latencyMs: 12.6,
    userId: "u1",
    runId: "r1",
    jobId: "j1",
    iteration: 1,
    meta: { attempt: 1 },
  };
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    dbMock.mockReset();
  });
  afterEach(() => warn.mockRestore());

  it("writes the 003 columns", async () => {
    const insert = jest.fn().mockResolvedValue({ error: null });
    dbMock.mockReturnValue({ from: (t: string) => (t === "llm_calls" ? { insert } : null) });
        await recordLlmCall(rec);
    expect(insert).toHaveBeenCalledWith({
      route: "chat",
      model: "claude-haiku-5-5",
      provider: "anthropic",
      input_tokens: 1,
      output_tokens: 2,
      cache_read: 3,
      cache_write: 4,
      thinking_tokens: 1,
      cost_usd: 0.000012,
      latency_ms: 13,
      stop_reason: null,
      error: null,
      request_id: null,
      user_id: "u1",
      run_id: "r1",
      job_id: "j1",
      iteration: 1,
      meta: { attempt: 1 },
    });
  });

  it("never throws: db() throws, insert errors, insert rejects", async () => {
        dbMock.mockImplementation(() => {
      throw new Error("missing env");
    });
    await expect(recordLlmCall(rec)).resolves.toBeUndefined();
    dbMock.mockReturnValue({ from: () => ({ insert: async () => ({ error: { code: "23503" } }) }) });
    await expect(recordLlmCall(rec)).resolves.toBeUndefined();
    dbMock.mockReturnValue({ from: () => ({ insert: () => Promise.reject(new Error("network")) }) });
    await expect(recordLlmCall(rec)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("gives up after the timeout when the insert hangs", async () => {
    jest.useFakeTimers();
    try {
            dbMock.mockReturnValue({ from: () => ({ insert: () => new Promise(() => undefined) }) });
      const p = recordLlmCall(rec);
      await jest.advanceTimersByTimeAsync(LLM_LOG_TIMEOUT_MS);
      await expect(p).resolves.toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });
});
