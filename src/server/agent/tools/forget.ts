import "server-only";
// OWNER: 3.3

/**
 * Agent tool `forget` (master plan §1.4 #25; input per V2-04 §9.2 (facts hard-deleted)).
 * Wave 0 stub: final name, description, input and flags; `run` returns not_implemented.
 */
import { z } from "zod";
import { stubToolResult } from "@/server/_stub";
import { EV, defineTool } from "@/server/agent/tools/define";

/** `forget` tool. */
export const forgetTool = defineTool({
  name: "forget",
  description:
    "Forget remembered facts or preferences the student wants gone (f_/p_ ids shown in this run via recall or list_memory). Facts are permanently deleted; preferences are retired.",
  input: z.strictObject({
    items: z
      .array(z.string().regex(/^[fp]_[0-9a-f]{8,10}$/))
      .min(1)
      .max(5),
    evidence: EV,
  }),
  strict: true,
  mutates: true,
  run: async () => stubToolResult("3.3"),
});
