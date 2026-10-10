import "server-only";
// OWNER: 1.2

/**
 * First-contact templates (pure; V2-03 §2.7, open Q 8 → deterministic template). The welcome
 * always carries the AI disclosure (spec §3.22) and asks for a name when we don't have one.
 * The vCard follows as its own media send (`contactCardPlan`). When the user's first text was
 * only a greeting (`isGreetingOnly`), the pipeline stops after these; otherwise the agent runs too
 * with `identity.isNewUser = true` so it doesn't re-introduce itself.
 */
import type { ReplyPlan } from "@/server/channels/types";

// Built at runtime: `\p{…}` needs the `u` flag, which the ES2017 TS target rejects in literals.
const EMOJI_RE = new RegExp("[\\p{Extended_Pictographic}\\p{Emoji_Modifier}\\u{FE0F}\\u{200D}]", "gu");
const LETTER_RE = new RegExp("\\p{L}", "u");
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

/**
 * First-name form of a stored name (first token, max 40 chars), or null when unusable.
 * @param name stored display name
 * @returns the name to greet with
 */
export function greetingName(name: string | null): string | null {
  const first = name?.trim().split(/\s+/)[0]?.slice(0, 40) ?? "";
  return LETTER_RE.test(first) ? first : null;
}

/**
 * The deterministic welcome plan.
 * @param input known name (from a signup match) and the register to write in
 * @returns 1–2 bubbles: intro with AI disclosure, plus the name question when the name is unknown
 */
export function welcomePlan(input: { name: string | null; register?: "casual" | "neutral" }): ReplyPlan {
  const name = greetingName(input.name);
  const casual = (input.register ?? "casual") === "casual";
  if (name) {
    return {
      bubbles: [
        {
          text: casual
            ? `hey ${name}! I'm Aria 👋 an AI assistant for school stuff — deadlines, your calendar, reminders, all over text`
            : `Hi ${name}! I'm Aria, an AI assistant for your classes — deadlines, your calendar, and reminders, all over text.`,
        },
      ],
    };
  }
  return {
    bubbles: [
      {
        text: casual
          ? "hey! I'm Aria 👋 an AI assistant for school stuff — deadlines, your calendar, reminders, all over text"
          : "Hi! I'm Aria, an AI assistant for your classes — deadlines, your calendar, and reminders, all over text.",
      },
      { text: casual ? "what should I call you?" : "What should I call you?" },
    ],
  };
}

/**
 * The contact-card plan sent right after the welcome.
 * @param appBaseUrl `appBaseUrl()` (no trailing slash)
 * @returns a media-only plan pointing at `/aria.vcf`
 */
export function contactCardPlan(appBaseUrl: string): ReplyPlan {
  return { bubbles: [], media: [{ url: `${appBaseUrl.replace(/\/+$/, "")}/aria.vcf`, kind: "vcard" }] };
}
