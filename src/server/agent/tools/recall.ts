import "server-only";
// OWNER: 3.3

/**
 * Agent tool `recall` (master plan §1.4 #21; V2-04 §9.2). Postgres FTS over live facts
 * (`recallFacts`, ≤ 8, recency-blended) → `[f_…] content (Oct 3)` lines with run-scoped aliases,
 * so `forget` can reference them. Facts come only from the student's own words.
 */
import { z } from "zod";
import { defineTool, type ToolResult } from "@/server/agent/tools/define";
import type { ToolCtx } from "@/server/agent/types";
import { neutralizeTags } from "@/server/agent/untrusted";
import { recallFacts } from "@/server/memory";

const input = z.strictObject({ query: z.string().min(2).max(120) });

/**
 * "Oct 3" in the user's zone.
 * @param d instant
 * @param tz IANA zone
 * @returns short month + day
 */
export function shortDate(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: tz }).format(d);
}

/**
 * One fact line for the model.
 * @param ctx tool context (alias minting, zone)
 * @param f fact
 * @returns `[f_…] content (Oct 3)`
 */
export function factLine(ctx: ToolCtx, f: { id: string; content: string; createdAt: Date }): string {
  return `[${ctx.aliases.mint("f", f.id)}] ${neutralizeTags(f.content.replace(/\s+/g, " ").trim())} (${shortDate(f.createdAt, ctx.timezone)})`;
}

/**
 * Tool body (exported for tests).
 * @param ctx tool context
 * @param i parsed input
 * @returns fact lines, "nothing found", or a model-readable error
 */
export async function runRecall(ctx: ToolCtx, i: z.output<typeof input>): Promise<ToolResult> {
  try {
    const facts = await recallFacts(ctx.userId, i.query, 8);
    return { ok: true, data: facts.length ? facts.map((f) => factLine(ctx, f)).join("\n") : "nothing found" };
  } catch (e) {
    ctx.log("recall_failed", { error: e instanceof Error ? e.name : "error" });
    return { ok: false, error: "couldn't search memory just now", retryable: true };
  }
}

/** `recall` tool. */
export const recallTool = defineTool({
  name: "recall",
  description:
    "Search what Aria remembers about the student (facts from past conversations) by keywords. Use when they reference something from before ('my interview', 'that club') that isn't in the context. Returns [f_…] facts.",
  input,
  run: runRecall,
});
