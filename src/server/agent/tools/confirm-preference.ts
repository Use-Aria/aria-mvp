import "server-only";
// OWNER: 3.3

/**
 * Agent tool `confirm_preference` (master plan §1.4 #24; V2-04 §9.2). Atomic confirm / reject of
 * a proposed or queued preference (rpc `decide_preference`; confirm supersedes the active row with
 * the same key). Evidence may be the student's reply or an `x_` tapback on the question bubble.
 */
import { z } from "zod";
import { EV, aliasRef, defineTool, requireEvidence, type ToolResult } from "@/server/agent/tools/define";
import type { ToolCtx } from "@/server/agent/types";
import { PreferenceNotOpenError, decidePreference } from "@/server/memory";

const input = z.strictObject({
  proposal: aliasRef("p", "p_ id of the proposed preference"),
  decision: z.enum(["confirm", "reject"]),
  evidence: EV,
});

/**
 * Tool body (exported for tests).
 * @param ctx tool context
 * @param i parsed input
 * @returns "ok: active" / "ok: rejected", or a model-readable error
 */
export async function runConfirmPreference(ctx: ToolCtx, i: z.output<typeof input>): Promise<ToolResult> {
  const gate = requireEvidence(ctx, i.evidence);
  if (!gate.ok) return gate;
  const id = ctx.aliases.resolve(i.proposal, "p");
  if (!id) return { ok: false, error: `unknown proposal ${i.proposal}: use the p_ id shown in this run` };
  try {
    const row = await decidePreference(ctx.userId, id, i.decision);
    return { ok: true, data: row.status === "active" ? "ok: active" : "ok: rejected" };
  } catch (e) {
    if (e instanceof PreferenceNotOpenError) return { ok: false, error: "that preference question is no longer open" };
    ctx.log("confirm_preference_failed", { error: e instanceof Error ? e.name : "error" });
    return { ok: false, error: "couldn't record that just now", retryable: true };
  }
}

/** `confirm_preference` tool. */
export const confirmPreferenceTool = defineTool({
  name: "confirm_preference",
  description:
    "Record the student's answer to a pending preference question (its p_ id): confirm or reject. Evidence can be their reply text or a tapback (x_ id) on the question bubble.",
  input,
  strict: true,
  mutates: true,
  run: runConfirmPreference,
});
