import "server-only";
// OWNER: 4.3

/**
 * Agent tool `draft_email` (master plan §1.4 #18; input per V2-07 §9.2 (email = e_ alias, revise = a_ alias; + evidence)).
 * Wave 0 stub: final name, description, input and flags; `run` returns not_implemented.
 */
import { z } from "zod";
import { stubToolResult } from "@/server/_stub";
import { EV, aliasRef, defineTool } from "@/server/agent/tools/define";

/** `draft_email` tool. */
export const draftEmailTool = defineTool({
  name: "draft_email",
  description:
    "Write an email draft for the student to review; it NEVER sends. Reply to an email (mode reply + its e_ id) or write a new one (mode new + addresses the student gave you). To change an existing draft pass revise (its a_ id). Then show the draft and say it's ready to send once they confirm.",
  input: z
    .strictObject({
      mode: z.enum(["reply", "new"]),
      /** required when mode=reply */
      email: aliasRef("e", "e_ id of the email to reply to").optional(),
      reply_all: z.boolean().default(false),
      /** required when mode=new */
      to: z.array(z.email()).max(10).optional(),
      cc: z.array(z.email()).max(10).optional(),
      /** new mode only; replies reuse "Re: <original>" */
      subject: z.string().max(200).optional(),
      intent: z.string().min(1).max(1500).describe("What the user wants to say, in their words"),
      revise: aliasRef("a", "a_ id of the pending draft to revise").optional(),
      evidence: EV,
    })
    .superRefine((v, c) => {
      if (v.mode === "reply" && v.email === undefined) {
        c.addIssue({ code: "custom", message: "mode reply needs email" });
      }
      if (v.mode === "new" && (v.to === undefined || v.to.length === 0)) {
        c.addIssue({ code: "custom", message: "mode new needs at least one address in to" });
      }
    }),
  mutates: true,
  untrustedOutput: true,
  slow: true,
  run: async () => stubToolResult("4.3"),
});
