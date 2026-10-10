import "server-only";
// OWNER: 4.3

/**
 * `send_email` executor (master plan §1.5; V2-07 §2.12): re-validates, checks account + scope,
 * sends a threaded message via `gmail/send.ts`, and on `recover` searches the sent folder for
 * `rfc822msgid:aria.<actionId>@<host>`. Wave 0 stub.
 */
import { notImplemented } from "@/server/_stub";
import { definePendingAction } from "@/server/agent/pending/types";
import { SendEmailPayload } from "@/shared/email-draft";

/** Executor for `send_email` (24h TTL). */
export const sendEmailExecutor = definePendingAction({
  kind: "send_email",
  payload: SendEmailPayload,
  ttlMs: 24 * 60 * 60_000,
  describe: (p) => `send the email "${p.subject}" to ${p.to.join(", ")}`,
  execute: async () => {
    throw notImplemented("4.3");
  },
  recover: async () => {
    throw notImplemented("4.3");
  },
});
