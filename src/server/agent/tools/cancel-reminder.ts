import "server-only";
// OWNER: 2.6

/**
 * Agent tool `cancel_reminder` (master plan §1.4 #10; input per V2-06 §9 (reminder = r_ alias; + evidence)).
 * Resolves the `r_` alias (only aliases shown in this run resolve), then `cancelReminder`
 * (ownership-checked; job cancelled, row → cancelled).
 */
import { z } from "zod";
import { EV, aliasRef, defineTool, requireEvidence, type ToolResult } from "@/server/agent/tools/define";
import type { ToolCtx } from "@/server/agent/types";
import { cancelReminder } from "@/server/reminders/service";

const input = z.strictObject({
  reminder: aliasRef("r", "r_ id from list_reminders"),
  evidence: EV,
});

/**
 * Tool body (exported for tests).
 * @param ctx tool context
 * @param i parsed input
 * @returns `{cancelled: r_…}` or a model-readable error
 */
export async function runCancelReminder(ctx: ToolCtx, i: z.output<typeof input>): Promise<ToolResult> {
  const gate = requireEvidence(ctx, i.evidence);
  if (!gate.ok) return gate;
  const id = ctx.aliases.resolve(i.reminder, "r");
  if (!id) return { ok: false, error: `unknown reminder ${i.reminder}: call list_reminders first` };
  try {
    const r = await cancelReminder(ctx.userId, id);
    return r.ok ? { ok: true, data: { cancelled: i.reminder } } : { ok: false, error: r.error ?? "couldn't cancel it" };
  } catch (e) {
    ctx.log("cancel_reminder_failed", { error: e instanceof Error ? e.message.slice(0, 200) : "unknown" });
    return { ok: false, error: "couldn't cancel the reminder just now", retryable: true };
  }
}

/** `cancel_reminder` tool. */
export const cancelReminderTool = defineTool({
  name: "cancel_reminder",
  description:
    "Cancel one scheduled reminder by its r_ id (from list_reminders) when the student asks to stop or delete it. Cancelling an automatic nudge affects only that one item.",
  input,
  mutates: true,
  run: runCancelReminder,
});
