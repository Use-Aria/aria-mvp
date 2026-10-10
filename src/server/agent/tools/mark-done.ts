import "server-only";
// OWNER: 3.3

/**
 * Agent tool `mark_done` (master plan §1.4 #5; V2-05 §9.3, item = `t_` alias). Evidence-gated;
 * the `t_` alias must have been shown in this run. `setTimelineItemStatus` runs the status
 * subscribers (V2-06 cancels the item's nudges). Returns the item line (wrapped).
 */
import { z } from "zod";
import { markTimelineTaint } from "@/server/agent/tools/get-agenda";
import { EV, aliasRef, defineTool, requireEvidence, type ToolResult } from "@/server/agent/tools/define";
import type { ToolCtx } from "@/server/agent/types";
import { renderTimelineForModel, setTimelineItemStatus } from "@/server/timeline";

const input = z.strictObject({
  item: aliasRef("t", "t_ id of the deadline or event"),
  status: z.enum(["done", "dismissed", "upcoming"]).default("done"),
  evidence: EV,
});

/**
 * Tool body (exported for tests).
 * @param ctx tool context
 * @param i parsed input
 * @returns "ok: marked <status>" + the item line, or a model-readable error
 */
export async function runMarkDone(ctx: ToolCtx, i: z.output<typeof input>): Promise<ToolResult> {
  const gate = requireEvidence(ctx, i.evidence);
  if (!gate.ok) return gate;
  const id = ctx.aliases.resolve(i.item, "t");
  if (!id) return { ok: false, error: `unknown item ${i.item}: find it with get_agenda or search_deadlines first` };
  try {
    const r = await setTimelineItemStatus(ctx.userId, id, i.status);
    if (!r.ok) return { ok: false, error: `item ${i.item} no longer exists` };
    markTimelineTaint(ctx, [r.item]);
    const line = renderTimelineForModel([r.item], { timezone: ctx.timezone, ref: (v) => ctx.aliases.mint("t", v.id) });
    return { ok: true, data: `ok: marked ${i.status}\n${line}` };
  } catch (e) {
    ctx.log("mark_done_failed", { error: e instanceof Error ? e.name : "error" });
    return { ok: false, error: "couldn't update that item just now", retryable: true };
  }
}

/** `mark_done` tool. */
export const markDoneTool = defineTool({
  name: "mark_done",
  description:
    "Mark one deadline or event as done (or dismissed, or back to upcoming) when the student says they finished it or don't need it. item must be a t_ id shown in this run; evidence is the student's message that said so.",
  input,
  strict: true,
  mutates: true,
  run: runMarkDone,
});
