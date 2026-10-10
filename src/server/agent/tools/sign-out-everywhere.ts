import "server-only";
// OWNER: 3.3

/**
 * Agent tool `sign_out_everywhere` (master plan §1.4 #30; V2-04 §9.2): `revokeAllSessions`.
 */
import { z } from "zod";
import { EV, defineTool, requireEvidence, type ToolResult } from "@/server/agent/tools/define";
import type { ToolCtx } from "@/server/agent/types";
import { revokeAllSessions } from "@/server/security/sessions";

const input = z.strictObject({ evidence: EV });

/**
 * Tool body (exported for tests).
 * @param ctx tool context
 * @param i parsed input
 * @returns "ok: signed out everywhere", or a model-readable error
 */
export async function runSignOutEverywhere(ctx: ToolCtx, i: z.output<typeof input>): Promise<ToolResult> {
  const gate = requireEvidence(ctx, i.evidence);
  if (!gate.ok) return gate;
  try {
    await revokeAllSessions(ctx.userId);
    return { ok: true, data: "ok: signed out of Aria's web pages on every device; old links won't work" };
  } catch (e) {
    ctx.log("sign_out_everywhere_failed", { error: e instanceof Error ? e.name : "error" });
    return { ok: false, error: "couldn't sign out just now", retryable: true };
  }
}

/** `sign_out_everywhere` tool. */
export const signOutEverywhereTool = defineTool({
  name: "sign_out_everywhere",
  description:
    "Sign the student out of Aria's web pages on every device (revokes all web sessions) when they ask, or when they think someone else has their links.",
  input,
  mutates: true,
  run: runSignOutEverywhere,
});
