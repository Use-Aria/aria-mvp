import "server-only";
// OWNER: 3.3

/**
 * Agent tool `list_memory` (master plan §1.4 #22; input per V2-04 §9.2).
 * Wave 0 stub: final name, description, input and flags; `run` returns not_implemented.
 */
import { z } from "zod";
import { stubToolResult } from "@/server/_stub";
import { defineTool } from "@/server/agent/tools/define";

/** `list_memory` tool. */
export const listMemoryTool = defineTool({
  name: "list_memory",
  description:
    "Show what Aria knows about the student: profile, active preferences [p_…] and recent remembered facts [f_…]. Use for 'what do you know about me', and offer send_link(settings) so they can edit it.",
  input: z.strictObject({ section: z.enum(["all", "profile", "preferences", "facts"]) }),
  run: async () => stubToolResult("3.3"),
});
