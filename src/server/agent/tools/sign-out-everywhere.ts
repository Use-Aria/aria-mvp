import "server-only";
// OWNER: 3.3

/**
 * Agent tool `sign_out_everywhere` (master plan §1.4 #30; input per V2-04 §9.2).
 * Wave 0 stub: final name, description, input and flags; `run` returns not_implemented.
 */
import { z } from "zod";
import { stubToolResult } from "@/server/_stub";
import { EV, defineTool } from "@/server/agent/tools/define";

/** `sign_out_everywhere` tool. */
export const signOutEverywhereTool = defineTool({
  name: "sign_out_everywhere",
  description:
    "Sign the student out of Aria's web pages on every device (revokes all web sessions) when they ask, or when they think someone else has their links.",
  input: z.strictObject({ evidence: EV }),
  mutates: true,
  run: async () => stubToolResult("3.3"),
});
