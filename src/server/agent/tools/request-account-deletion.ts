import "server-only";
// OWNER: 3.3

/**
 * Agent tool `request_account_deletion` (master plan §1.4 #31, §1.16; V2-04 §9.2). Creates a
 * `delete_account` pending action (1h TTL) — or returns the one already open. Nothing is deleted
 * until `confirm_action` in a LATER turn (`same_run` guard); the executor then soft-deletes,
 * revokes sessions and schedules the purge.
 */
import { z } from "zod";
import { createPendingAction, listOpenActions } from "@/server/agent/pending/actions";
import { EV, defineTool, requireEvidence, type ToolResult } from "@/server/agent/tools/define";
import type { ToolCtx } from "@/server/agent/types";

const input = z.strictObject({ evidence: EV });

const CONFIRM_HINT = "ask them to reply 'yes delete' to confirm; on that later message call confirm_action";

/**
 * Tool body (exported for tests).
 * @param ctx tool context
 * @param i parsed input
 * @returns `{action: a_…, confirm: hint}`, or a model-readable error
 */
export async function runRequestAccountDeletion(ctx: ToolCtx, i: z.output<typeof input>): Promise<ToolResult> {
  const gate = requireEvidence(ctx, i.evidence);
  if (!gate.ok) return gate;
  try {
    const open = (await listOpenActions(ctx.userId)).find((a) => a.kind === "delete_account");
    if (open) return { ok: true, data: { action: ctx.aliases.mint("a", open.id), already_pending: true, confirm: CONFIRM_HINT } };
    const created = await createPendingAction(ctx, {
      kind: "delete_account",
      payload: {},
      summary: "delete the student's Aria account and all their data",
    });
    return { ok: true, data: { action: created.alias, confirm: CONFIRM_HINT } };
  } catch (e) {
    ctx.log("request_account_deletion_failed", { error: e instanceof Error ? e.name : "error" });
    return { ok: false, error: "couldn't start that just now", retryable: true };
  }
}

/** `request_account_deletion` tool. */
export const requestAccountDeletionTool = defineTool({
  name: "request_account_deletion",
  description:
    "Start deleting the student's Aria account and all their data. This creates a pending action; ask them to confirm explicitly (e.g. reply 'yes delete') and only then call confirm_action in a later turn.",
  input,
  mutates: true,
  run: runRequestAccountDeletion,
});
