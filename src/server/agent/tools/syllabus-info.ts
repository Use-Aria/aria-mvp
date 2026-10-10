import "server-only";
// OWNER: 3.5

/**
 * Agent tool `syllabus_info` (master plan §1.4 #20; input per V2-08 §9).
 * Wave 0 stub: final name, description, input and flags; `run` returns not_implemented.
 */
import { z } from "zod";
import { stubToolResult } from "@/server/_stub";
import { defineTool } from "@/server/agent/tools/define";

/** `syllabus_info` tool. */
export const syllabusInfoTool = defineTool({
  name: "syllabus_info",
  description:
    "Look up what a saved syllabus says: grading weights, exam dates and topics, assignments, weekly schedule, policies. Use for questions like 'what's on the midterm' or 'how much is the final worth'. Omit course to list saved syllabi.",
  input: z.strictObject({
    /** "CPSC 223", "data structures", "orgo" */
    course: z.string().trim().min(1).max(80).optional(),
    aspect: z
      .enum(["overview", "grading", "exams", "assignments", "schedule", "policies", "staff"])
      .default("overview"),
    /** e.g. "midterm 2" to narrow exams/schedule */
    query: z.string().trim().max(120).optional(),
  }),
  untrustedOutput: true,
  run: async () => stubToolResult("3.5"),
});
