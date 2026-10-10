import "server-only";
// OWNER: 2.2

/**
 * Ack-only fast path (V2-04 §2.9): when every new message is a bare acknowledgement ("ok",
 * "bet", "ty", "👍") and nothing is waiting on the student, Aria answers with a tapback and no
 * model call. Pure.
 */
import type { ClassicTapback } from "@/server/channels/types";

/** Agent state that blocks the fast path. */
export interface AckState {
  /** a preference question is open ("sure" might be its answer) */
  openQuestion: boolean;
  /** pending actions awaiting confirmation */
  pendingActions: number;
  /** Aria's last message ended with a question */
  lastAriaAskedQuestion: boolean;
}

type AckKind = "like" | "love" | "laugh";

/** Word acks → reaction. "sure", "yes", "yeah" are never acks (they answer questions). */
const WORD_ACKS: ReadonlyMap<string, AckKind> = new Map<string, AckKind>([
  ["ok", "like"],
  ["okay", "like"],
  ["okk", "like"],
  ["k", "like"],
  ["kk", "like"],
  ["bet", "like"],
  ["cool", "like"],
  ["nice", "like"],
  ["sounds good", "like"],
  ["got it", "like"],
  ["gotcha", "like"],
  ["ty", "love"],
  ["tysm", "love"],
  ["thx", "love"],
  ["thanks", "love"],
  ["thank you", "love"],
  ["thank u", "love"],
  ["lol", "laugh"],
  ["lmao", "laugh"],
]);

const LAUGH_RE = /^(?:ha){2,}h?$|^(?:he){2,}$/;
const EMOJI_ACKS: ReadonlyMap<string, AckKind> = new Map<string, AckKind>([
  ["👍", "like"],
  ["👌", "like"],
  ["❤", "love"],
  ["♥", "love"],
  ["🙏", "love"],
  ["😂", "laugh"],
  ["🤣", "laugh"],
]);
/** Variation selectors and skin tones (dropped before matching). */
const EMOJI_MOD_RE = new RegExp("[\\u{FE0E}\\u{FE0F}\\u{1F3FB}-\\u{1F3FF}]", "gu");
const MAX_ACK_PARTS = 3;

/** Classify one text: an ack kind, or null when it's anything else. */
function classifyOne(text: string): AckKind | null {
  const t = text.replace(EMOJI_MOD_RE, "").trim().toLowerCase();
  if (!t) return null;
  // Emoji-only ("👍", "👍👍", "❤️").
  const chars = [...t.replace(/\s+/g, "")];
  if (chars.length <= 3 && chars.every((c) => EMOJI_ACKS.has(c))) return EMOJI_ACKS.get(chars[chars.length - 1]) ?? null;
  // Words: up to 3 ack phrases ("ok ty", "cool thanks!!"), trailing punctuation/emoji tolerated.
  const cleaned = t
    .replace(/[!.,~]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const trailingEmoji = [...cleaned].filter((c) => EMOJI_ACKS.has(c));
  const words = [...cleaned].filter((c) => !EMOJI_ACKS.has(c)).join("").trim();
  if (!words) return null;
  let kind: AckKind | null = null;
  let rest = words;
  for (let parts = 0; rest && parts < MAX_ACK_PARTS; parts++) {
    const match = [...WORD_ACKS.keys()]
      .filter((k) => rest === k || rest.startsWith(`${k} `))
      .sort((a, b) => b.length - a.length)[0];
    const laugh = rest.split(" ")[0];
    if (match) {
      kind = WORD_ACKS.get(match) ?? kind;
      rest = rest.slice(match.length).trim();
    } else if (LAUGH_RE.test(laugh)) {
      kind = "laugh";
      rest = rest.slice(laugh.length).trim();
    } else {
      return null;
    }
  }
  if (rest) return null;
  if (trailingEmoji.length > 0) kind = EMOJI_ACKS.get(trailingEmoji[trailingEmoji.length - 1]) ?? kind;
  return kind;
}

/**
 * Whether a message from Aria ends with a question (so a short reply may be an answer).
 * @param text Aria's last bubble
 * @returns true if it ends with "?" (trailing emoji/space ignored)
 */
export function endsWithQuestion(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.replace(EMOJI_MOD_RE, "").replace(new RegExp("[\\s\\p{Extended_Pictographic}]+$", "u"), "");
  return /[?？]["')\]]?$/.test(t);
}

/**
 * Ack-only fast path. Fires only when (a) every new text is an ack, (b) no preference question
 * is open, (c) no actions are pending and (d) Aria's last message wasn't a question.
 * @param texts this run's new inbound texts (pass "" for a media-only message: it blocks)
 * @param state blocking state
 * @returns the tapback for the newest message, or null to run the model
 */
export function classifyAckOnly(texts: readonly string[], state: AckState): ClassicTapback | null {
  if (texts.length === 0 || state.openQuestion || state.pendingActions > 0 || state.lastAriaAskedQuestion) return null;
  let kind: AckKind | null = null;
  for (const t of texts) {
    const k = classifyOne(t);
    if (!k) return null;
    kind = k;
  }
  return kind;
}
