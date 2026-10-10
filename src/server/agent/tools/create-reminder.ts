import "server-only";
// OWNER: 2.6

/**
 * Agent tool `create_reminder` (master plan §1.4 #8; input per V2-06 §9 (before_item.item = t_ alias; + evidence)).
 * Resolves the `t_` alias, then `createReminder` validates and schedules (row + `reminder_fire` job).
 * Returns the new reminder as an `r_` alias with an unambiguous local fire time.
 */
import { z } from "zod";
import { EV, aliasRef, defineTool, requireEvidence, type ToolResult } from "@/server/agent/tools/define";
import type { ToolCtx } from "@/server/agent/types";
import { createReminder, type ReminderWhen } from "@/server/reminders/service";
import { WeekdaySchema } from "@/shared/scheduling-constraints";

const LocalDateTimeStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
  .describe("Local wall-clock time in the user's timezone, no offset, e.g. 2026-10-13T21:00");

const input = z.strictObject({
  text: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .describe(
      "Exact message Aria will send at fire time, in the user's register. Self-contained; must stay true if the deadline moves (say 'due in 2h', not 'due at 9pm'). No links.",
    ),
  when: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("in"), minutes: z.number().int().min(1).max(525_600) }),
    z.strictObject({ type: z.literal("at"), local: LocalDateTimeStr }),
    z.strictObject({
      type: z.literal("before_item"),
      item: aliasRef("t", "t_ id of the deadline from get_agenda/search_deadlines"),
      minutesBefore: z.number().int().min(0).max(20_160),
    }),
    z.strictObject({
      type: z.literal("recurring"),
      firstLocal: LocalDateTimeStr,
      freq: z.enum(["daily", "weekly", "monthly"]),
      interval: z.number().int().min(1).max(12).default(1),
      byDay: z.array(WeekdaySchema).min(1).max(7).optional(),
      byMonthDay: z.number().int().min(1).max(31).optional(),
      until: z.iso.date().optional(),
      count: z.number().int().min(1).max(365).optional(),
    }),
  ]),
  evidence: EV,
});

/** Human note for a wall time that had to be adjusted across a DST transition. */
const ADJUSTED_NOTE = {
  gap_shifted: "that local time doesn't exist (clocks jump forward), so it was moved forward by the gap",
  overlap_earlier: "that local time happens twice (clocks fall back); the first one was used",
} as const;

/**
 * Tool body (exported for tests).
 * @param ctx tool context
 * @param i parsed input
 * @returns the scheduled reminder (`r_` alias, local fire time) or a model-readable error
 */
export async function runCreateReminder(ctx: ToolCtx, i: z.output<typeof input>): Promise<ToolResult> {
  const gate = requireEvidence(ctx, i.evidence);
  if (!gate.ok) return gate;
  let when: ReminderWhen;
  if (i.when.type === "before_item") {
    const itemId = ctx.aliases.resolve(i.when.item, "t");
    if (!itemId) return { ok: false, error: `unknown item ${i.when.item}: use a t_ id shown in this conversation` };
    when = { type: "before_item", itemId, minutesBefore: i.when.minutesBefore };
  } else {
    when = i.when;
  }
  try {
    const r = await createReminder(ctx.userId, ctx.timezone, { text: i.text, when }, ctx.now);
    if (!r.ok) return { ok: false, error: r.error };
    return {
      ok: true,
      data: {
        reminder: ctx.aliases.mint("r", r.reminderId),
        fires_at: r.firesAtLocal,
        ...(r.recurrence ? { repeats: r.recurrence } : {}),
        ...(r.adjusted ? { note: ADJUSTED_NOTE[r.adjusted] } : {}),
      },
    };
  } catch (e) {
    ctx.log("create_reminder_failed", { error: e instanceof Error ? e.message.slice(0, 200) : "unknown" });
    return { ok: false, error: "couldn't save the reminder just now", retryable: true };
  }
}

/** `create_reminder` tool. */
export const createReminderTool = defineTool({
  name: "create_reminder",
  description:
    "Schedule a reminder text from Aria: in N minutes, at a local time, N minutes before a deadline (item = its t_ id), or recurring. text is the exact message to send later: self-contained, in the student's register, no links. Only when the student explicitly asked for a reminder.",
  input,
  mutates: true,
  run: runCreateReminder,
});
