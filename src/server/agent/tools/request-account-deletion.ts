import "server-only";
// OWNER: 3.3

/**
 * Agent tool `request_account_deletion` (master plan §1.4 #31; input per V2-04 §9.2).
 * Wave 0 stub: final name, description, input and flags; `run` returns not_implemented.
 */
import { z } from "zod";
import { stubToolResult } from "@/server/_stub";
import { EV, defineTool } from "@/server/agent/tools/define";

/** `request_account_deletion` tool. */
export const requestAccountDeletionTool = defineTool({
  name: "request_account_deletion",
  description:
    "Start deleting the student's Aria account and all their data. This creates a pending action; ask them to confirm explicitly (e.g. reply 'yes delete') and only then call confirm_action in a later turn.",
  input: z.strictObject({ evidence: EV }),
  mutates: true,
  run: async () => stubToolResult("3.3"),
});
