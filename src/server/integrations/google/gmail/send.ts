import "server-only";
// OWNER: 4.3

/**
 * The ONLY email-sending code path (V2-07 §2.12 "send_email executor"; friend-protection 1).
 * Called solely by the `send_email` pending-action executor, i.e. after the student confirmed a
 * `pending_actions` row (chat `confirm_action` in a later turn, or the web confirm). The model has
 * no send tool. This is the only module allowed to import `sendRaw` (source-scan test in
 * `tests/unit/google/mime.test.ts`).
 *
 *  1. Re-validate the payload (`SendEmailPayload`); the integration must be active, hold
 *     `gmail.send`, and still be the account the draft was written for.
 *  2. Build the RFC 5322 message (`buildRawMessage`: CR/LF in any header throws) with a
 *     deterministic `Message-ID: <aria.<actionId>@<sender domain>>`, plus `In-Reply-To` /
 *     `References` and the Gmail `threadId` for replies.
 *  3. `messages.send`. A transient failure first checks the sent folder for our Message-ID (the
 *     send may have gone through) before reporting failure — never a blind resend.
 *
 * `recoverSendEmail` answers "did it go out?" for rows stuck in `executing` (sent-folder lookup by
 * `rfc822msgid:`). Disconnected Google → `{ok:false, error: GOOGLE_DISCONNECTED}`.
 */
import { GOOGLE_DISCONNECTED } from "@/server/agent/pending/actions";
import type { ExecResult } from "@/server/agent/pending/types";
import { featuresFor } from "@/server/integrations/google/config";
import { GoogleApiError, GoogleAuthRevokedError, GoogleNotConnectedError } from "@/server/integrations/google/errors";
import { getGoogleIntegration } from "@/server/integrations/google/store";
import { GMAIL_ID_RE, listMessageIds, sendRaw, type GmailApiDeps } from "@/server/integrations/google/gmail/api";
import { buildRawMessage, isValidEmail, type OutgoingEmail } from "@/server/integrations/google/gmail/mime";
import { SendEmailPayload, type SendEmailPayloadT } from "@/shared/email-draft";

/** HTTP seam (tests / smoke inject a fake Gmail). */
export type SendDeps = GmailApiDeps;

const MSG_ID_TOKEN = /^<[^<>\s]+>$/;
const REFS = /^(<[^<>\s]+>)( <[^<>\s]+>)*$/;
const ACTION_ID = /^[0-9a-f-]{8,64}$/i;

/**
 * Deterministic Message-ID for a confirmed action (used to find it in the sent folder later). Pure.
 * @param actionId pending_actions.id
 * @param fromAddress sender address (its domain is the right-hand side)
 * @returns `<aria.<actionId>@<domain>>`
 */
export function ariaMessageId(actionId: string, fromAddress: string): string {
  if (!ACTION_ID.test(actionId)) throw new Error("send: invalid action id");
  const domain = fromAddress.slice(fromAddress.lastIndexOf("@") + 1).toLowerCase();
  const rhs = /^[a-z0-9.-]+$/.test(domain) && domain.includes(".") ? domain : "aria.local";
  return `<aria.${actionId.toLowerCase()}@${rhs}>`;
}

/**
 * Gmail search that finds our sent message. Pure.
 * @param messageId `ariaMessageId(…)`
 * @returns `in:sent rfc822msgid:<id without brackets>`
 */
export function sentFolderQuery(messageId: string): string {
  return `in:sent rfc822msgid:${messageId.replace(/^<|>$/g, "")}`;
}

/**
 * User-facing summary posted after a confirm (the web path shows it as "<summary> ✅"). Pure.
 * @param p payload
 * @returns e.g. "Sent your reply to lee@yale.edu" / "Sent your email to a@x.com and 2 others"
 */
export function sentSummary(p: Pick<SendEmailPayloadT, "to" | "cc" | "in_reply_to" | "reply_to_email_id">): string {
  const first = p.to[0] ?? "them";
  const others = p.to.length - 1 + p.cc.length;
  const who = others > 0 ? `${first} and ${others} other${others === 1 ? "" : "s"}` : first;
  const what = p.in_reply_to || p.reply_to_email_id ? "reply" : "email";
  return `Sent your ${what} to ${who}`;
}

/**
 * The outgoing message for a payload. Pure. Invalid threading headers are dropped (the message
 * still sends, just unthreaded) rather than failing the user's confirmed send.
 * @param p validated payload
 * @param actionId pending_actions.id (Message-ID)
 * @returns message fields for `buildRawMessage`
 */
