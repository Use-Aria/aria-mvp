/**
 * Direct-mode driver (V2-04 §7.5 `driver.ts`): one agent turn without the pipeline.
 *
 *   insert agent_runs (is_eval=true) → insert the inbound batch (consumed by that run)
 *   → runAgentTurnWith(input, production deps; `call` wrapped to record requests/responses)
 *   → insert outbound rows from the plan (simulates delivery) → close the run
 *
 * Everything else is the production path: context builder, tools, escalation claim (eval runs
 * still go through `claim_escalation`; the RPC excludes them from the budget), run stats and the
 * follow-up enqueue (`memx:` +30 min; `sum:` is due immediately, so it is suppressed here and the
 * suppression is logged — the dev tick would otherwise run a real summary on an eval user).
 */
import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { enqueueFollowups, runAgentTurnWith, type AgentDeps } from "@/server/agent";
import { buildTurnContext } from "@/server/agent/context/build";
import { claimEscalation } from "@/server/agent/escalation";
import { updateRunStats } from "@/server/agent/runs";
import { TOOLS } from "@/server/agent/tools";
import { channelContext } from "@/server/channels";
import type { ReplyPlan } from "@/server/channels/types";
import { callModel, type LlmRequest, type LlmResponse, type ModelId } from "@/server/llm";
import type { AgentTurnInput, IdentityState, InboundMessage } from "@/server/pipeline/types";
import { addSpend } from "./results";
import { must, sb, trackRun, type EvalUser } from "./seed";

/** A tool call the model made (name + parsed input), in order. */
export interface ToolUse {
  name: string;
  input: Record<string, unknown>;
}

/** What one turn did. */
export interface TurnOutcome {
  runId: string;
  /** inbound messages.id of the batch, oldest first */
  inboundIds: string[];
  plan: ReplyPlan | null;
  bubbles: string[];
  model: ModelId | null;
  toolUses: ToolUse[];
  /** tool results as the model saw them, keyed by tool_use id order (text only) */
  toolResults: string[];
  requests: LlmRequest[];
  responses: LlmResponse[];
  interims: string[];
  latencyMs: number;
  costUsd: number;
  error: string | null;
}

/**
 * Every text the model was sent in this turn (system excluded): message text blocks and tool
 * results, in order.
 * @param t the turn
 * @returns concatenated prompt text
 */
export function promptText(t: Pick<TurnOutcome, "requests">): string {
  const parts: string[] = [];
  const last = t.requests[t.requests.length - 1];
  for (const m of last?.messages ?? []) {
    if (typeof m.content === "string") {
      parts.push(m.content);
      continue;
    }
    for (const b of m.content) {
      if (b.type === "text") parts.push(b.text);
      else if (b.type === "tool_result") {
        if (typeof b.content === "string") parts.push(b.content);
        else for (const c of b.content ?? []) if (c.type === "text") parts.push(c.text);
      }
    }
  }
  return parts.join("\n");
}

function toolResultsOf(req: LlmRequest | undefined): string[] {
  const out: string[] = [];
  for (const m of req?.messages ?? []) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type !== "tool_result") continue;
      if (typeof b.content === "string") out.push(b.content);
      else out.push((b.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("\n"));
    }
  }
  return out;
}

function toolUsesOf(responses: readonly LlmResponse[]): ToolUse[] {
  const out: ToolUse[] = [];
  for (const r of responses) {
    for (const b of r.content as Anthropic.ContentBlock[]) {
      if (b.type === "tool_use") out.push({ name: b.name, input: (b.input ?? {}) as Record<string, unknown> });
    }
  }
  return out;
}

/** Options for one turn. */
export interface TurnOptions {
  /** run clock (default: real now) */
  now?: Date;
  /** abort the turn after this long (default 150s) */
  timeoutMs?: number;
}

/**
 * Run one direct-mode turn for an eval user.
 * @param u the eval user
 * @param texts the student's message(s) in this batch (a burst when several)
 * @param o clock / timeout
 * @returns the turn outcome (errors are captured, not thrown)
 */
