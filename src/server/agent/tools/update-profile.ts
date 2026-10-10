import "server-only";
// OWNER: 3.3

/**
 * Agent tool `update_profile` (master plan §1.4 #26; input per V2-04 §9.2 (name / school / timezone only)).
 * Wave 0 stub: final name, description, input and flags; `run` returns not_implemented.
 */
import { z } from "zod";
import { stubToolResult } from "@/server/_stub";
import { EV, defineTool } from "@/server/agent/tools/define";

/** `update_profile` tool. */
export const updateProfileTool = defineTool({
  name: "update_profile",
  description:
    "Update the student's name, school, or IANA timezone (e.g. America/Chicago) when they tell you. A timezone change reschedules briefings and reminders. Briefing and nudge settings go through update_notification_settings.",
  input: z.strictObject({
    field: z.enum(["name", "school", "timezone"]),
    value: z.string().min(1).max(60),
    evidence: EV,
  }),
  strict: true,
  mutates: true,
  run: async () => stubToolResult("3.3"),
});
