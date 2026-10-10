import "server-only";
// OWNER: 4.2

/**
 * Agent tool `create_block` (master plan §1.4 #13; input per V2-07 §9.2 (slot = s_ alias or explicit start/end; + evidence)).
 * Wave 0 stub: final name, description, input and flags; `run` returns not_implemented.
 */
import { z } from "zod";
import { stubToolResult } from "@/server/_stub";
import { EV, aliasRef, defineTool } from "@/server/agent/tools/define";

/** `create_block` tool. */
export const createBlockTool = defineTool({
  name: "create_block",
  description:
    "Put a block on the student's dedicated Aria Google calendar (never their other calendars). Only after the student picked or accepted a specific time: pass slot (an s_ id from find_free_slots) or an explicit start and end.",
  input: z
    .strictObject({
      title: z.string().min(1).max(100),
      slot: aliasRef("s", "s_ id from find_free_slots").optional(),
      start: z.iso.datetime({ offset: true }).optional(),
      end: z.iso.datetime({ offset: true }).optional(),
      description: z.string().max(500).optional(),
      allow_overlap: z
        .boolean()
        .default(false)
        .describe("true only if the user explicitly wants it despite a conflict"),
      evidence: EV,
    })
    .superRefine((v, c) => {
      const explicit = v.start !== undefined && v.end !== undefined;
      if ((v.slot === undefined) === !explicit) {
        c.addIssue({ code: "custom", message: "pass either slot or both start and end" });
      }
    }),
  mutates: true,
  run: async () => stubToolResult("4.2"),
});
