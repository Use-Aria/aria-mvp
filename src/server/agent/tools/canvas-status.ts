import "server-only";
// OWNER: 3.4

/**
 * Agent tool `canvas_status` (master plan §1.4 #7; input per V2-05 §9.2).
 * Wave 0 stub: final name, description, input and flags; `run` returns not_implemented.
 */
import { z } from "zod";
import { stubToolResult } from "@/server/_stub";
import { defineTool } from "@/server/agent/tools/define";

/** `canvas_status` tool. */
export const canvasStatusTool = defineTool({
  name: "canvas_status",
  description:
    "Check whether Canvas is connected, when it last synced, and whether the feed has a problem. Can also trigger a refresh.",
  input: z.strictObject({ refresh: z.boolean().default(false) }),
  untrustedOutput: true,
  run: async () => stubToolResult("3.4"),
});
