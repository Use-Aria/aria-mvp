import "server-only";
// OWNER: 2.2

/**
 * The cached static prefix (V2-04 §2.5, BP1): tool schemas (registry order) + the system prompt
 * (identity, style guide, rules, output contract, few-shots). Byte-identical for every user and
 * turn: no dates, names, ids or per-user tools. It changes only on deploy (or when the registry
 * changes, a deliberate one-time miss). Memoized per tool array.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { applicableFewShots, renderFewShot } from "@/server/agent/persona/few-shots";
import { IDENTITY, OUTPUT_CONTRACT, RULES, STYLE_GUIDE } from "@/server/agent/persona/style-guide";
import { TOOLS } from "@/server/agent/tools";
import type { AgentTool } from "@/server/agent/tools/define";
import { toolSchemas } from "@/server/agent/tools/registry";

const EXAMPLES_HEADER = `# Examples
Ids, names, times and tool results below are made up; never reuse them. "student" lines are their messages, → is a tool call, ← its result, "aria:" your final answer. Notes in parentheses describe context.`;

const CACHE = new WeakMap<readonly AgentTool[], string>();

/**
 * The static system prompt. Includes only few-shots whose tools are all in `tools`.
 * @param tools registered tools (default: the global registry)
 * @returns the system prompt text (memoized; identical bytes on every call)
 */
export function buildStaticSystemPrompt(tools: readonly AgentTool[] = TOOLS): string {
  const hit = CACHE.get(tools);
  if (hit !== undefined) return hit;
  const names = new Set(tools.map((t) => t.spec.name));
  const shots = applicableFewShots(names).map(renderFewShot).join("\n\n");
  const prompt = [IDENTITY, STYLE_GUIDE, RULES, OUTPUT_CONTRACT, shots ? `${EXAMPLES_HEADER}\n\n${shots}` : ""]
    .filter((s) => s.length > 0)
    .join("\n\n");
  CACHE.set(tools, prompt);
  return prompt;
}

/**
 * The whole cached static prefix: tool schemas (render order: tools → system) + system prompt.
 * @param tools registered tools (default: the global registry)
 * @returns `{tools, system}` exactly as sent to the API
 */
export function staticPrefix(tools: readonly AgentTool[] = TOOLS): { tools: Anthropic.Tool[]; system: string } {
  return { tools: toolSchemas(tools), system: buildStaticSystemPrompt(tools) };
}
