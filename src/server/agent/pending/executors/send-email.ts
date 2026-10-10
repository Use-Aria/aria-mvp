import "server-only";
// OWNER: 4.3

/**
 * `send_email` executor (master plan §1.5; V2-07 §2.12). Runs only after the student confirmed
 * the pending action (`confirmPendingAction`: chat in a later turn, or web). Body in
 * `gmail/send.ts` (the only module that may import `sendRaw`): re-validate, check account +
 * `gmail.send`, send a threaded message with Message-ID `<aria.<actionId>@<sender domain>>`.
 * `recover` (rows stuck in `executing` > 5 min) searches the sent folder for that Message-ID.
 * Failures are terminal; a disconnected Google returns `GOOGLE_DISCONNECTED`.
 */
import { definePendingAction } from "@/server/agent/pending/types";
import { executeSendEmail, recoverSendEmail } from "@/server/integrations/google/gmail/send";
import { SendEmailPayload } from "@/shared/email-draft";

/** Executor for `send_email` (24h TTL). */
export const sendEmailExecutor = definePendingAction({
  kind: "send_email",
  payload: SendEmailPayload,
  ttlMs: 24 * 60 * 60_000,
  describe: (p) => `send the email "${p.subject}" to ${p.to.join(", ")}`,
  execute: (ctx, p) => executeSendEmail({ userId: ctx.userId, actionId: ctx.actionId, payload: p }),
  recover: (ctx, p) => recoverSendEmail({ userId: ctx.userId, actionId: ctx.actionId, payload: p }),
});
