import "server-only";
// OWNER: 2.6

/**
 * Agent tool `update_notification_settings` (master plan §1.4 #11; input per V2-06 §9 (+ evidence)).
 * The only tool that owns briefing time/on-off and the default deadline heads-up offsets (C6).
 * `updateNotificationSettings` saves, then runs `onUserScheduleSettingsChanged` (next briefing,
 * prepare job, recurring reminders, auto nudges).
 */
import { z } from "zod";
import { EV, defineTool, requireEvidence, type ToolResult } from "@/server/agent/tools/define";
import type { ToolCtx } from "@/server/agent/types";
import { db } from "@/server/db";
import { NotificationSettingsError, updateNotificationSettings, type NotificationSettings } from "@/server/proactive/settings";
import { HHMMSchema } from "@/shared/scheduling-constraints";
import { formatForTool, parseHHMM } from "@/shared/time/tz";

const input = z
  .strictObject({
    briefingTime: HHMMSchema.optional(),
    briefingEnabled: z.boolean().optional(),
    deadlineNudgeMinutesBefore: z
      .array(z.number().int().min(15).max(2_880))
      .max(3)
      .optional()
      .describe("Default heads-up before every deadline; [] turns nudges off. 'remind me 2h before' → [120]"),
    evidence: EV,
  })
  .refine(
    (v) => v.briefingTime !== undefined || v.briefingEnabled !== undefined || v.deadlineNudgeMinutesBefore !== undefined,
    "nothing to update",
  );

function hhmm(t: { hour: number; minute: number }): string {
  return `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;
}

/**
 * Tool body (exported for tests).
 * @param ctx tool context
 * @param i parsed input
 * @returns the saved settings (+ next briefing time) or a readable error (e.g. time inside quiet hours)
 */
export async function runUpdateNotificationSettings(ctx: ToolCtx, i: z.output<typeof input>): Promise<ToolResult> {
  const gate = requireEvidence(ctx, i.evidence);
  if (!gate.ok) return gate;
  const patch: Partial<Pick<NotificationSettings, "briefingTime" | "briefingEnabled" | "nudgeMinutes">> = {};
  if (i.briefingTime !== undefined) patch.briefingTime = parseHHMM(i.briefingTime);
  if (i.briefingEnabled !== undefined) patch.briefingEnabled = i.briefingEnabled;
  if (i.deadlineNudgeMinutesBefore !== undefined) patch.nudgeMinutes = i.deadlineNudgeMinutesBefore;
  try {
    const s = await updateNotificationSettings(ctx.userId, patch);
    const { data } = await db().from("users").select("next_briefing_at").eq("id", ctx.userId).maybeSingle();
    const next = data?.next_briefing_at ? new Date(data.next_briefing_at) : null;
    return {
      ok: true,
      data: {
        briefing_enabled: s.briefingEnabled,
        briefing_time: hhmm(s.briefingTime),
        next_briefing: s.briefingEnabled && next ? formatForTool(next, s.tz) : "off",
        deadline_heads_up_minutes: s.nudgeMinutes,
      },
    };
  } catch (e) {
    if (e instanceof NotificationSettingsError) return { ok: false, error: e.message };
    ctx.log("update_notification_settings_failed", { error: e instanceof Error ? e.message.slice(0, 200) : "unknown" });
    return { ok: false, error: "couldn't save the settings just now", retryable: true };
  }
}

/** `update_notification_settings` tool. */
export const updateNotificationSettingsTool = defineTool({
  name: "update_notification_settings",
  description:
    "Change the student's notification settings: morning briefing time (HH:MM, 24h), briefing on/off, and the default heads-up before every deadline in minutes ([] turns nudges off). Only for explicit instructions; inferred habits go through propose_preference.",
  input,
  mutates: true,
  run: runUpdateNotificationSettings,
});
