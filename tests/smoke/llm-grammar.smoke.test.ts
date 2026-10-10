/**
 * Live structured-output grammar check (Wave 3 gate fix). OPT-IN: runs only with `SMOKE_LLM=1` and
 * `ANTHROPIC_API_KEY` set; otherwise the suite is skipped.
 *
 * Why: the API compiles every strict tool schema plus the `output_config.format` schema into one
 * grammar per request and 400s ("compiled grammar is too large") past an undisclosed size. The
 * unit-level `strictBudget` counts tools/optional params/unions, not grammar size, so only a real
 * request proves the agent's request is accepted.
 *
 * What: one `chat`-route call built by the production code, not a hand copy:
 * `assembleTurnContext` (static system prompt + `TOOLS` schemas + per-user blocks) → `runLoop`,
 * whose first `LlmRequest` (with `REPLY_FORMAT`) goes through `callModel` with `maxTokens` capped
 * at 256; the loop is then stopped. Asserts the call isn't a 400 and that exactly one `llm_calls`
 * row was logged (tagged via `meta.smoke_run`, no user/run ids), then deletes that row.
 *
 * Cost: ~ $0.005 per run (Haiku 5.5: the ~24k-token static prefix, tools + system, is written to the
 * 1h cache at $0.20/MTok; a re-run within the hour reads it at $0.01/MTok, ~ $0.0003; + ≤256 output
 * tokens). Measured 2026-10-10: $0.00479.
 *
 * Enable (local Supabase stack for the `llm_calls` row; `SMOKE_TARGET=env` for the env project):
 *   export ANTHROPIC_API_KEY=$(grep ^ANTHROPIC_API_KEY= .env.local | cut -d= -f2-)
 *   SMOKE_LLM=1 npm run smoke -- tests/smoke/llm-grammar.smoke.test.ts
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database, Tables } from "@/server/db/types";
import { assembleTurnContext } from "@/server/agent/context/build";
import { createInterim, createLinkSlots, createTaint, runLoop } from "@/server/agent/loop";
import { REPLY_FORMAT } from "@/server/agent/plan";
import { TOOLS } from "@/server/agent/tools";
import type { ToolCtx } from "@/server/agent/types";
import type { ChannelContext } from "@/server/channels/types";
import { ROUTES, callModel, type LlmRequest, type LlmResponse } from "@/server/llm";
import type { AgentTurnInput } from "@/server/pipeline/types";

const ENABLED = process.env.SMOKE_LLM === "1" && Boolean(process.env.ANTHROPIC_API_KEY);
if (!ENABLED) {
  console.info("llm-grammar smoke skipped: set SMOKE_LLM=1 and ANTHROPIC_API_KEY to run it (see file header)");
}

type Sb = SupabaseClient<Database>;

// ── Target selection (only when enabled; db() reads the env lazily) ─────────
function localTarget(): { url: string; serviceKey: string } {
  let out = "";
  try {
    out = execFileSync("supabase", ["status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? "");
  }
  const json = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
  if (!json) throw new Error("local Supabase stack not running (`supabase start`), or set SMOKE_TARGET=env");
  const s = JSON.parse(json) as Record<string, string>;
  return { url: s.API_URL, serviceKey: s.SERVICE_ROLE_KEY };
}
function envTarget(): { url: string; serviceKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("SMOKE_TARGET=env needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY");
  return { url, serviceKey };
}

const RUN = randomUUID().slice(0, 8);
const U = randomUUID();
const NOW = new Date();
const TZ = "America/New_York";

const CHANNEL: ChannelContext = {
  channelId: "smoke-llm-grammar",
  provider: "dev",
  kind: "imessage",
  service: "imessage",
  handleKind: "phone",
  capabilities: { reactions: true, typing: true, inlineReplies: true, media: true, maxBubbleChars: 1200 },
  windowOpen: true,
};

const USER: Tables<"users"> = {
  id: U,
  name: null,
  timezone: TZ,
  timezone_source: "default",
  briefing_time: "08:00:00",
  briefing_enabled: true,
  next_briefing_at: null,
  last_briefing_sent_at: null,
  persona_prefs: {},
  birth_year: null,
  created_at: NOW.toISOString(),
  deleted_at: null,
  deadline_nudge_minutes: [],
  quiet_start: "23:00:00",
  quiet_end: "08:00:00",
};

/** Sentinel thrown by the call wrapper to stop the loop after its first model call. */
class StopAfterFirstCall extends Error {}

