import "server-only";
// OWNER: 1.2

/**
 * Lenient zod schemas for Sendblue webhook payloads (V2-03 §3 "Webhooks"; docs.sendblue.com
 * `/getting-started/webhooks`, `/api-v2/typing-indicators`). Unknown fields pass through; every
 * documented field is optional or nullable so a minor payload change degrades to "ignored"
 * instead of a 500. Shapes marked [verify] are confirmed against real sandbox captures later
 * (V2-03 §12 items 3–4).
 */
import { z } from "zod";

const optStr = z.string().nullish();

/** `receive` / `outbound` webhook body (one message). */
export const SendblueMessagePayload = z.looseObject({
  accountEmail: optStr,
  content: optStr,
  is_outbound: z.boolean().nullish(),
  /** "RECEIVED" inbound; outbound: REGISTERED | PENDING | DECLINED | QUEUED | ACCEPTED | SENT | DELIVERED | ERROR */
  status: optStr,
  error_code: z.union([z.string(), z.number()]).nullish(),
  error_message: optStr,
  error_reason: optStr,
  error_key: optStr,
  message_handle: z.string().min(1),
  date_sent: optStr,
  date_updated: optStr,
  /** Sender (the user, inbound). Apple ID email senders: which field carries the email is [verify]. */
  from_number: optStr,
  /** The contact's number. */
  number: optStr,
  to_number: optStr,
  sendblue_number: optStr,
  was_downgraded: z.boolean().nullish(),
  plan: optStr,
  /** One URL; some accounts may send several [verify]. */
  media_url: z.union([z.string(), z.array(z.string())]).nullish(),
  message_type: optStr,
  group_id: optStr,
  participants: z.array(z.string()).nullish(),
  send_style: optStr,
  opted_out: z.boolean().nullish(),
  /** "iMessage" | "SMS" | "RCS" */
  service: optStr,
  group_display_name: optStr,
  reply_to: z.looseObject({ message_handle: optStr }).nullish(),
  thread_originator: z.looseObject({ message_handle: optStr }).nullish(),
});
/** Parsed `receive`/`outbound` payload. */
export type SendblueMessagePayload = z.output<typeof SendblueMessagePayload>;

/** `typing_indicator` webhook body. */
export const SendblueTypingPayload = z.looseObject({
  number: z.string().min(1),
  is_typing: z.boolean(),
  from_number: optStr,
  timestamp: z.union([z.string(), z.number()]).nullish(),
});
/** Parsed typing payload. */
export type SendblueTypingPayload = z.output<typeof SendblueTypingPayload>;

/** `send-message` response body (shape is [verify]; assumed to carry handle + status). */
export const SendblueSendResponse = z.looseObject({
  message_handle: optStr,
  status: optStr,
  service: optStr,
  was_downgraded: z.boolean().nullish(),
  error_key: optStr,
  error_code: z.union([z.string(), z.number()]).nullish(),
  error_message: optStr,
});
/** Parsed send response. */
export type SendblueSendResponse = z.output<typeof SendblueSendResponse>;

const LEGACY_TAPBACKS: Record<string, "love" | "like" | "dislike" | "laugh" | "emphasize" | "question"> = {
  loved: "love",
  liked: "like",
  disliked: "dislike",
  "laughed at": "laugh",
  emphasized: "emphasize",
  questioned: "question",
};
const LEGACY_REMOVED: Record<string, "love" | "like" | "dislike" | "laugh" | "emphasize" | "question"> = {
  "a heart": "love",
  "a like": "like",
  "a dislike": "dislike",
  "a laugh": "laugh",
  "an exclamation": "emphasize",
  "an exclamation mark": "emphasize",
  "a question mark": "question",
};
const QUOTED = "[“\"](?<snippet>[\\s\\S]*?)[”\"]";
const ADD_RE = new RegExp(`^(?<verb>Loved|Liked|Disliked|Laughed at|Emphasized|Questioned) ${QUOTED}$`);
const REMOVE_RE = new RegExp(
  `^Removed (?<what>a heart|a like|a dislike|a laugh|an exclamation mark|an exclamation|a question mark) from ${QUOTED}$`,
);
const EMOJI_ADD_RE = new RegExp(`^Reacted (?<emoji>\\S+) to ${QUOTED}$`, "u");
const EMOJI_REMOVE_RE = new RegExp(`^Removed (?:a )?(?<emoji>\\S+)(?: reaction)? from ${QUOTED}$`, "u");

/**
 * Parses the legacy text form of a tapback (`Loved “see you at 5”`, `Removed a heart from “…”`,
 * `Reacted 😂 to “…”`). Whether Sendblue delivers inbound tapbacks at all, and in this form, is
 * [verify]; the webhook parser only uses this when `parseTapbacks` is enabled.
 * @param text message content
 * @returns reaction, quoted snippet and removal flag, or null when it isn't a tapback
 */
export function parseTapbackText(
  text: string,
): { reaction: string; snippet: string; removed: boolean } | null {
  const t = text.trim();
  let m = ADD_RE.exec(t);
  if (m?.groups) {
    const reaction = LEGACY_TAPBACKS[m.groups.verb.toLowerCase()];
    if (reaction) return { reaction, snippet: m.groups.snippet, removed: false };
  }
  m = REMOVE_RE.exec(t);
  if (m?.groups) {
    const reaction = LEGACY_REMOVED[m.groups.what.toLowerCase()];
    if (reaction) return { reaction, snippet: m.groups.snippet, removed: true };
  }
  m = EMOJI_ADD_RE.exec(t);
  if (m?.groups) return { reaction: m.groups.emoji, snippet: m.groups.snippet, removed: false };
  m = EMOJI_REMOVE_RE.exec(t);
  if (m?.groups && !/^(?:a|an)$/i.test(m.groups.emoji)) {
    return { reaction: m.groups.emoji, snippet: m.groups.snippet, removed: true };
  }
  return null;
}
