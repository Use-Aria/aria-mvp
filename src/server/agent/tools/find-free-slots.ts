import "server-only";
// OWNER: 4.2

/**
 * Agent tool `find_free_slots` (master plan §1.4 #12; input per V2-07 §9.2 (returns s_ aliases)).
 * Wave 0 stub: final name, description, input and flags; `run` returns not_implemented.
 */
import { z } from "zod";
import { stubToolResult } from "@/server/_stub";
import { defineTool } from "@/server/agent/tools/define";
import { ConstraintSchema, HHMMSchema } from "@/shared/scheduling-constraints";

const LocalDateOrTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/)
  .describe("Local date or date-time in the user's timezone, e.g. 2026-10-14 or 2026-10-14T16:00");

/** `find_free_slots` tool. */
export const findFreeSlotsTool = defineTool({
  name: "find_free_slots",
  description:
    "Find 3–5 open times on the student's calendar for an activity of a given length, respecting classes, events and their preferences. Copy any relevant active preferences into constraints. Returns s_ slot ids to offer; it never books anything.",
  input: z.strictObject({
    duration_minutes: z.number().int().min(15).max(480),
    /** default: now */
    window_start: LocalDateOrTime.optional(),
    /** default: end of tomorrow; max 14 days after start */
    window_end: LocalDateOrTime.optional(),
    activity: z.string().min(1).max(40).describe("e.g. 'gym', 'study CPSC 323'"),
    constraints: z.array(ConstraintSchema).max(10).default([]),
    part_of_day: z.array(z.enum(["morning", "afternoon", "evening"])).max(3).optional(),
    around: HHMMSchema.optional(),
    max_results: z.number().int().min(3).max(5).default(4),
  }),
  slow: true,
  run: async () => stubToolResult("4.2"),
});
