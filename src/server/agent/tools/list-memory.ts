import "server-only";
// OWNER: 3.3

/**
 * Agent tool `list_memory` (master plan §1.4 #22; V2-04 §9.2). Profile block + active preferences
 * `[p_…]` + the 15 most recent facts `[f_…]` (aliases minted for `forget`). Editing happens on the
 * settings page (`send_link(settings)`).
 */
import { z } from "zod";
import { factLine } from "@/server/agent/tools/recall";
import { defineTool, type ToolResult } from "@/server/agent/tools/define";
import type { ToolCtx } from "@/server/agent/types";
import { listActivePreferences, listRecentFacts, loadProfileBlock, renderPreferences } from "@/server/memory";

const input = z.strictObject({ section: z.enum(["all", "profile", "preferences", "facts"]) });

/** Recent facts listed. */
export const LIST_MEMORY_FACTS = 15;

/**
 * Tool body (exported for tests).
 * @param ctx tool context
 * @param i parsed input
 * @returns the requested sections, or a model-readable error
 */
export async function runListMemory(ctx: ToolCtx, i: z.output<typeof input>): Promise<ToolResult> {
  const want = (s: "profile" | "preferences" | "facts") => i.section === "all" || i.section === s;
  try {
    const [profile, prefs, facts] = await Promise.all([
      want("profile") ? loadProfileBlock(ctx.userId) : Promise.resolve(null),
      want("preferences") ? listActivePreferences(ctx.userId) : Promise.resolve(null),
      want("facts") ? listRecentFacts(ctx.userId, LIST_MEMORY_FACTS) : Promise.resolve(null),
    ]);
    const parts: string[] = [];
    if (profile !== null) parts.push(`profile:\n${profile.trim() || "(nothing yet)"}`);
    if (prefs !== null) parts.push(`preferences:\n${renderPreferences(prefs, { aliases: ctx.aliases }) || "(none)"}`);
    if (facts !== null) parts.push(`facts (newest first):\n${facts.map((f) => factLine(ctx, f)).join("\n") || "(none)"}`);
    parts.push("they can review and edit all of this on the settings page: send_link(settings)");
    return { ok: true, data: parts.join("\n\n") };
  } catch (e) {
    ctx.log("list_memory_failed", { error: e instanceof Error ? e.name : "error" });
    return { ok: false, error: "couldn't read memory just now", retryable: true };
  }
}

/** `list_memory` tool. */
export const listMemoryTool = defineTool({
  name: "list_memory",
  description:
    "Show what Aria knows about the student: profile, active preferences [p_…] and recent remembered facts [f_…]. Use for 'what do you know about me', and offer send_link(settings) so they can edit it.",
  input,
  run: runListMemory,
});
