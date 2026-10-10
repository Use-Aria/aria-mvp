import "server-only";
// OWNER: 3.2

/**
 * Agent entry point (master plan §1.2; V2-04 §2.1, §2.6, §2.9–2.11, §8.1).
 *
 *   build context → ack fast path (no LLM) | pre-run escalation → model ⇄ tool loop
 *   → resolve plan → write run stats → enqueue memory_extract / conversation_summary
 *
 * The pipeline (3.1) owns the `agent_runs` row lifecycle, typing, the 8s interim watchdog,
 * delivery and retries; this module writes only the agent stats (§1.2 ownership table): `model`
 * as soon as the first LLM call is about to start (so `claim_escalation` counts the run), then
 * the remaining stats once the turn has a plan.
 */
import type { BuiltContext } from "@/server/agent/context/build";
import { buildTurnContext } from "@/server/agent/context/build";
import { claimEscalation, preflightEscalation, type EscalationReason } from "@/server/agent/escalation";
import {
  createInterim,
  createLinkSlots,
  createTaint,
  newLoopStats,
  runLoop,
  type LoopDeps,
  type LoopOutcome,
  type LoopStats,
} from "@/server/agent/loop";
import { resolvePlan, type ModelReplyPlan } from "@/server/agent/plan";
import { updateRunStats, type RunStatsPatch } from "@/server/agent/runs";
import { TOOLS } from "@/server/agent/tools";
import type { AgentTool } from "@/server/agent/tools/define";
import type { ToolCtx } from "@/server/agent/types";
import type { ReplyPlan } from "@/server/channels/types";
import { enqueueJob } from "@/server/jobs/enqueue";
import { callModel, LlmUnavailableError, ROUTES, type LlmRequest, type LlmResponse, type ModelId } from "@/server/llm";
import { AgentUnavailableError, type AgentTurnInput, type AgentTurnResult } from "@/server/pipeline/types";

/** `memory_extract` runs this long after the latest turn (the dedupe key pushes it out). */
export const MEMORY_EXTRACT_DELAY_MS = 30 * 60_000;

/** Follow-up jobs one finished turn asks for. */
export interface FollowupJobs {
  memoryExtract: boolean;
  conversationSummary: boolean;
}

/** Injectable dependencies of `runAgentTurnWith` (production defaults in `runAgentTurn`). */
export interface AgentDeps {
  buildContext: (input: AgentTurnInput) => Promise<BuiltContext>;
  call: (req: LlmRequest) => Promise<LlmResponse>;
  tools: readonly AgentTool[];
  updateRunStats: (runId: string, patch: RunStatsPatch) => Promise<boolean>;
  claimEscalation: (runId: string, reason: EscalationReason) => Promise<boolean>;
  enqueueFollowups: (userId: string, jobs: FollowupJobs, now: Date) => Promise<void>;
  /** ms clock (latency, tool timings) */
  now: () => number;
  toolTimeoutMs?: number;
}

/**
 * Which follow-up jobs a turn needs: `memory_extract` after any turn with user-authored inbound
 * (extraction reads only `direction='in'` text), `conversation_summary` when the history window
 * outgrew its cap.
 * @param input the turn input
 * @param built the turn context
 * @returns the jobs to enqueue
 */
export function followupsFor(input: AgentTurnInput, built: Pick<BuiltContext, "needsSummary">): FollowupJobs {
  return {
    memoryExtract: input.trigger.kind === "inbound" && input.newMessages.length > 0,
    conversationSummary: built.needsSummary,
  };
}

/**
 * Enqueue the follow-up jobs (master plan §1.3 dedupe keys): `memx:<userId>` at now + 30 min
 * (replace → pushed out while the conversation continues), `sum:<userId>` now (keep). Never throws.
 * @param userId the student
 * @param jobs which jobs
 * @param now the turn's clock
 */
export async function enqueueFollowups(userId: string, jobs: FollowupJobs, now: Date): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  if (jobs.memoryExtract) {
    tasks.push(
      enqueueJob({
        kind: "memory_extract",
        userId,
        runAt: new Date(now.getTime() + MEMORY_EXTRACT_DELAY_MS),
        dedupeKey: `memx:${userId}`,
        mode: "replace",
      }),
    );
  }
  if (jobs.conversationSummary) {
    tasks.push(enqueueJob({ kind: "conversation_summary", userId, dedupeKey: `sum:${userId}`, mode: "keep" }));
  }
  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === "rejected") {
      console.warn("agent: follow-up enqueue failed", { error: r.reason instanceof Error ? r.reason.name : "error" });
    }
  }
}

const defaultDeps: AgentDeps = {
  buildContext: buildTurnContext,
  call: callModel,
  tools: TOOLS,
  updateRunStats,
  claimEscalation: (runId, reason) => claimEscalation(runId, reason),
  enqueueFollowups,
  now: () => Date.now(),
};

/**
 * Build the `ToolCtx` for one run.
 * @param input the turn input
 * @param built the turn context (aliases, evidence, user text)
 * @returns the tool context
 */