export async function runTurn(u: EvalUser, texts: string | string[], o: TurnOptions = {}): Promise<TurnOutcome> {
  const batch = Array.isArray(texts) ? texts : [texts];
  const now = o.now ?? new Date();
  const run = must(
    await sb
      .from("agent_runs")
      .insert({ user_id: u.id, channel_id: u.channelId, status: "running", trigger: "inbound", is_eval: true, input_message_ids: [] })
      .select("id, started_at")
      .single(),
    "eval run",
  );
  trackRun(run.id, u.id);
  // Strictly after every earlier row (incl. the previous turn's outbound, stamped at its end):
  // the context builder treats rows newer than the batch as mid-run arrivals and hides them.
  const lastRow = must(await sb.from("messages").select("created_at").eq("user_id", u.id).order("created_at", { ascending: false }).limit(1), "last message");
  const base = Math.max(Date.now(), lastRow[0] ? new Date(lastRow[0].created_at).getTime() + batch.length + 1 : 0);
  const inbound = must(
    await sb
      .from("messages")
      .insert(
        batch.map((body, i) => ({
          user_id: u.id,
          channel_id: u.channelId,
          direction: "in",
          provider: "dev",
          provider_message_id: `eval-${randomUUID()}`,
          body,
          status: "received",
          service: "imessage",
          consumed_by_run: run.id,
          created_at: new Date(base - (batch.length - 1 - i)).toISOString(),
        })),
      )
      .select("id, body, media, reply_to_message_id, created_at"),
    "inbound batch",
  ).sort((a, b) => a.created_at.localeCompare(b.created_at));
  must(await sb.from("agent_runs").update({ input_message_ids: inbound.map((m) => m.id) }).eq("id", run.id).select("id"), "run inputs");
  const channel = must(
    await sb.from("channels").update({ last_inbound_at: new Date().toISOString() }).eq("id", u.channelId).select("*").single(),
    "channel",
  );
  const user = must(await sb.from("users").select("name, timezone, timezone_source").eq("id", u.id).single(), "user");

  const requests: LlmRequest[] = [];
  const responses: LlmResponse[] = [];
  const interims: string[] = [];
  const deps: AgentDeps = {
    buildContext: buildTurnContext,
    call: async (req) => {
      requests.push(req);
      const res = await callModel(req);
      responses.push(res);
      addSpend(res.usage.costUsd);
      return res;
    },
    tools: TOOLS,
    updateRunStats,
    claimEscalation: (runId, reason) => claimEscalation(runId, reason),
    enqueueFollowups: async (userId, jobs, at) => {
      if (jobs.conversationSummary) console.info("[evals] conversation_summary follow-up suppressed");
      await enqueueFollowups(userId, { ...jobs, conversationSummary: false }, at);
    },
    now: () => Date.now(),
  };
  const messages: InboundMessage[] = inbound.map((m) => ({
    id: m.id,
    body: m.body,
    media: [],
    replyToMessageId: m.reply_to_message_id,
    createdAt: new Date(m.created_at),
  }));
  const identity: IdentityState = {
    isNewUser: false,
    name: user.name,
    timezone: user.timezone,
    timezoneSource: (["default", "signup", "user", "inferred"] as const).find((s) => s === user.timezone_source) ?? "signup",
  };
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), o.timeoutMs ?? 150_000);
  const input: AgentTurnInput = {
    userId: u.id,
    runId: run.id,
    now,
    timezone: user.timezone,
    channel: channelContext(channel, { now }),
    identity,
    trigger: { kind: "inbound" },
    newMessages: messages,
    inboundReactions: [],
    isFollowUpPass: false,
    welcomeSent: false,
    isEval: true,
    signal: abort.signal,
    interim: async (text) => {
      interims.push(text);
      await sb.from("messages").insert({
        user_id: u.id,
        channel_id: u.channelId,
        direction: "out",
        provider: "dev",
        body: text,
        run_id: run.id,
        trigger: "interim",
        status: "sent",
        service: "imessage",
      });
      return true;
    },
  };

  const started = Date.now();
  let plan: ReplyPlan | null = null;
  let model: ModelId | null = null;
  let costUsd = 0;
  let error: string | null = null;
  try {
    const r = await runAgentTurnWith(input, deps);
    plan = r.plan;
    model = r.model;
    costUsd = r.costUsd;
  } catch (e) {
    error = e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 200) : "error";
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Date.now() - started;
  const bubbles = (plan?.bubbles ?? []).map((b) => b.text);
  if (plan && (bubbles.length > 0 || plan.link)) {
    const rows = [...bubbles, ...(plan.link ? [plan.link.url] : [])].map((body, i) => ({
      user_id: u.id,
      channel_id: u.channelId,
      direction: "out",
      provider: "dev",
      body,
      run_id: run.id,
      trigger: "reply",
      status: "sent",
      service: "imessage",
      idempotency_key: `${run.id}:${i}`,
      created_at: new Date(Math.max(Date.now(), base + batch.length) + i).toISOString(),
    }));
    must(await sb.from("messages").insert(rows).select("id"), "outbound rows");
  }
  await sb
    .from("agent_runs")
    .update({ status: error ? "failed" : "done", finished_at: new Date().toISOString(), error })
    .eq("id", run.id);
  return {
    runId: run.id,
    inboundIds: inbound.map((m) => m.id),
    plan,
    bubbles,
    model,
    toolUses: toolUsesOf(responses),
    toolResults: toolResultsOf(requests[requests.length - 1]),
    requests,
    responses,
    interims,
    latencyMs,
    costUsd,
    error,
  };
}
