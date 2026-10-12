import "server-only";
// OWNER: 1.2

/**
 * First-contact templates (pure; V2-03 §2.7, open Q 8 → deterministic template). The welcome
 * always carries the AI disclosure (spec §3.22), asks for a name when we don't have one, and asks
 * the student to confirm a name that came from a signup match (5.5 #7).
 * The vCard follows as its own media send (`contactCardPlan`). When the user's first text was
 * only a greeting (`isGreetingOnly`), the pipeline stops after these; otherwise the agent runs too
 * with `identity.isNewUser = true` so it doesn't re-introduce itself.
 */
import type { ReplyPlan } from "@/server/channels/types";

// Built at runtime: `\p{…}` needs the `u` flag, which the ES2017 TS target rejects in literals.
const EMOJI_RE = new RegExp("[\\p{Extended_Pictographic}\\p{Emoji_Modifier}\\u{FE0F}\\u{200D}]", "gu");
const GREETING_RE =
  /^(?:he+y+|hi+|hii+ya|hiya|hello+|helo|yo+|sup|wassup|whats ?up|howdy|hola|heya|good (?:morning|afternoon|evening)|gm)(?:\s+(?:there|aria|girl|friend|bestie|you|again|hi|hey))*\s*[!.,~:)(]*$/i;

/**
 * Whether the first text is only a greeting ("hey", "hi aria!", "hello 👋"), so the welcome
 * alone is the right answer and the agent is skipped. Anything with content ("hi what's due")
 * or a question mark goes to the agent.
 * @param text inbound text
 * @returns true for a bare greeting
 */
export function isGreetingOnly(text: string): boolean {
  const t = text
    .normalize("NFKC")
    .replace(/[’']/g, "")
    .replace(EMOJI_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t || t.length > 30 || t.includes("?")) return false;
  return GREETING_RE.test(t);
}

/** A name token: letters (with combining marks), optionally joined by an apostrophe or hyphen. */
const NAME_TOKEN_RE = new RegExp("^\\p{L}\\p{M}*(?:['’-]?\\p{L}\\p{M}*)*$", "u");
/** Punctuation trimmed off the ends of the first token ("Sam!" → "Sam"). */
const NAME_EDGE_RE = new RegExp("^[^\\p{L}]+|[^\\p{L}\\p{M}]+$", "gu");

/**
 * First-name form of a stored name (first token, max 40 chars), or null when unusable. The name
 * may come from the landing form, which anyone can fill in for any number (5.5 #7), so only a
 * plain word of letters is echoed back (never digits, a domain, a link or markup).
 * @param name stored display name
 * @returns the name to greet with
 */
export function greetingName(name: string | null): string | null {
  const first = (name?.trim().split(/\s+/)[0] ?? "").normalize("NFC").replace(NAME_EDGE_RE, "");
  if (!first || first.length > 40) return null;
  return NAME_TOKEN_RE.test(first) ? first : null;
}

const INTRO = {
  casual: "hey! I'm Aria 👋 an AI assistant for school stuff — deadlines, your calendar, reminders, all over text",
  neutral: "Hi! I'm Aria, an AI assistant for your classes — deadlines, your calendar, and reminders, all over text.",
} as const;

/**
 * The deterministic welcome plan. Always 2 bubbles: the intro with the AI disclosure (spec §3.22),
 * then a name question. A name from a signup match is only a guess (anyone can type anyone's
 * number on the landing page), so it is confirmed ("you're Sam, right?") rather than assumed; the
 * agent handles "no, I'm X" with `update_profile`.
 * @param input known name (from a signup match) and the register to write in
 * @returns intro bubble + name confirmation (name known) or name question (unknown)
 */
export function welcomePlan(input: { name: string | null; register?: "casual" | "neutral" }): ReplyPlan {
  const name = greetingName(input.name);
  const casual = (input.register ?? "casual") === "casual";
  const ask = name
    ? casual
      ? `you're ${name}, right?`
      : `Just to check: you're ${name}, right?`
    : casual
      ? "what should I call you?"
      : "What should I call you?";
  return { bubbles: [{ text: casual ? INTRO.casual : INTRO.neutral }, { text: ask }] };
}

/**
 * The contact-card plan sent right after the welcome.
 * @param appBaseUrl `appBaseUrl()` (no trailing slash)
 * @returns a media-only plan pointing at `/aria.vcf`
 */
export function contactCardPlan(appBaseUrl: string): ReplyPlan {
  return { bubbles: [], media: [{ url: `${appBaseUrl.replace(/\/+$/, "")}/aria.vcf`, kind: "vcard" }] };
}
