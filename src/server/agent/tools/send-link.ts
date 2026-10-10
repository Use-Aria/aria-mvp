import "server-only";
// OWNER: 3.3

/**
 * Agent tool `send_link` (master plan §1.4 #2; input per V2-04 §9.2).
 * Wave 0 stub: final name, description, input and flags; `run` returns not_implemented.
 */
import { z } from "zod";
import { stubToolResult } from "@/server/_stub";
import { aliasRef, defineTool } from "@/server/agent/tools/define";

/** `send_link` tool. */
export const sendLinkTool = defineTool({
  name: "send_link",
  description:
    "Mint a private one-tap link to one of Aria's web pages and get back a handle like \"L1\" to put in the reply's link field (never write URLs yourself). kind: week (their week), setup or connect_canvas (setup page), settings, connect_google, email_draft (action = the a_ id of a pending email draft; otherwise null).",
  input: z.strictObject({
    kind: z.enum(["week", "setup", "connect_google", "connect_canvas", "settings", "email_draft"]),
    action: aliasRef("a").nullable(),
  }),
  strict: true,
  run: async () => stubToolResult("3.3"),
});