(ENABLED ? describe : describe.skip)("LLM grammar: real agent request is accepted (live, opt-in)", () => {
  let sb: Sb;

  beforeAll(() => {
    const target = process.env.SMOKE_TARGET === "env" ? envTarget() : localTarget();
    process.env.NEXT_PUBLIC_SUPABASE_URL = target.url;
    process.env.SUPABASE_SERVICE_ROLE_KEY = target.serviceKey;
    sb = createClient<Database>(target.url, target.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  });

  afterAll(async () => {
    if (!sb) return;
    const { error } = await sb.from("llm_calls").delete().eq("meta->>smoke_run", RUN);
    if (error) console.warn(`llm-grammar smoke cleanup failed: ${error.code ?? "unknown"}`);
  });

  it("chat route with all TOOLS schemas + REPLY_FORMAT + static prompt: no 400, one llm_calls row", async () => {
    const input: AgentTurnInput = {
      userId: U,
      runId: `smoke-${RUN}`,
      now: NOW,
      timezone: TZ,
      channel: CHANNEL,
      identity: { isNewUser: false, name: null, timezone: TZ, timezoneSource: "default" },
      trigger: { kind: "inbound" },
      newMessages: [{ id: randomUUID(), body: "hi", media: [], replyToMessageId: null, createdAt: NOW }],
      inboundReactions: [],
      isFollowUpPass: false,
      welcomeSent: true,
      isEval: true,
      signal: new AbortController().signal,
      interim: async () => false,
    };
    const built = assembleTurnContext(input, {
      user: USER,
      profile: null,
      preferences: [],
      openQuestion: null,
      summary: null,
      messages: [],
      reactions: [],
      pendingActions: [],
      agenda: [],
      recentRuns: [],
    });
    const ctx: ToolCtx = {
      userId: U,
      runId: input.runId,
      now: NOW,
      timezone: TZ,
      channel: CHANNEL,
      trigger: input.trigger,
      aliases: built.aliases,
      evidence: built.evidence,
      userText: built.userText,
      taint: createTaint(),
      links: createLinkSlots(),
      interim: createInterim(async () => false),
      signal: input.signal,
      log: () => undefined,
    };

    let sent: LlmRequest | null = null;
    let response: LlmResponse | null = null;
    let failure: unknown = null;
    const call = async (req: LlmRequest): Promise<LlmResponse> => {
      // The loop's own request; only the output cap and the log tag differ (no user/run FK ids).
      sent = { ...req, maxTokens: 256, log: { meta: { smoke: "llm_grammar", smoke_run: RUN } } };
      try {
        response = await callModel(sent);
      } catch (e) {
        failure = e;
      }
      throw new StopAfterFirstCall();
    };
    await expect(
      runLoop(ctx, built, {
        call,
        tools: TOOLS,
        claimEscalation: async () => false,
        now: () => Date.now(),
      }, { model: ROUTES.chat.model, escalated: false, escalationReason: null }),
    ).rejects.toBeInstanceOf(StopAfterFirstCall);

    // The request really carried the production prefix and reply format.
    const req = sent as LlmRequest | null;
    expect(req?.route).toBe("chat");
    expect(req?.outputFormat).toBe(REPLY_FORMAT);
    expect(req?.tools).toBe(built.tools);
    expect(req?.tools).toHaveLength(TOOLS.length);
    expect(req?.system).toBe(built.system);

    if (failure) {
      const e = failure as { name?: string; message?: string; status?: number };
      throw new Error(`model call failed: ${e.name ?? "error"} ${e.status ?? ""} ${e.message ?? ""}`.trim());
    }
    const res = response as LlmResponse | null;
    expect(res).not.toBeNull();
    expect(res?.stopReason).not.toBeNull();
    console.info(
      `llm-grammar: ${res?.model} stop=${res?.stopReason} in=${res?.usage.inputTokens} cacheW=${res?.usage.cacheWriteTokens} ` +
        `cacheR=${res?.usage.cacheReadTokens} out=${res?.usage.outputTokens} cost=$${res?.usage.costUsd.toFixed(5)}`,
    );

    const { data, error } = await sb.from("llm_calls").select("id, route, error, user_id").eq("meta->>smoke_run", RUN);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0]).toMatchObject({ route: "chat", error: null, user_id: null });
  });
});
