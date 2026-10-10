import "server-only";
// OWNER: 3.2

/**
 * `agent_runs` stats written by the agent (master plan §1.2 ownership table). The pipeline (3.1)
 * inserts the row and closes it (`status`, `finished_at`, `error`); the agent writes `model` when
 * the first LLM call starts (so `claim_escalation` counts the run), then the run stats at the end.
 * `escalated` / `escalation_reason` are set by the `claim_escalation` RPC itself.
 */
import type { ReplyPlan } from "@/server/channels/types";
import { db } from "@/server/db";
import type { Database, Json } from "@/server/db/types";
import type { ModelId } from "@/server/llm";

/** One executed tool call as recorded in `agent_runs.tool_calls` (never argument or result bodies). */
export interface ToolCallRecord {
  name: string;
  /** 1-based tool iteration */
  iteration: number;
  ok: boolean;
  ms: number;
}

/** Columns the agent may write (all optional; only the given ones are updated). */
export interface RunStatsPatch {
  model?: ModelId | null;
  escalated?: boolean;
  escalationReason?: string | null;
  iterations?: number;
  llmCallCount?: number;
  toolCalls?: readonly ToolCallRecord[];
  costUsd?: number;
  latencyMs?: number;
  plan?: ReplyPlan | null;
}

type RunUpdate = Database["public"]["Tables"]["agent_runs"]["Update"];

/**
 * Map a stats patch to `agent_runs` columns. Pure; exported for tests.
 * @param patch the stats to write
 * @returns the update object (snake_case columns; cost rounded to 6 decimals)
 */
export function toRunUpdate(patch: RunStatsPatch): RunUpdate {
  const u: RunUpdate = {};
  if (patch.model !== undefined) u.model = patch.model;
  if (patch.escalated !== undefined) u.escalated = patch.escalated;
  if (patch.escalationReason !== undefined) u.escalation_reason = patch.escalationReason;
  if (patch.iterations !== undefined) u.iterations = patch.iterations;
  if (patch.llmCallCount !== undefined) u.llm_call_count = patch.llmCallCount;
  if (patch.toolCalls !== undefined) {
    u.tool_calls = patch.toolCalls.map((t) => ({ name: t.name, iteration: t.iteration, ok: t.ok, ms: t.ms }));
  }
  if (patch.costUsd !== undefined) u.cost_usd = Math.round(patch.costUsd * 1e6) / 1e6;
  if (patch.latencyMs !== undefined) u.latency_ms = Math.max(0, Math.round(patch.latencyMs));
  if (patch.plan !== undefined) u.plan = patch.plan === null ? null : (JSON.parse(JSON.stringify(patch.plan)) as Json);
  return u;
}

/**
 * Update the agent-owned columns of one `agent_runs` row. Never throws (stats must not fail a
 * turn); failures are logged with the run id only.
 * @param runId the `agent_runs` id (inserted by the pipeline)
 * @param patch the stats to write
 * @returns true when the update succeeded (or there was nothing to write)
 */
export async function updateRunStats(runId: string, patch: RunStatsPatch): Promise<boolean> {
  const update = toRunUpdate(patch);
  if (Object.keys(update).length === 0) return true;
  try {
    const { error } = await db().from("agent_runs").update(update).eq("id", runId);
    if (error) {
      console.warn("agent.runs: stats update failed", { runId, code: error.code });
      return false;
    }
    return true;
  } catch (e) {
    console.warn("agent.runs: stats update threw", { runId, error: e instanceof Error ? e.name : "error" });
    return false;
  }
}
