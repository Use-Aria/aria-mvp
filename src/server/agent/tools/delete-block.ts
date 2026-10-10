import "server-only";
// OWNER: 4.2

/**
 * Agent tool `delete_block` (master plan §1.4 #15; input per V2-07 §9.2 (block = t_ alias; + evidence)).
 * Wave 0 stub: final name, description, input and flags; `run` returns not_implemented.
 */
import { z } from "zod";
import { stubToolResult } from "@/server/_stub";
import { EV, aliasRef, defineTool } from "@/server/agent/tools/define";

/** `delete_block` tool. */
export const deleteBlockTool = defineTool({
  name: "delete_block",
  description:
    "Delete an Aria calendar block (the t_ id of a block Aria created) when the student asks to remove it. Only blocks on the Aria calendar can be deleted; their other events are read-only.",
  input: z.strictObject({
    block: aliasRef("t", "t_ id of an Aria block"),
    evidence: EV,
  }),
  mutates: true,
  run: async () => stubToolResult("4.2"),
});
