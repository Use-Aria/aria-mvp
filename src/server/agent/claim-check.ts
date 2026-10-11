import "server-only";
// OWNER: 3.2 (gate fix 5.F1)

/**
 * Claim check (Wave 5 gate fix CR-2/CR-3): the model sometimes SAYS it acted ("done, locked in",
 * "on it, drafting that now", "quiet till morning") or answers an open preference question with a
 * bare tapback, without calling the tool — so nothing changed. Pure detectors; the loop
 * (`agent/loop.ts`) re-prompts once with `claimCheckNote(...)` when `claimCheck(...)` fires.
 *
 * Deliberately conservative (a false positive costs one extra model call and nothing else: the
 * note tells the model to keep its reply when no action was asked):
 *  - only inbound runs with user evidence, never action-locked runs, never after a forced answer;
 *  - a run that called ANY mutating tool is never checked (it acted; its wording is its own);
 *  - questions and offers ("want me to set it?", "if you tell me I'll add it") never count;
 *  - weak acks ("got it", "will do", "noted") count only when the student's batch asks for an
 *    action; strong claims ("paused", "I set…", "it's saved", "on it") count on their own;
 *  - a bare tapback (no bubbles, no tool at all) on a message that asks for an action reads as
 *    "on it" and counts too.
 */

/** Why the check fired. */
export type ClaimCheckReason = "claimed_action" | "unrecorded_answer";

