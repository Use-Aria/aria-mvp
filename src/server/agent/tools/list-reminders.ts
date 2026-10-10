import "server-only";
// OWNER: 2.6

/**
 * Agent tool `list_reminders` (master plan §1.4 #9; input per V2-06 §9 (returns r_ aliases)).
 * Lists scheduled reminders soonest first. Reminder ids are minted as `r_` aliases and anchor items
 * as `t_` aliases; anchor titles (third-party Canvas/calendar text) are wrapped as untrusted data
 * and taint the run.
 */
import { z } from "zod";
import { defineTool, type ToolResult } from "@/server/agent/tools/define";
import type { ToolCtx } from "@/server/agent/types";
import { wrapUntrusted } from "@/server/agent/untrusted";
import { listReminders } from "@/server/reminders/service";
import { formatForTool } from "@/shared/time/tz";

const input = z.strictObject({
  includeAutoNudges: z.boolean().default(false),
  limit: z.number().int().min(1).max(20).default(10),
});

/**
 * Tool body (exported for tests).
 * @param ctx tool context
 * @param i parsed input
 * @returns `{reminders: [...], count}` with aliases and unambiguous local times
 */
export async function runListReminders(ctx: ToolCtx, i: z.output<typeof input>): Promise<ToolResult> {
  try {
    const views = await listReminders(ctx.userId, ctx.timezone, { includeAuto: i.includeAutoNudges, limit: i.limit });
    let tainted = false;
    const reminders = views.map((v) => {
      const out: Record<string, string> = {
        id: ctx.aliases.mint("r", v.id),
        kind: v.origin === "auto" ? "auto_nudge" : v.kind,
        next_at: v.nextAt ? formatForTool(v.nextAt, ctx.timezone) : "not scheduled",
      };
      // Auto-nudge bodies are the item title (third-party); user reminder text came from the user's own turn.
      if (v.origin === "user") out.text = v.text;
      if (v.recurrence) out.repeats = v.recurrence;
      if (v.anchor) {
        const ref = ctx.aliases.mint("t", v.anchor.itemId);
        out.item = ref;
        out.item_info = wrapUntrusted({
          source: "canvas",
          id: ref,
          body: v.anchor.course ? { title: v.anchor.title, course: v.anchor.course } : { title: v.anchor.title },
          maxChars: 200,
        });
        tainted = true;
      }
      return out;
    });
    if (tainted) ctx.taint.mark("canvas");
    return { ok: true, data: { count: reminders.length, reminders } };
  } catch (e) {
    ctx.log("list_reminders_failed", { error: e instanceof Error ? e.message.slice(0, 200) : "unknown" });
    return { ok: false, error: "couldn't load reminders just now", retryable: true };
  }
}

/** `list_reminders` tool. */
export const listRemindersTool = defineTool({
  name: "list_reminders",
  description:
    "List the student's scheduled reminders, optionally including automatic deadline nudges, with r_ ids and next fire times. Use for 'what reminders do I have' or before cancelling one.",
  input,
  run: runListReminders,
});
