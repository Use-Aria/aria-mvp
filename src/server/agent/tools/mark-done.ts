import "server-only";
// OWNER: 3.3

/**
 * Agent tool `mark_done` (master plan §1.4 #5; input per V2-05 §9.3 (item = t_ alias)).
 * Wave 0 stub: final name, description, input and flags; `run` returns not_implemented.
 */
import { z } from "zod";
import { stubToolResult } from "@/server/_stub";
import { EV, aliasRef, defineTool } from "@/server/agent/tools/define";

/** `mark_done` tool. */
export const markDoneTool = defineTool({
  name: "mark_done",
  description:
    "Mark one deadline or event as done (or dismissed, or back to upcoming) when the student says they finished it or don't need it. item must be a t_ id shown in this run; evidence is the student's message that said so.",
  input: z.strictObject({
    item: aliasRef("t", "t_ id of the deadline or event"),
    status: z.enum(["done", "dismissed", "upcoming"]).default("done"),
    evidence: EV,
  }),
  strict: true,
  mutates: true,
  run: async () => stubToolResult("3.3"),
});
