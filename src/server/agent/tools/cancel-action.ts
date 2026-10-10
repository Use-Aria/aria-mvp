import "server-only";
// OWNER: 3.3

/**
 * Agent tool `cancel_action` (master plan §1.4 #28; input per V2-04 §9.2).
 * Wave 0 stub: final name, description, input and flags; `run` returns not_implemented.
 */
import { z } from "zod";
import { stubToolResult } from "@/server/_stub";
import { EV, aliasRef, defineTool } from "@/server/agent/tools/define";

/** `cancel_action` tool. */
export const cancelActionTool = defineTool({
  name: "cancel_action",
  description:
    "Cancel a pending action (an a_ id, e.g. an email draft or an account deletion request) when the student says not to do it.",
  input: z.strictObject({
    action: aliasRef("a", "a_ id of the pending action"),
    evidence: EV,
  }),
  mutates: true,
  run: async () => stubToolResult("3.3"),
});