/** Strong claims: Aria says something was (or is being) done. Tested per sentence, lowercase. */
const STRONG_CLAIMS: readonly RegExp[] = [
  /^(?:ok(?:ay)?|kk?|alright|bet|yep|yup|sure|nice|great|perfect|cool)?[\s,.!-]*(?:done|all done|on it|locked in|all set)\b/,
  /\blocked (?:it |that )?in\b/,
  /\b(?:you'?re|you are|it'?s|it is|that'?s|that is|we'?re) (?:all )?set\b/,
  /\bi(?:'ve| have)? (?:just |now |already )?(?:set|saved|added|paused|booked|marked|updated|scheduled|created|cancell?ed|deleted|removed|moved|muted|blocked|turned (?:off|on)|switched|changed|put)\b/,
  /\b(?:it'?s|it is|that'?s|that is|reminder'?s?|reminders are|rule'?s?|block'?s?|preference'?s?|pset'?s?|it'?ll be) (?:now )?(?:been )?(?:set|saved|booked|paused|updated|added|scheduled|cancell?ed|deleted|removed|locked in|checked off|marked(?: as)? (?:done|complete)|a (?:standing |permanent )?rule)\b/,
  /\b(?:marked|checked) (?:it |that |the [a-z0-9 ]{1,30} )?(?:as )?(?:done|complete|off)\b/,
  /\bone (?:less thing|off the list|down)\b/,
  /^(?:got it|ok(?:ay)?|bet|done)?[\s,.!-]*(?:paused|muted|saved|booked|updated|scheduled|cancell?ed|deleted)\b/,
  /\bquiet (?:till|til|until|for)\b/,
  /\bno (?:more )?(?:texts|messages|reminders|pings) from me\b/,
  /\bi'?ll (?:ping|remind|text|nudge) you (?:in|at|tomorrow|tmrw|tmr|tonight|before|on)\b/,
  /\b(?:reminder|nudge|ping) (?:set )?(?:in \d|at \d|for \d)/,
  /\b(?:drafting|writing up|putting together) (?:it|that|this|one|now|the|your|an?)\b/,
  /\b(?:updated|saved|done|set|booked)\s*[✅👍]/u,
];

/** Weak acks: a claim only when the student asked for an action. */
const WEAK_CLAIMS: readonly RegExp[] = [/^(?:ok(?:ay)?|kk?|alright|bet)?[\s,.!-]*(?:got it|will do|noted|say less|you got it|consider it done|on it)\b/];

/** Sentences that offer or ask instead of claiming. */
const OFFER_RE = /\?|\b(?:want me to|should i|shall i|do you want|if you|i can |can i|could i|lmk|let me know)\b/;

/** Sentences that deny or correct ("I said I set it but I didn't") instead of claiming. */
const NEGATION_RE = /\b(?:didn'?t|did not|isn'?t|wasn'?t|haven'?t|hasn'?t|couldn'?t|can'?t|won'?t|not|never|no longer|my bad)\b/;

/** The student's batch asks for an action (weak acks then count as claims). */
const ACTION_REQUEST_RE =
  /\b(?:remind|reminder|pause|unpause|resume|mute|stop (?:texting|messaging|sending)|don'?t (?:text|message)|quiet|mark|finished|done with|submitted|turned in|book|schedule|block|cancel|delete|remove|change|make it|switch|set (?:a|an|my|it|the|up|me)|save|remember|draft|email|write|reply|move|add|turn (?:off|on)|update|sign (?:me )?out|forget|rule|from now on)\b/;

/** A short answer to a yes/no question. */
const ANSWER_RE =
  /^(?:sure|yes|yess+|yeah|yea|ya|ye|yep|yup|y|ok(?:ay)?|k|kk|bet|do it|go for it|go ahead|sounds good|please|pls|perfect|that works|works|correct|right|absolutely|definitely|for sure|nah|no|nope|never ?mind|nvm|don'?t|not really|no thanks|no thx)\b/;

/** Max words in a batch treated as a bare answer to the open preference question. */
const MAX_ANSWER_WORDS = 8;

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
 * Whether Aria's bubbles claim an action was done or is in progress.
 * @param bubbles the reply bubbles
 * @param userText the student's batch text (weak acks count only when it asks for an action)
 * @returns true when some non-question sentence makes a claim
 */
export function claimsAction(bubbles: readonly string[], userText: string): boolean {
  const asked = asksForAction(userText);
  for (const s of bubbles.flatMap(sentences)) {
    if (OFFER_RE.test(s) || NEGATION_RE.test(s)) continue;
    if (STRONG_CLAIMS.some((re) => re.test(s))) return true;
    if (asked && WEAK_CLAIMS.some((re) => re.test(s))) return true;
  }
  return false;
}

/**
 * Whether the student's batch asks Aria to do something (remind, pause, mark, draft, change…).
 * @param userText the student's batch text
 * @returns true when an action verb is present
 */
export function asksForAction(userText: string): boolean {
  return ACTION_REQUEST_RE.test(userText.toLowerCase().replace(/[’‘]/g, "'"));
}

/**
 * Whether the student's batch looks like a bare yes/no answer ("sure", "yep do it", "nah nvm").
 * @param userText the student's batch text
 * @returns true for a short answer
 */
export function looksLikeAnswer(userText: string): boolean {
  const t = userText.toLowerCase().replace(/[’‘]/g, "'").trim();
  if (t.length === 0) return false;
  if (t.split(/\s+/).length > MAX_ANSWER_WORDS) return false;
  return ANSWER_RE.test(t);
}

/** Inputs of `claimCheck`. */
export interface ClaimCheckState {
  /** the run's trigger kind (proactive runs are never checked) */
  trigger: "inbound" | "proactive";
  /** user evidence aliases in this run's batch (none → mutators can't run anyway) */
  evidenceCount: number;
  /** the action lock is set (a mutator would be refused) */
  locked: boolean;
  /** the check already fired in this run */
  alreadyChecked: boolean;
  /** this answer came from a forced final call (tools disabled) */
  forced: boolean;
  /** tool calls in the run (send_interim excluded) */
  toolCalls: number;
  /** mutating tool calls in the run (attempted, any outcome) */
  mutatingCalls: number;
  /** a preference question is open (`<aria_now>` shows it) */
  openQuestion: boolean;
  /** the student's batch text */
  userText: string;
  /** the reply's bubbles */
  bubbles: readonly string[];
}

/**
 * Decide whether to re-prompt once before accepting a final answer.
 * - `claimed_action`: no mutating tool ran, yet the bubbles claim an action — or the run called no
 *   tool at all and answered an action request with a bare tapback;
 * - `unrecorded_answer`: a preference question is open, the student's batch is a bare yes/no and
 *   the run called no tool at all (e.g. a ❤️ tapback instead of `confirm_preference`).
 * @param s run state at the final answer
 * @returns the reason, or null to accept the answer
 */
export function claimCheck(s: ClaimCheckState): ClaimCheckReason | null {
  if (s.trigger !== "inbound" || s.evidenceCount === 0 || s.locked || s.alreadyChecked || s.forced) return null;
  if (s.mutatingCalls > 0) return null;
  if (claimsAction(s.bubbles, s.userText)) return "claimed_action";
  if (s.openQuestion && s.toolCalls === 0 && looksLikeAnswer(s.userText)) return "unrecorded_answer";
  if (s.toolCalls === 0 && s.bubbles.length === 0 && asksForAction(s.userText)) return "claimed_action";
  return null;
}

/** Notes appended (as our own message, after the model's answer) when the check fires. */
export const CLAIM_CHECK_NOTE: Readonly<Record<ClaimCheckReason, string>> = {
  claimed_action:
    "<aria_note>Check before this goes out: your reply says something was done or is being done, but you called no tool that changes anything this turn, so nothing has changed yet. If the student asked for it in <new_messages>, call the right tool now, then reply. If it was already done earlier, or they didn't ask for an action, send your reply again without claiming you just did it.</aria_note>",
  unrecorded_answer:
    "<aria_note>Check before this goes out: a preference question is open (see <aria_now>) and the student's message looks like an answer to it, but you didn't record it. If it answers that question, call confirm_preference now (confirm or reject), then reply. If it answers something else, send your reply again.</aria_note>",
};
