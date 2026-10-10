import "server-only";
// OWNER: 3.3

/**
 * Agent tool `confirm_action` (master plan §1.4 #27; input per V2-04 §9.2).
 * Wave 0 stub: final name, description, input and flags; `run` returns not_implemented.
 */
import { z } from "zod";
import { stubToolResult } from "@/server/_stub";
import { EV, aliasRef, defineTool } from "@/server/agent/tools/define";

/** `confirm_action` tool. */
export const confirmActionTool = defineTool({
  name: "confirm_action",
  description:
    "Carry out a pending action (an a_ id, e.g. an email draft or an account deletion) after the student clearly confirmed it in a later message. Never in the same turn that created it.",
  input: z.strictObject({
    action: aliasRef("a", "a_ id of the pending action"),
    evidence: EV,
  }),
  strict: true,
  mutates: true,
  run: async () => stubToolResult("3.3"),
});
