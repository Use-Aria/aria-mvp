import "server-only";
// OWNER: 3.3

/**
 * Agent tool `confirm_preference` (master plan §1.4 #24; input per V2-04 §9.2).
 * Wave 0 stub: final name, description, input and flags; `run` returns not_implemented.
 */
import { z } from "zod";
import { stubToolResult } from "@/server/_stub";
import { EV, aliasRef, defineTool } from "@/server/agent/tools/define";

/** `confirm_preference` tool. */
export const confirmPreferenceTool = defineTool({
  name: "confirm_preference",
  description:
    "Record the student's answer to a pending preference question (its p_ id): confirm or reject. Evidence can be their reply text or a tapback (x_ id) on the question bubble.",
  input: z.strictObject({
    proposal: aliasRef("p", "p_ id of the proposed preference"),
    decision: z.enum(["confirm", "reject"]),
    evidence: EV,
  }),
  strict: true,
  mutates: true,
  run: async () => stubToolResult("3.3"),
});
