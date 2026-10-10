import "server-only";
// OWNER: 3.2
/* eslint-disable @typescript-eslint/no-unused-vars -- Wave 0 stub: params unused until 3.2 lands */

/**
 * Agent entry point (master plan §1.2). Wave 0 stub; `ARIA_AGENT=stub` uses the pipeline's
 * `stubAgentTurn` meanwhile.
 */
import { notImplemented } from "@/server/_stub";
import type { AgentTurnInput, AgentTurnResult } from "@/server/pipeline/types";

/**
 * Run one agent turn: build context, loop model ⇄ tools, resolve the reply plan, write run stats.
 * @param input turn input from the pipeline
 * @returns the reply plan and run stats
 * @throws AgentUnavailableError when the model provider is unavailable (pipeline retries)
 */
export async function runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
  throw notImplemented("3.2");
}
