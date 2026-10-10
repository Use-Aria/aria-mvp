import "server-only";
// OWNER: 3.3

/**
 * Agent tool `recall` (master plan §1.4 #21; input per V2-04 §9.2).
 * Wave 0 stub: final name, description, input and flags; `run` returns not_implemented.
 */
import { z } from "zod";
import { stubToolResult } from "@/server/_stub";
import { defineTool } from "@/server/agent/tools/define";

/** `recall` tool. */
export const recallTool = defineTool({
  name: "recall",
  description:
    "Search what Aria remembers about the student (facts from past conversations) by keywords. Use when they reference something from before ('my interview', 'that club') that isn't in the context. Returns [f_…] facts.",
  input: z.strictObject({ query: z.string().min(2).max(120) }),
  run: async () => stubToolResult("3.3"),
});
