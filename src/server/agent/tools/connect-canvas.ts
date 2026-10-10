import "server-only";
// OWNER: 3.4

/**
 * Agent tool `connect_canvas` (master plan §1.4 #6; input per V2-05 §9.2 (+ evidence)).
 * Wave 0 stub: final name, description, input and flags; `run` returns not_implemented.
 */
import { z } from "zod";
import { stubToolResult } from "@/server/_stub";
import { EV, defineTool } from "@/server/agent/tools/define";

/** `connect_canvas` tool. */
export const connectCanvasTool = defineTool({
  name: "connect_canvas",
  description:
    "Connect the student's Canvas calendar feed. Use ONLY when the student themselves pasted a Canvas calendar feed link (…/feeds/calendars/user_….ics). You don't need to repeat the link; the tool finds it in their message. Returns a short summary to tell them.",
  input: z.strictObject({
    url: z
      .string()
      .trim()
      .max(2048)
      .optional()
      .describe("Optional. Must be exactly a link the student sent; omit to auto-detect."),
    evidence: EV,
  }),
  mutates: true,
  untrustedOutput: true,
  slow: true,
  run: async () => stubToolResult("3.4"),
});
