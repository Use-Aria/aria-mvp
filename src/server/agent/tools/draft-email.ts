import "server-only";
// OWNER: 4.3

/**
 * Agent tool `draft_email` (master plan §1.4 #18; V2-07 §2.12, §9.2). Writes a draft and stores
 * it as a `send_email` pending action (24h). It NEVER sends — `confirm_action` in a later turn
 * (or the web confirm) runs the executor. Body in `gmail/draft.ts` (recipient safety, Sonnet
 * `draft` route, untrusted wrapping). With `revise` (a_ id) the old draft is superseded; a reply
 * revision may omit `email` (the old draft's target is reused).
 */
import { z } from "zod";
import { EV, aliasRef, defineTool } from "@/server/agent/tools/define";
import { draftEmail } from "@/server/integrations/google/gmail/draft";

const input = z
  .strictObject({
    mode: z.enum(["reply", "new"]),
    /** required when mode=reply (unless revising a reply draft) */
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
    if (v.mode === "reply" && v.email === undefined && v.revise === undefined) {
      c.addIssue({ code: "custom", message: "mode reply needs email" });
    }
    if (v.mode === "new" && (v.to === undefined || v.to.length === 0)) {
      c.addIssue({ code: "custom", message: "mode new needs at least one address in to" });
    }
  });

/** `draft_email` tool. */
export const draftEmailTool = defineTool({
  name: "draft_email",
  description:
    "Write an email draft for the student to review; it NEVER sends. Reply to an email (mode reply + its e_ id) or write a new one (mode new + addresses the student gave you). To change an existing draft pass revise (its a_ id). Then show the draft and say it's ready to send once they confirm.",
  input,
  mutates: true,
  untrustedOutput: true,
  slow: true,
  run: (ctx, i) => draftEmail(ctx, i),
});
