// OWNER: 0.2 (frozen contract; only the orchestrator edits this file — master plan §1.0.2)

/**
 * `send_email` pending-action payload (master plan §1.17, conflict C16): V2-07 §9.2's
 * snake_case `SendEmailPayload` (`v: 1`) plus `original_rfc822_id` for the web permalink.
 * Pure, client-safe. The web edits only `subject` and `body_text`; recipients are read-only there.
 */
import { z } from "zod";

/** `pending_actions.payload` for kind `send_email`. */
export const SendEmailPayload = z.object({
  v: z.literal(1),
  /** integration.account_email at draft time */
  from: z.email(),
  to: z.array(z.email()).min(1).max(10),
  cc: z.array(z.email()).max(10),
  subject: z.string().max(250),
  body_text: z.string().max(20_000),
  thread_id: z.string().optional(),
  /** Message-ID of the target */
  in_reply_to: z.string().optional(),
  references: z.string().max(4000).optional(),
  reply_to_email_id: z.string().optional(),
  /** RFC 822 Message-ID of the email being replied to (Gmail permalink on /email/[id]) */
  original_rfc822_id: z.string().optional(),
});
/** Parsed `send_email` payload. */
export type SendEmailPayloadT = z.infer<typeof SendEmailPayload>;
