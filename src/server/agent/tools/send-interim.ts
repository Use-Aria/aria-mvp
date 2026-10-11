import "server-only";
// OWNER: 3.3

/**
 * Agent tool `send_interim` (master plan §1.4 #1; V2-04 §9.2). Sends one interim bubble now via
 * `ctx.interim` (shared with the pipeline watchdog: at most one interim per run). Not on
 * proactive runs.
 */
import { z } from "zod";
import { defineTool, type ToolResult } from "@/server/agent/tools/define";
import type { ToolCtx } from "@/server/agent/types";

const input = z.strictObject({ text: z.string().min(1).max(120) });

// Results say plainly that this was the turn's one interim: a bare "ok: sent" let the model pair
// another send_interim with its next slow tool (a wasted call; see the loop's interim guard).
const SENT = "ok: sent. That's the one interim for this turn; don't call send_interim again.";
const ALREADY = "already_sent: an interim line already went out this turn. Don't call send_interim again; just continue.";

/**
 * Tool body (exported for tests).
 * @param ctx tool context
 * @param i parsed input
 * @returns "ok: sent…", "already_sent…", or an error on proactive runs
 */
export async function runSendInterim(ctx: ToolCtx, i: z.output<typeof input>): Promise<ToolResult> {
  if (ctx.trigger.kind !== "inbound") return { ok: false, error: "send_interim is only for replies to the student's messages" };
  if (ctx.interim.sent) return { ok: true, data: ALREADY };
  const text = i.text.replace(/\s+/g, " ").trim();
  if (!text) return { ok: false, error: "empty interim text" };
  try {
    const sent = await ctx.interim.send(text);
    return { ok: true, data: sent ? SENT : ALREADY };
  } catch (e) {
    ctx.log("send_interim_failed", { error: e instanceof Error ? e.name : "error" });
    return { ok: true, data: "not sent; just continue" };
  }
}

/** `send_interim` tool. */
export const sendInterimTool = defineTool({
  name: "send_interim",
  description:
    "Send one short interim bubble right now (e.g. 'give me a sec 👀') while you keep working. Call it in the SAME response as a slow tool such as search_email or find_free_slots. At most once per run; never on proactive runs.",
  input,
  run: runSendInterim,
});
