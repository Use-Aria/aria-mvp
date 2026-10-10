import "server-only";
// OWNER: 4.2

/**
 * Agent tool `move_block` (master plan §1.4 #14; input per V2-07 §9.2 (block = t_ alias; + evidence)).
 * Wave 0 stub: final name, description, input and flags; `run` returns not_implemented.
 */
import { z } from "zod";
import { stubToolResult } from "@/server/_stub";
import { EV, aliasRef, defineTool } from "@/server/agent/tools/define";

/** `move_block` tool. */
export const moveBlockTool = defineTool({
  name: "move_block",
  description:
    "Move an existing Aria calendar block (the t_ id of a block Aria created) to a new start and end time when the student asks to reschedule it. Only Aria's own blocks can be moved.",
  input: z.strictObject({
    block: aliasRef("t", "t_ id of an Aria block"),
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
    evidence: EV,
  }),
  mutates: true,
  run: async () => stubToolResult("4.2"),
});
