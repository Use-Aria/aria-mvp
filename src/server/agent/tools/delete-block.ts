import "server-only";
// OWNER: 4.2

/**
 * Agent tool `delete_block` (master plan §1.4 #15; V2-07 §2.8, §9.2). Evidence-gated mutator.
 * `block` is a `t_` alias shown in this run; only rows of source `aria` on the current Aria
 * calendar are deleted (`deleteBlock`; already gone in Google counts as deleted). Google without
 * `calendar_write` → `is_error` offering `send_link` connect_google.
 */
import { z } from "zod";
import { EV, aliasRef, defineTool, requireEvidence, type ToolResult } from "@/server/agent/tools/define";
import { blockToolError, calendarWriteGate, CONNECT_GOOGLE_ERROR } from "@/server/agent/tools/create-block";
import type { ToolCtx } from "@/server/agent/types";
import { deleteBlock } from "@/server/integrations/google/calendar/aria-calendar";

const input = z.strictObject({
  block: aliasRef("t", "t_ id of an Aria block"),
  evidence: EV,
});

/**
 * Tool body (exported for tests).
 * @param ctx tool context
 * @param i parsed input
 * @returns "ok: removed from your Aria calendar", or a model-readable error
 */
export async function runDeleteBlock(ctx: ToolCtx, i: z.output<typeof input>): Promise<ToolResult> {
  const gate = requireEvidence(ctx, i.evidence);
  if (!gate.ok) return gate;
  const id = ctx.aliases.resolve(i.block, "t");
  if (!id) return { ok: false, error: `unknown block ${i.block}: find it with get_agenda first` };
  const blocked = await calendarWriteGate(ctx);
  if (blocked) return blocked;
  try {
    const r = await deleteBlock(ctx.userId, id);
    if (r.ok) return { ok: true, data: "ok: removed from your Aria calendar" };
    switch (r.reason) {
      case "not_aria_block":
        return { ok: false, error: "that isn't one of Aria's blocks; only blocks on the Aria calendar can be deleted (their other events are read-only)" };
      case "not_found":
        return { ok: false, error: `block ${i.block} no longer exists` };
      case "no_permission":
        return { ok: false, error: CONNECT_GOOGLE_ERROR };
    }
  } catch (e) {
    return blockToolError(ctx, "delete_block", e);
  }
}

/** `delete_block` tool. */
export const deleteBlockTool = defineTool({
  name: "delete_block",
  description:
    "Delete an Aria calendar block (the t_ id of a block Aria created) when the student asks to remove it. Only blocks on the Aria calendar can be deleted; their other events are read-only.",
  input,
  mutates: true,
  run: runDeleteBlock,
});