export function outgoingFor(p: SendEmailPayloadT, actionId: string): OutgoingEmail {
  const inReplyTo = p.in_reply_to && MSG_ID_TOKEN.test(p.in_reply_to.trim()) ? p.in_reply_to.trim() : undefined;
  const refs = p.references?.trim();
  return {
    from: p.from,
    to: p.to,
    cc: p.cc,
    subject: p.subject.replace(/[\r\n]+/g, " "),
    bodyText: p.body_text,
    messageId: ariaMessageId(actionId, p.from),
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(inReplyTo && refs && REFS.test(refs) ? { references: refs } : inReplyTo ? { references: inReplyTo } : {}),
  };
}

function isAuthGone(e: unknown): boolean {
  if (e instanceof GoogleAuthRevokedError || e instanceof GoogleNotConnectedError) return true;
  return e instanceof GoogleApiError && (e.status === 401 || (e.status === 403 && /insufficient|permission|scope/i.test(e.reason ?? "")));
}

async function foundInSent(userId: string, messageId: string, deps?: SendDeps): Promise<boolean> {
  const ids = await listMessageIds(userId, sentFolderQuery(messageId), { max: 1 }, deps);
  return ids.length > 0;
}

/**
 * Send a confirmed `send_email` action (executor body). At-most-once is enforced by the pending
 * framework (atomic pending→executing); this function never retries a send on its own.
 * @param a owner, action id, payload (re-validated here)
 * @param deps HTTP seam (tests / smoke)
 * @returns executor result: `{ok:true, summary, result:{gmail_message_id, thread_id, rfc822_message_id, sent_at}}`,
 *   or `{ok:false, error}` (`GOOGLE_DISCONNECTED` when Google is disconnected/revoked or lacks `gmail.send`)
 */
export async function executeSendEmail(
  a: { userId: string; actionId: string; payload: unknown },
  deps?: SendDeps,
): Promise<ExecResult> {
  const parsed = SendEmailPayload.safeParse(a.payload);
  if (!parsed.success) return { ok: false, error: "invalid_payload", retryable: false };
  const p = parsed.data;
  if (![p.from, ...p.to, ...p.cc].every((x) => isValidEmail(x))) return { ok: false, error: "invalid_recipient", retryable: false };

  const integ = await getGoogleIntegration(a.userId);
  if (!integ || integ.status !== "active" || !featuresFor(integ.scopes ?? []).has("gmail_send")) {
    return { ok: false, error: GOOGLE_DISCONNECTED, retryable: false };
  }
  if ((integ.account_email ?? "").trim().toLowerCase() !== p.from.trim().toLowerCase()) {
    return { ok: false, error: "account_changed", retryable: false };
  }

  let raw: string;
  let messageId: string;
  try {
    const out = outgoingFor(p, a.actionId);
    messageId = out.messageId;
    raw = buildRawMessage(out);
  } catch {
    return { ok: false, error: "invalid_message", retryable: false };
  }
  const threadId = p.thread_id && GMAIL_ID_RE.test(p.thread_id) ? p.thread_id : undefined;

  try {
    const sent = await sendRaw(a.userId, raw, threadId, deps);
    return {
      ok: true,
      summary: sentSummary(p),
      result: { gmail_message_id: sent.id, thread_id: sent.threadId, rfc822_message_id: messageId, sent_at: new Date().toISOString() },
    };
  } catch (e) {
    if (isAuthGone(e)) return { ok: false, error: GOOGLE_DISCONNECTED, retryable: false };
    if (e instanceof GoogleApiError && (e.retryable || e.status === 0)) {
      // The request may have reached Gmail: look before declaring failure (never resend here).
      try {
        if (await foundInSent(a.userId, messageId, deps)) {
          return { ok: true, summary: sentSummary(p), result: { rfc822_message_id: messageId, recovered: true, sent_at: new Date().toISOString() } };
        }
      } catch {
        /* fall through to the failure */
      }
      return { ok: false, error: `send_failed:${e.status}`, retryable: true };
    }
    if (e instanceof GoogleApiError) return { ok: false, error: `send_rejected:${e.status}`, retryable: false };
    throw e;
  }
}

/**
 * Did a stuck (`executing` > 5 min) send actually go out? Sent-folder lookup by our Message-ID.
 * @param a owner, action id, payload (for the sender domain)
 * @param deps HTTP seam (tests / smoke)
 * @returns "done" when found; "not_done" when not found or Google is gone (can't send anyway)
 * @throws GoogleApiError on a transient lookup failure (the row stays `executing` for a later sweep)
 */
export async function recoverSendEmail(
  a: { userId: string; actionId: string; payload: Pick<SendEmailPayloadT, "from"> },
  deps?: SendDeps,
): Promise<"done" | "not_done"> {
  try {
    return (await foundInSent(a.userId, ariaMessageId(a.actionId, a.payload.from), deps)) ? "done" : "not_done";
  } catch (e) {
    if (isAuthGone(e)) return "not_done";
    throw e;
  }
}
