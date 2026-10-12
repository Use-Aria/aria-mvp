import "server-only";
// OWNER: 3.3

/**
 * Agent tool `confirm_action` (master plan §1.4 #27, §1.5; V2-04 §2.8.2). The chat side of the one
 * pending-action path: `confirmPendingAction(…, {via:"chat", runId, evidence})` — atomic
 * pending→executing, at-most-once execution; refused (`same_run`) when the action was created in
 * this same run or the cited "yes" was received before the action was shown (5.5 review #3).
 *
 * The executor (a Gmail send) can be slow: the loop gives this tool `TOOL_TIMEOUT_OVERRIDES_MS`
 * and, if even that runs out, tells the model the action is still in progress
 * (`TOOL_IN_PROGRESS_RESULT`). The confirm keeps running; when it finishes after the loop stopped
 * waiting (`ctx.signal` aborted), its outcome is posted into the chat like a web confirm
 * (`postConfirmOutcome`, dedupe `act:<id>`). The in-flight confirm is registered with Next's
 * `after()` (`keepAlive`) so the serverless invocation isn't frozen when the dispatch request's
 * work ends while the send is still running; outside a request scope (Jest, tsx scripts) that is a
 * no-op.
 */
import { after } from "next/server";
import { z } from "zod";
import {
  confirmPendingAction,
  getPendingAction,
  isOutcomeUnknown,
  postConfirmOutcome,
  type ConfirmCode,
  type ConfirmEvidence,
} from "@/server/agent/pending/actions";
import { EV, aliasRef, defineTool, requireEvidence, type ToolResult } from "@/server/agent/tools/define";
import type { ToolCtx } from "@/server/agent/types";

const input = z.strictObject({
  action: aliasRef("a", "a_ id of the pending action"),
  evidence: EV,
});

/**
 * Result when the send's outcome is unknown (Gmail didn't confirm it and the Sent folder didn't
 * show it yet; the row stays `executing` and recovery settles it). Not a failure: never resend.
 */
export const CONFIRM_UNCONFIRMED =
  "unconfirmed: Google hasn't confirmed the send yet, and it may already have gone out. Don't resend and don't call confirm_action again. Tell the student Gmail hasn't confirmed it yet, ask them to check their Sent folder before asking again, and say the draft page shows the final status. Don't promise to confirm it later.";

/**
 * Model-facing message for a confirm failure (pure).
 * @param code confirm result code
 * @returns guidance for the model
 */
export function confirmErrorMessage(code: ConfirmCode): string {
  switch (code) {
    case "send_unconfirmed":
      return CONFIRM_UNCONFIRMED;
    case "same_run":
      return "same_run: the student hasn't confirmed this since it was shown to them (it was created this turn, or their message came before they saw it); show it to them and wait for them to confirm in their next message";
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

/** Result when the action is already being carried out (e.g. a confirm from the web is running). */
export const CONFIRM_RUNNING =
  "in_progress: this action is already being carried out. Don't call confirm_action again; tell the student it's going through.";

/**
 * The cited evidence alias as a row reference (`m_` → messages.id, `x_` → reactions.id).
 * @param ctx tool context (alias table)
 * @param alias the `evidence` alias (already passed `requireEvidence`)
 * @returns the reference, or null when it doesn't resolve
 */
function evidenceRef(ctx: ToolCtx, alias: string): ConfirmEvidence | null {
  const kind = alias.startsWith("x_") ? "x" : "m";
  const id = ctx.aliases.resolve(alias, kind);
  return id ? { kind, id } : null;
}

/**
 * Keep the serverless invocation alive until `work` settles: registers it with Next's `after()`
 * (Vercel `waitUntil`). The agent may stop waiting for `confirm_action` (timeout / abort) while the
 * send is still running, and the dispatch request's own work can then end before the send does.
 * Outside a request scope `after()` throws; that is ignored (Jest, tsx scripts, in-process dev chat).
 * @param work the in-flight confirm (never rejects)
 * @returns true when registered
 */
export function keepAlive(work: Promise<unknown>): boolean {
  try {
    after(work);
    return true;
  } catch {
    return false;
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
  const evidence = evidenceRef(ctx, i.evidence);
  if (!evidence) return { ok: false, error: "evidence must be the id of the user's own message in <new_messages> that asked for this" };
  const work = confirmAndReport(ctx, id, evidence);
  keepAlive(work);
  return work;
}

/** The confirm itself, its late chat post, and the model-facing result. Never rejects. */
async function confirmAndReport(ctx: ToolCtx, id: string, evidence: ConfirmEvidence): Promise<ToolResult> {
  try {
    const r = await confirmPendingAction(ctx.userId, id, { via: "chat", runId: ctx.runId, evidence });
    // The loop stopped waiting (timeout, or the run was aborted): post the outcome into the chat.
    if (ctx.signal.aborted) {
      ctx.log("confirm_action_late", { ok: r.ok });
      await postConfirmOutcome(ctx.userId, id, r, "action_confirmed_late");
    }
    if (r.ok) return { ok: true, data: `ok: ${r.summary}` };
    ctx.log("confirm_action_refused", { code: r.code });
    // Gmail didn't confirm the send (now or on an earlier confirm): never a failure, never resend.
    if (r.code === "send_unconfirmed") return { ok: true, data: CONFIRM_UNCONFIRMED };
    if (r.code === "executor_failed" || r.code === "not_pending") {
      const view = await getPendingAction(ctx.userId, id).catch(() => null);
      // Still `executing`: the send's outcome is unknown, or another confirm is running it.
      if (view?.status === "executing") {
        return { ok: true, data: view.error && isOutcomeUnknown(view.error) ? CONFIRM_UNCONFIRMED : CONFIRM_RUNNING };
      }
      if (r.code === "executor_failed") {
        return { ok: false, error: `it failed${view?.error ? ` (${view.error})` : ""}; tell the student it didn't go through` };
      }
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
