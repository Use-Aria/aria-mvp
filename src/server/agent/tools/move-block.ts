import "server-only";
// OWNER: 4.2

/**
 * Agent tool `move_block` (master plan §1.4 #14; V2-07 §2.8, §9.2). Evidence-gated mutator.
 * `block` is a `t_` alias shown in this run; only rows of source `aria` on the current Aria
 * calendar move (`moveBlock`). New times overlapping other busy time are refused ("not moved"),
 * and Google without `calendar_write` → `is_error` offering `send_link` connect_google.
 */
import { z } from "zod";
import { EV, aliasRef, defineTool, requireEvidence, type ToolResult } from "@/server/agent/tools/define";
import { blockToolError, calendarWriteGate, checkBlockTimes, CONNECT_GOOGLE_ERROR } from "@/server/agent/tools/create-block";
import type { ToolCtx } from "@/server/agent/types";
import { moveBlock } from "@/server/integrations/google/calendar/aria-calendar";
import { formatTimeRange } from "@/shared/time/tz";

const input = z.strictObject({
  block: aliasRef("t", "t_ id of an Aria block"),
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  evidence: EV,
});

/**
 * Tool body (exported for tests).
 * @param ctx tool context
 * @param i parsed input
 * @returns "ok: moved to <label>", "not moved: …" on a conflict, or a model-readable error
 */
export async function runMoveBlock(ctx: ToolCtx, i: z.output<typeof input>): Promise<ToolResult> {
  const gate = requireEvidence(ctx, i.evidence);
  if (!gate.ok) return gate;
  const id = ctx.aliases.resolve(i.block, "t");
  if (!id) return { ok: false, error: `unknown block ${i.block}: find it with get_agenda first` };
  const times = checkBlockTimes(i.start, i.end, ctx.now);
  if (!times.ok) return times;
  const blocked = await calendarWriteGate(ctx);
  if (blocked) return blocked;
  try {
    const r = await moveBlock(ctx.userId, id, times.interval.start, times.interval.end);
    if (r.ok) return { ok: true, data: `ok: moved to ${formatTimeRange(times.interval.start, times.interval.end, ctx.timezone, ctx.now)}` };
    switch (r.reason) {
      case "conflict":
        return { ok: true, data: "not moved: the new time overlaps other busy time. Offer a different time." };
      case "not_aria_block":
        return { ok: false, error: "that isn't one of Aria's blocks; only blocks on the Aria calendar can be moved (their other events are read-only)" };
      case "not_found":
        return { ok: false, error: `block ${i.block} no longer exists` };
      case "no_permission":
        return { ok: false, error: CONNECT_GOOGLE_ERROR };
    }
  } catch (e) {
    return blockToolError(ctx, "move_block", e);
  }
}

/** `move_block` tool. */
export const moveBlockTool = defineTool({
  name: "move_block",
  description:
    "Move an existing Aria calendar block (the t_ id of a block Aria created) to a new start and end time when the student asks to reschedule it. Only Aria's own blocks can be moved.",
  input,
  mutates: true,
  run: runMoveBlock,
});
