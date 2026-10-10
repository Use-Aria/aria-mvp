import "server-only";
// OWNER: 3.3

/**
 * Agent tool `confirm_action` (master plan §1.4 #27, §1.5; V2-04 §2.8.2). The chat side of the one
 * pending-action path: `confirmPendingAction(…, {via:"chat", runId})` — atomic pending→executing,
 * refused when the action was created in this same run (`same_run`), at-most-once execution.
 */
import { z } from "zod";
import { confirmPendingAction, getPendingAction, type ConfirmCode } from "@/server/agent/pending/actions";
import { EV, aliasRef, defineTool, requireEvidence, type ToolResult } from "@/server/agent/tools/define";
import type { ToolCtx } from "@/server/agent/types";

const input = z.strictObject({
  action: aliasRef("a", "a_ id of the pending action"),
  evidence: EV,
});

/**
 * Model-facing message for a confirm failure (pure).
 * @param code confirm result code
 * @returns guidance for the model
 */
export function confirmErrorMessage(code: ConfirmCode): string {
  switch (code) {
    case "same_run":
      return "same_run: this action was just created; show it to the student and wait for them to confirm in their next message";
    case "not_found":
      return "that action doesn't exist";
    case "not_pending":
      return "that action was already handled or cancelled";
    case "expired":
      return "that action expired; start it again if they still want it";
    case "version_conflict":
      return "that action changed since it was shown (edited on the web); show the latest version and ask again";
    case "google_disconnected":
      return "Google is disconnected; offer send_link(connect_google) to reconnect, then redo the draft";
    case "executor_failed":
      return "it failed";
  }
}

/**
 * Tool body (exported for tests).
 * @param ctx tool context
 * @param i parsed input
 * @returns "ok: <executor summary>", or a model-readable error
 */
export async function runConfirmAction(ctx: ToolCtx, i: z.output<typeof input>): Promise<ToolResult> {
  const gate = requireEvidence(ctx, i.evidence);
  if (!gate.ok) return gate;
  const id = ctx.aliases.resolve(i.action, "a");
  if (!id) return { ok: false, error: `unknown action ${i.action}: use the a_ id shown in this run` };
  try {
    const r = await confirmPendingAction(ctx.userId, id, { via: "chat", runId: ctx.runId });
    if (r.ok) return { ok: true, data: `ok: ${r.summary}` };
    ctx.log("confirm_action_refused", { code: r.code });
    if (r.code === "executor_failed") {
      const view = await getPendingAction(ctx.userId, id).catch(() => null);
      return { ok: false, error: `it failed${view?.error ? ` (${view.error})` : ""}; tell the student it didn't go through` };
    }
    return { ok: false, error: confirmErrorMessage(r.code) };
  } catch (e) {
    ctx.log("confirm_action_failed", { error: e instanceof Error ? e.name : "error" });
    return { ok: false, error: "couldn't carry that out just now; nothing was done", retryable: true };
  }
}

/** `confirm_action` tool. */
export const confirmActionTool = defineTool({
  name: "confirm_action",
  description:
    "Carry out a pending action (an a_ id, e.g. an email draft or an account deletion) after the student clearly confirmed it in a later message. Never in the same turn that created it.",
  input,
  strict: true,
  mutates: true,
  run: runConfirmAction,
});
