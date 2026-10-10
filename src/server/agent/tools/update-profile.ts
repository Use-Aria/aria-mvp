import "server-only";
// OWNER: 3.3

/**
 * Agent tool `update_profile` (master plan §1.4 #26, conflict C6; V2-04 §9.2). Fields:
 * - name → `users.name`
 * - school → `user_profile.school` (`setProfileSchool`)
 * - timezone → validated, canonical IANA id → `users.timezone` + `timezone_source='user'`, then
 *   `onUserScheduleSettingsChanged` (briefing, timeline rebase, recurring reminders, nudges)
 * Then the profile block is refreshed. Briefing settings live only in update_notification_settings.
 */
import { z } from "zod";
import { EV, defineTool, requireEvidence, type ToolResult } from "@/server/agent/tools/define";
import type { ToolCtx } from "@/server/agent/types";
import { onUserScheduleSettingsChanged } from "@/server/briefing/scheduler";
import { db } from "@/server/db";
import { refreshProfileBlock, setProfileSchool } from "@/server/memory";
import { isValidTimeZone } from "@/shared/time/tz";

const input = z.strictObject({
  field: z.enum(["name", "school", "timezone"]),
  value: z.string().min(1).max(60),
  evidence: EV,
});

/**
 * Canonical IANA id for user input ("america/chicago" → "America/Chicago"), or null (pure).
 * Only region/city style ids and UTC are accepted (no "EST"-style abbreviations).
 * @param value user-supplied zone
 * @returns canonical zone id or null
 */
export function canonicalTimeZone(value: string): string | null {
  const v = value.trim().replace(/\s+/g, "_");
  if (!/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2}$/.test(v) && v.toUpperCase() !== "UTC") return null;
  if (!isValidTimeZone(v)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: v }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/**
 * Clean a display name: control characters stripped, whitespace collapsed (pure).
 * @param value raw name
 * @returns cleaned name, or null when empty
 */
export function cleanName(value: string): string | null {
  const t = value.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim();
  return t.length > 0 ? t.slice(0, 60) : null;
}

/**
 * Tool body (exported for tests).
 * @param ctx tool context
 * @param i parsed input
 * @returns "ok: <field> saved", or a model-readable error
 */
export async function runUpdateProfile(ctx: ToolCtx, i: z.output<typeof input>): Promise<ToolResult> {
  const gate = requireEvidence(ctx, i.evidence);
  if (!gate.ok) return gate;
  try {
    switch (i.field) {
      case "name": {
        const name = cleanName(i.value);
        if (!name) return { ok: false, error: "empty name" };
        const { error } = await db().from("users").update({ name }).eq("id", ctx.userId);
        if (error) throw new Error(error.message);
        await refreshProfileBlock(ctx.userId);
        return { ok: true, data: "ok: name saved" };
      }
      case "school": {
        await setProfileSchool(ctx.userId, i.value);
        return { ok: true, data: "ok: school saved" };
      }
      case "timezone": {
        const tz = canonicalTimeZone(i.value);
        if (!tz) return { ok: false, error: `"${i.value.slice(0, 40)}" isn't an IANA timezone; use one like America/Chicago or Europe/London` };
        const { error } = await db().from("users").update({ timezone: tz, timezone_source: "user" }).eq("id", ctx.userId);
        if (error) throw new Error(error.message);
        let note = "";
        try {
          await onUserScheduleSettingsChanged(ctx.userId, ctx.now);
        } catch (e) {
          ctx.log("update_profile_reschedule_failed", { error: e instanceof Error ? e.name : "error" });
          note = " (some reminders may update a bit later)";
        }
        await refreshProfileBlock(ctx.userId);
        return { ok: true, data: `ok: timezone set to ${tz}${note}` };
      }
    }
  } catch (e) {
    ctx.log("update_profile_failed", { field: i.field, error: e instanceof Error ? e.name : "error" });
    return { ok: false, error: "couldn't save that just now", retryable: true };
  }
}

/** `update_profile` tool. */
export const updateProfileTool = defineTool({
  name: "update_profile",
  description:
    "Update the student's name, school, or IANA timezone (e.g. America/Chicago) when they tell you. A timezone change reschedules briefings and reminders. Briefing and nudge settings go through update_notification_settings.",
  input,
  strict: true,
  mutates: true,
  run: runUpdateProfile,
});
