import "server-only";
// OWNER: 3.3

/**
 * Agent tool `send_interim` (master plan §1.4 #1; input per V2-04 §9.2).
 * Wave 0 stub: final name, description, input and flags; `run` returns not_implemented.
 */
import { z } from "zod";
import { stubToolResult } from "@/server/_stub";
import { defineTool } from "@/server/agent/tools/define";

/** `send_interim` tool. */
export const sendInterimTool = defineTool({
  name: "send_interim",
  description:
    "Send one short interim bubble right now (e.g. 'give me a sec 👀') while you keep working. Call it in the SAME response as a slow tool such as search_email or find_free_slots. At most once per run; never on proactive runs.",
  input: z.strictObject({ text: z.string().min(1).max(120) }),
  run: async () => stubToolResult("3.3"),
});
