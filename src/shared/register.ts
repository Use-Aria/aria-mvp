/**
 * Register heuristic over a user's recent texts (master plan §1.8, V2-04 §2.9, V2-03 interim).
 * Pure and deterministic. Feeds the `<aria_now>` register hint, interim lines, and the
 * casual/neutral template choice (`templateRegister` in `persona-prefs.ts`).
 */

/** Features of how a user texts. */
export interface RegisterHint {
  /** Mean words per message, 1 decimal. 0 when there are no texts. */
  avgWords: number;
  /** Share (0–1, 2 decimals) of messages with letters that contain no uppercase letter. */
  lowercaseShare: number;
  /** Emoji per message (2 decimals). */
  emojiRate: number;
  /** Slang tokens seen, most frequent first (ties: first seen), at most 5. */
  slang: string[];
  /** Capitalized, punctuated, no slang/emoji: answer without slang or emoji. */
  formal: boolean;
}

/** Most recent texts considered. */
const MAX_TEXTS = 30;
const MAX_SLANG = 5;

const SLANG = new Set([
  "lol", "lmao", "lmfao", "lmk", "idk", "idc", "bet", "ts", "fr", "frfr", "ngl", "tbh", "rn",
  "omw", "pls", "plz", "thx", "ty", "tysm", "u", "ur", "gonna", "wanna", "gotta", "tmrw",
  "tmr", "imo", "bc", "cuz", "nah", "bruh", "lowkey", "highkey", "deadass", "sus", "istg",
  "smh", "ong", "finna", "aight", "kk", "k", "wyd", "hbu", "np", "btw", "omg", "yall",
  "y'all", "gn", "gm", "ik", "iykyk", "fs", "def", "prob", "rly", "sm",
]);

const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;
// Built at runtime: `\p{…}` needs the `u` flag, which the ES2017 TS target rejects in literals.
const EMOJI_RE = new RegExp("\\p{Extended_Pictographic}", "gu");
/** Skin tones and variation selectors (dropped before counting). */
const EMOJI_MODIFIER_RE = new RegExp("[\\u{1F3FB}-\\u{1F3FF}\\u{FE0F}]", "gu");
/** ZWJ-joined tails, so a family/profession sequence counts as one emoji. */
const EMOJI_JOIN_RE = new RegExp("\\u{200D}\\p{Extended_Pictographic}", "gu");

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/**
 * Computes register features from the user's own recent texts (user-authored only).
 * @param userTexts recent inbound texts, oldest first; only the last 30 are used
 * @returns the hint; all-zero / non-formal when there is nothing to go on
 */
export function computeRegisterHint(userTexts: string[]): RegisterHint {
  const texts = userTexts
    .slice(-MAX_TEXTS)
    .map((t) => t.replace(URL_RE, " ").trim())
    .filter((t) => t.length > 0);
  if (texts.length === 0) {
    return { avgWords: 0, lowercaseShare: 0, emojiRate: 0, slang: [], formal: false };
  }

  let words = 0;
  let cased = 0;
  let lower = 0;
  let emoji = 0;
  let capitalized = 0;
  let punctuated = 0;
  const counts = new Map<string, { n: number; first: number }>();
  let order = 0;

  for (const text of texts) {
    words += text.split(/\s+/).filter(Boolean).length;
    if (/[A-Za-z]/.test(text)) {
      cased += 1;
      if (!/[A-Z]/.test(text)) lower += 1;
      if (/^[^A-Za-z]*[A-Z]/.test(text)) capitalized += 1;
    }
    const bare = text.replace(EMOJI_MODIFIER_RE, "").replace(EMOJI_JOIN_RE, "");
    emoji += (bare.match(EMOJI_RE) ?? []).length;
    if (/[.?!]["')\]]?$/.test(text)) punctuated += 1;
    for (const token of text.toLowerCase().replace(/[’]/g, "'").split(/[^a-z']+/)) {
      const tok = token.replace(/^'+|'+$/g, "");
      if (!tok || !SLANG.has(tok)) continue;
      const c = counts.get(tok);
      if (c) c.n += 1;
      else counts.set(tok, { n: 1, first: order++ });
    }
  }

  const slang = [...counts.entries()]
    .sort((a, b) => b[1].n - a[1].n || a[1].first - b[1].first)
    .slice(0, MAX_SLANG)
    .map(([tok]) => tok);
  const n = texts.length;
  const lowercaseShare = cased === 0 ? 0 : round(lower / cased, 2);
  const emojiRate = round(emoji / n, 2);
  const formal =
    slang.length === 0 &&
    emoji === 0 &&
    cased > 0 &&
    lower / cased <= 0.2 &&
    capitalized / cased >= 0.6 &&
    punctuated / n >= 0.5;

  return { avgWords: round(words / n, 1), lowercaseShare, emojiRate, slang, formal };
}

/**
 * Collapses a hint into the two template registers.
 * No signal (no texts) → "casual" (Aria's default voice). Formal → "neutral".
 * Mostly lowercase, any slang, or frequent emoji → "casual"; otherwise "neutral".
 * @param h hint from `computeRegisterHint`
 * @returns "casual" | "neutral"
 */
export function registerClass(h: RegisterHint): "casual" | "neutral" {
  if (h.avgWords === 0) return "casual";
  if (h.formal) return "neutral";
  if (h.lowercaseShare >= 0.5 || h.slang.length > 0 || h.emojiRate >= 0.3) return "casual";
  return "neutral";
}
