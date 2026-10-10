import "server-only";
// OWNER: 3.1

/**
 * Picks the agent implementation (V2-03 §7 `agent-impl.ts`; master plan §4 `ARIA_AGENT`, default
 * `stub`). The real agent is loaded lazily, so stub mode (and the pipeline tests) never load the
 * LLM stack. Coded only against the frozen `RunAgentTurn` contract.
 */
import { optionalEnv } from "@/server/env";
import { stubAgentTurn } from "@/server/pipeline/stub-agent";
import type { RunAgentTurn } from "@/server/pipeline/types";

/** Which agent `ARIA_AGENT` selects. */
export type AgentMode = "stub" | "real";

/**
 * Resolves `ARIA_AGENT` (pure; exported for tests). Unset or `stub` → stub; anything else
 * (`real`, `agent`, `haiku`, …) → the real agent.
 * @param value raw `ARIA_AGENT`
 * @returns the mode
 */
export function agentMode(value: string | undefined | null): AgentMode {
  const v = (value ?? "").trim().toLowerCase();
  return v === "" || v === "stub" ? "stub" : "real";
}

const realAgentTurn: RunAgentTurn = async (input) => {
  const { runAgentTurn } = await import("@/server/agent");
  return runAgentTurn(input);
};

/**
 * The agent the pipeline runs, per `ARIA_AGENT`.
 * @returns `stubAgentTurn` (default) or the lazy-loaded `runAgentTurn` from `@/server/agent`
 */
export function getRunAgentTurn(): RunAgentTurn {
  return agentMode(optionalEnv("ARIA_AGENT")) === "stub" ? stubAgentTurn : realAgentTurn;
}
