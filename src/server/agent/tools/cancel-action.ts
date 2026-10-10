import "server-only";
// OWNER: 3.3

/**
 * Agent tool `cancel_action` (master plan §1.4 #28, §1.5; V2-04 §9.2): pending → cancelled
 * through the shared pending-action path (`cancelPendingAction`, via chat).
 */
import { z } from "zod";
import { cancelPendingAction } from "@/server/agent/pending/actions";
import { EV, aliasRef, defineTool, requireEvidence, type ToolResult } from "@/server/agent/tools/define";
import type { ToolCtx } from "@/server/agent/types";

const input = z.strictObject({
  action: aliasRef("a", "a_ id of the pending action"),
  evidence: EV,
});

/**
 * Tool body (exported for tests).
 * @param ctx tool context
 * @param i parsed input
 * @returns "ok: cancelled", or a model-readable error
 */
export async function runCancelAction(ctx: ToolCtx, i: z.output<typeof input>): Promise<ToolResult> {
  const gate = requireEvidence(ctx, i.evidence);
  if (!gate.ok) return gate;
  const id = ctx.aliases.resolve(i.action, "a");
  if (!id) return { ok: false, error: `unknown action ${i.action}: use the a_ id shown in this run` };
  try {
    const r = await cancelPendingAction(ctx.userId, id, "chat");
    if (r.ok) return { ok: true, data: "ok: cancelled" };
    return { ok: false, error: r.code === "not_found" ? "that action doesn't exist" : "that action was already handled, cancelled or expired" };
  } catch (e) {
    ctx.log("cancel_action_failed", { error: e instanceof Error ? e.name : "error" });
    return { ok: false, error: "couldn't cancel that just now", retryable: true };
  }
}

/** `cancel_action` tool. */
export const cancelActionTool = defineTool({
  name: "cancel_action",
  description:
    "Cancel a pending action (an a_ id, e.g. an email draft or an account deletion request) when the student says not to do it.",
  input,
  mutates: true,
  run: runCancelAction,
});
