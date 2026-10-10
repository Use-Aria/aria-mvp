import "server-only";
// OWNER: 3.5

/**
 * Agent tool `read_syllabus` (master plan §1.4 #19; input per V2-08 §9 (attachment = m_ alias + index; + evidence)).
 * Wave 0 stub: final name, description, input and flags; `run` returns not_implemented.
 */
import { z } from "zod";
import { stubToolResult } from "@/server/_stub";
import { EV, defineTool } from "@/server/agent/tools/define";

/** `read_syllabus` tool. */
export const readSyllabusTool = defineTool({
  name: "read_syllabus",
  description:
    "Read a syllabus PDF the user just sent and save its exams, assignments and grading. Use when the user sends a PDF that is (or might be) a syllabus. Returns immediately; you'll tell them you're reading it.",
  input: z.strictObject({
    attachment: z
      .string()
      .regex(/^m_[0-9a-f]{8,10}:\d$/)
      .describe("attachment id from the transcript, e.g. m_1a2b3c4d:0"),
    /** from the user's words, e.g. "orgo" */
    courseHint: z.string().trim().min(1).max(80).optional(),
    /** only after the user confirmed replacing */
    replace: z.boolean().default(false),
    evidence: EV,
  }),
  mutates: true,
  run: async () => stubToolResult("3.5"),
});
