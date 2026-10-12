import "server-only";
// OWNER: 3.2 (Wave 5R gate fix H)

/**
 * Draft intent (Wave 5R gate fix H): whether the student's OWN text in this run asks Aria to write
 * an email. The loop (`agent/loop.ts`) uses it to gate `draft_email` once the run is action-locked
 * (it read email or syllabus document text): an injected email can talk the model into drafting
 * ("reply to backup@evil.example…"), so after such a read a draft is allowed only when the student
 * asked for one. Pure; deterministic; English only.
 *
 * Input is ONLY `ToolCtx.userText` (the user-authored inbound batch of this run), never email,
 * Canvas, calendar or syllabus text.
 *
 * Deliberately conservative: a miss costs one turn (the model is told to ask "want me to draft a
 * reply?"), a false hit only restores the pre-gate behaviour (a draft that still needs a confirm in
 * a later student message). Read requests must never match: "what does it say", "tell me what
 * it's about", "read it", "summarize my inbox", "anything important in my email?", "did she reply?".
 * Question spans about what someone else did are removed first (`READ_SPANS`).
 *
 * The documented word list (each a pattern in `DRAFT_INTENT_PATTERNS`):
 *  - reply / respond (not "any reply", "reply from", "reply yet"); answer him|her|them|it|that|prof…
 *  - draft (any form), redraft, rewrite, reword
 *  - write back / write to / write him|her|them / write (up) an email|reply|response|note|message
 *  - email / e-mail as a verb: "email him|her|them|back|prof…|an@address", "email X back", or after
 *    "can you / could you / pls / please / and / just / then" or at the start of a sentence (not
 *    "email from / about / says …")
 *  - send / shoot him|her|them|back|prof…|a reply|an email|a note|a message
 *  - tell him|her|them|prof|the prof|my ta … (never "tell me")
 *  - let … know (never "let me / us know")
 *  - say: "say yes|no|thanks|sure|ok|i'll|i'm|i can|that i", or after "and / just / pls / please /
 *    can you / could you / then" or at the start of a sentence (never "what does it say")
 *  - rsvp
 */

/** People an email goes to ("tell her", "email prof kim", "let my ta know"). */
const WHO = String.raw`(?:him|her|them|back|prof|professor|dr|mr|mrs|ms|[\w.+-]+@[\w.-]+|(?:the|my|our)\s+(?:prof|professor|ta|tf|dean|advisor|adviser|coach|boss|registrar|office|department|group|team|class|landlord|manager|recruiter|mom|dad))(?![\w@])`;

/** Openers that make the next word a request verb ("can you email…", "and say…", "email kim…" at the start). */
const LEAD = String.raw`(?:^|\b(?:can you|could you|can u|could u|will you|pls|plz|please|and|just|then|go ahead and|help me))\s*`;

/** The drafting-intent patterns, tested per sentence on lowercased text with straight apostrophes. */
export const DRAFT_INTENT_PATTERNS: readonly RegExp[] = [
  /(?<!\b(?:any|no)\s)\b(?:reply|replying|respond|responding)\b(?!\s+(?:from|yet)\b)/,
  new RegExp(String.raw`\banswer(?:ing)?\s+(?:${WHO}|it|that|this)\b`),
  /\b(?:re)?draft(?:s|ed|ing)?\b/,
  /\b(?:rewrite|rewriting|reword|rewording)\b/,
  /\bwrit(?:e|ing)\s+(?:back|to|him|her|them)\b/,
  /\bwrit(?:e|ing)\s+(?:up\s+)?(?:an?\s+|the\s+|my\s+)?(?:quick\s+|short\s+|brief\s+)?(?:email|e-mail|reply|response|note|message)\b/,
  new RegExp(String.raw`\be-?mail(?:ing)?\s+${WHO}`),
  /\be-?mail\s+[^.?!\n]{0,40}\bback\b/,
  new RegExp(String.raw`${LEAD}e-?mail\b(?!\s*(?:from|about|says?|said|is|was|in|me|thread|address|list)\b)`),
  new RegExp(String.raw`\b(?:send|shoot)\s+(?:${WHO}|(?:a|an|the|my)\s+(?:quick\s+|short\s+)?(?:email|e-mail|reply|response|note|message))`),
  new RegExp(String.raw`\btell\s+${WHO}`),
  /\blet\s+(?!me\b|us\b)(?:[a-z.'-]+\s+){1,3}know\b/,
  /\bsay\s+(?:yes|no|yeah|yep|nope|thanks|thank you|sure|ok|okay|i'll|i'm|i can|i will|i won't|i can't|that i|that we|we)\b/,
  new RegExp(String.raw`${LEAD}say\b`),
  /\brsvp\b/,
];

/**
 * Spans that are reads, not requests, removed before matching: "say what/whether…", and questions
 * about what someone else did ("did prof kim reply", "has anyone emailed", "whether she said").
 */
const READ_SPANS: readonly RegExp[] = [
  /\bsay\s+(?:what|whether|if|how|when|where|who|why)\b/g,
  /\b(?:did|does|do|has|have|had|is|was|were|whether)\s+(?:(?!(?:to|you|u|i)\s)[a-z.'@-]+\s+){1,3}(?:reply|replied|replying|respond|responded|responding|answer|answered|write|wrote|written|email|emailed|say|said|send|sent)\b/g,
];

/** Lowercase, straight apostrophes, split into sentences / lines. */
function sentences(text: string): string[] {
  return (
    text
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .match(/[^.!?\n]+[.!?]*/g)
      ?.map((s) => s.trim())
      .filter((s) => s.length > 0) ?? []
  );
}

/**
 * Whether the student's own text asks Aria to write an email (reply, new email, or a redraft).
 * @param userText the run's user-authored inbound text (`ToolCtx.userText`); never third-party text
 * @returns true when at least one sentence matches a drafting pattern
 */
export function hasDraftIntent(userText: string): boolean {
  return sentences(userText).some((s) => {
    const clean = READ_SPANS.reduce((t, re) => t.replace(re, " "), s);
    return DRAFT_INTENT_PATTERNS.some((re) => re.test(clean));
  });
}