export function buildToolCtx(input: AgentTurnInput, built: Pick<BuiltContext, "aliases" | "evidence" | "userText">): ToolCtx {
  const { userId, runId } = input;
  return {
    userId,
    runId,
    now: input.now,
    timezone: input.timezone,
    channel: input.channel,
    trigger: input.trigger,
    aliases: built.aliases,
    evidence: built.evidence,
    userText: built.userText,
    taint: createTaint(),
    links: createLinkSlots(),
    interim: createInterim(input.interim),
    signal: input.signal,
    log(event, data) {
      // Codes, counts and ids only — tools must never pass bodies here.
      console.info(`agent.${event}`, { runId, ...data });
    },
  };
}

function statsPatch(stats: LoopStats, latencyMs: number, plan: ReplyPlan | undefined): RunStatsPatch {
  return {
    model: stats.model,
    escalated: stats.escalated,
    escalationReason: stats.escalationReason,
    iterations: stats.iterations,
    llmCallCount: stats.llmCalls,
    toolCalls: stats.toolCalls,
    costUsd: stats.costUsd,
    latencyMs,
    ...(plan ? { plan } : {}),
  };
}

function logWarnings(runId: string, warnings: readonly string[]): void {
  if (warnings.length > 0) console.info("agent.plan_warnings", { runId, warnings: warnings.join(",") });
}

/**
 * `runAgentTurn` with injected dependencies (tests; production uses the defaults).
 * @param input turn input from the pipeline
 * @param deps context builder, model caller, tools, stats writer, escalation claim, job enqueue, clock
 * @returns the reply plan and run stats
 * @throws AgentUnavailableError when the model provider is unavailable (pipeline retries);
 *   other errors (context reads, bad requests, aborts) propagate unchanged
 */
export async function runAgentTurnWith(input: AgentTurnInput, deps: AgentDeps): Promise<AgentTurnResult> {
  const started = deps.now();
  const { runId, userId } = input;
  const built = await deps.buildContext(input);
  const ctx = buildToolCtx(input, built);
  const resolveOpts = { userMessageAliases: built.userMessageAliases, lastInbound: built.lastInbound };
  const followups = followupsFor(input, built);

  // Ack fast path: tapback only, no LLM call (agent_runs.model stays null).
  if (built.ack && built.lastInbound) {
    const modelPlan: ModelReplyPlan = { reactions: [{ target: built.lastInbound, type: built.ack }], bubbles: [], reply_to: null, link: null };
    const { plan, warnings } = resolvePlan(modelPlan, built.aliases, ctx.links, input.channel, resolveOpts);
    logWarnings(runId, warnings);
    await deps.updateRunStats(runId, {
      model: null,
      iterations: 0,
      llmCallCount: 0,
      toolCalls: [],
      costUsd: 0,
      latencyMs: deps.now() - started,
      plan,
    });
    await deps.enqueueFollowups(userId, followups, input.now);
    return { plan, model: null, escalated: false, interimSent: false, costUsd: 0 };
  }

  // The first LLM call is about to start: record the model so claim_escalation counts this run.
  let model: ModelId = ROUTES.chat.model;
  let escalated = false;
  let escalationReason: EscalationReason | null = null;
  await deps.updateRunStats(runId, { model });
  const pre = preflightEscalation(built.signals, input.now);
  if (pre && (await deps.claimEscalation(runId, pre))) {
    model = ROUTES.escalate.model;
    escalated = true;
    escalationReason = pre;
    await deps.updateRunStats(runId, { model });
  }

  const loopDeps: LoopDeps = {
    call: deps.call,
    tools: deps.tools,
    now: deps.now,
    ...(deps.toolTimeoutMs !== undefined ? { toolTimeoutMs: deps.toolTimeoutMs } : {}),
    claimEscalation: async (reason) => {
      const ok = await deps.claimEscalation(runId, reason);
      if (ok) await deps.updateRunStats(runId, { model: ROUTES.escalate.model });
      return ok;
    },
  };
  const start = { model, escalated, escalationReason };
  const stats = newLoopStats(start);
  let out: LoopOutcome;
  try {
    out = await runLoop(ctx, built, loopDeps, start, stats);
  } catch (e) {
    await deps.updateRunStats(runId, statsPatch(stats, deps.now() - started, undefined));
    if (e instanceof LlmUnavailableError) {
      throw new AgentUnavailableError(`agent unavailable${e.status ? ` (${e.status})` : ""}`);
    }
    throw e;
  }

  const { plan, warnings } = resolvePlan(out.plan, built.aliases, ctx.links, input.channel, resolveOpts);
  logWarnings(runId, [...out.warnings, ...warnings, ...(out.end !== "final" ? [`end:${out.end}`] : [])]);
  await deps.updateRunStats(runId, statsPatch(out, deps.now() - started, plan));
  await deps.enqueueFollowups(userId, followups, input.now);
  return { plan, model: out.model, escalated: out.escalated, interimSent: ctx.interim.sent, costUsd: out.costUsd };
}

/**
 * Run one agent turn: build context, loop model ⇄ tools, resolve the reply plan, write run stats.
 * @param input turn input from the pipeline
 * @returns the reply plan and run stats
 * @throws AgentUnavailableError when the model provider is unavailable (pipeline retries)
 */
export async function runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
  return runAgentTurnWith(input, defaultDeps);
}
