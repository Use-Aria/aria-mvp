import "server-only";
// OWNER: 3.3

/**
 * Agent tool `pause` (master plan §1.4 #29; input per V2-04 §9.2 (sole pause tool)).
 * Wave 0 stub: final name, description, input and flags; `run` returns not_implemented.
 */
import { z } from "zod";
import { stubToolResult } from "@/server/_stub";
import { EV, defineTool } from "@/server/agent/tools/define";

/** `pause` tool. */
export const pauseTool = defineTool({
  name: "pause",
  description:
    "Pause Aria's proactive texts (briefings, nudges, alerts) for a while: 1h, tonight, until tomorrow morning, a week, indefinitely, or resume. Replies to the student's own messages continue.",
  input: z.strictObject({
    until: z.enum(["1h", "tonight", "tomorrow_morning", "1_week", "indefinitely", "resume"]),
    evidence: EV,
  }),
  mutates: true,
  run: async () => stubToolResult("3.3"),
});
