import "server-only";
// OWNER: 1.2

/**
 * Deterministic keyword commands, matched on the WHOLE message before the agent runs (pure;
 * V2-03 §2.8). Opt-out is honoured "by any reasonable means" (spec §3.22): Sendblue's built-in
 * keywords plus common phrasings ("leave me alone", "stop texting me", …), with case, punctuation,
 * emoji and a polite "pls"/"please" ignored. Partial matches ("stop reminding me about cpsc",
 * "end of the week?") are NOT commands; they go to the agent.
 */
import { PIPELINE } from "@/server/pipeline/config";
import {
  addLocalDays,
  formatForChat,
  localDateOf,
  safeTimeZone,
  toLocal,
  zonedToUtc,
} from "@/shared/time/tz";

/** A detected command. */
export type Command =
  | { kind: "opt_out" }
  | { kind: "opt_in" }
  | { kind: "help" }
  | { kind: "pause"; until: Date };

// Built at runtime: `\p{…}` needs the `u` flag, which the ES2017 TS target rejects in literals.
const EMOJI_RE = new RegExp("[\\p{Extended_Pictographic}\\p{Emoji_Modifier}\\u{FE0F}\\u{200D}\\u{20E3}]", "gu");
const EDGE_PUNCT_RE = new RegExp("^[\\p{P}\\p{S}\\s]+|[\\p{P}\\p{S}\\s]+$", "gu");

const POLITE = "(?:pls|plz|please|thx|thanks|ty|now|already|thank you)";
const LEAD = `(?:(?:${POLITE}|ok|okay|aria|just)\\s+)*`;
const TRAIL = `(?:\\s+(?:${POLITE}|aria))*`;

const OPT_OUT_CORE = [
  // Sendblue built-ins
  "stop",
  "unsubscribe",
  "cancel",
  "opt out",
  "optout",
  "revoke",
  "end",
  "quit",
  // extras ("any reasonable means")
  "stop all",
  "stopall",
  "stop it",
  "unsub",
  "leave me alone",
  "stop texting me",
  "stop messaging me",
  "stop contacting me",
  "dont text me",
  "dont message me",
  "do not text me",
  "dont text me anymore",
  "no more texts",
  "no more messages",
  "(?:stop|quit) (?:texting|messaging|contacting) me(?: anymore)?",
];
const OPT_IN_CORE = ["start", "unstop", "resume", "unpause", "opt in", "optin"];
const HELP_CORE = ["help", "info", "commands"];

const OPT_OUT_RE = wholeMessage(OPT_OUT_CORE);
const OPT_IN_RE = wholeMessage(OPT_IN_CORE);
const HELP_RE = wholeMessage(HELP_CORE);

const PAUSE_VERB = "(?:pause|mute|snooze|quiet|hush)";
const PAUSE_OBJ = "(?:\\s+(?:messages|msgs|texts|notifications|notifs|check ins|checkins|aria|it))?";
const NUM_WORD = "(?:\\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|a couple(?: of)?|couple(?: of)?)";
const UNIT = "(?:h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks)";
const PAUSE_RE = new RegExp(
  `^${LEAD}${PAUSE_VERB}${PAUSE_OBJ}` +
    `(?:\\s+(?:` +
    `for\\s+(?<n>${NUM_WORD})\\s*(?<unit>${UNIT})` +
    `|(?<today>for\\s+(?:today|the\\s+day|the\\s+rest\\s+of\\s+(?:the|today)(?:\\s+day)?|tonight))` +
    `|(?<tmrw>(?:till|til|until|untill|to)\\s+(?:tomorrow|tmrw|tmr|tomorow))` +
    `))?${TRAIL}$`,
);

const WORD_NUMBERS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  twelve: 12,
};

/**
 * Normalizes a message for keyword matching: NFKC, lowercase, curly quotes → straight,
 * apostrophes removed ("don't" → "dont"), emoji removed, hyphens/underscores → spaces,
 * leading/trailing punctuation and symbols stripped, whitespace collapsed.
 * @param text raw inbound text
 * @returns normalized text ("" for emoji/punctuation-only)
 */
export function normalizeCommandText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’`´]/g, "'")
    .replace(/'/g, "")
    .replace(EMOJI_RE, " ")
    .replace(/[-_]+/g, " ")
    .replace(EDGE_PUNCT_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Detects a keyword command in a whole message.
 * @param text raw inbound text
 * @param now current instant (pause durations)
 * @param tz user's IANA zone (pause "for today"/"till tomorrow" end at local midnight)
 * @returns the command, or null when the message is for the agent
 */
export function detectCommand(text: string, now: Date, tz: string): Command | null {
  const t = normalizeCommandText(text);
  if (!t || t.length > 60) return null;
  if (OPT_OUT_RE.test(t)) return { kind: "opt_out" };
  if (OPT_IN_RE.test(t)) return { kind: "opt_in" };
  if (HELP_RE.test(t)) return { kind: "help" };
  const m = PAUSE_RE.exec(t);
  if (m) return { kind: "pause", until: pauseUntil(m.groups ?? {}, now, safeTimeZone(tz)) };
  return null;
}

/**
 * Fixed confirmation text for a command.
 * @param cmd the command
 * @param ctx zone and clock to phrase a pause end ("tmrw 9am"); omitted → generic wording
 * @returns the bubble text
 */
export function commandReply(cmd: Command, ctx?: { tz: string; now: Date }): string {
  switch (cmd.kind) {
    case "opt_out":
      return "ok, I'll stop texting you. text START anytime to turn me back on.";
    case "opt_in":
      return "you're back on 👋 I'll text you again. text STOP anytime to opt out.";
    case "help":
      return (
        "I'm Aria, an AI assistant for school — deadlines, your calendar, reminders, all over text. " +
        "just text me like a friend. PAUSE mutes my check-ins for a day, STOP opts out, START turns me back on."
      );
    case "pause": {
      const when = ctx ? formatForChat(cmd.until, safeTimeZone(ctx.tz), ctx.now) : null;
      return when
        ? `got it, no check-ins until ${when}. you can still text me anytime.`
        : "got it, I'll hold off on check-ins for now. you can still text me anytime.";
    }
  }
}

// ── internals ───────────────────────────────────────────────────────────────

function wholeMessage(alternatives: string[]): RegExp {
  return new RegExp(`^${LEAD}(?:${alternatives.join("|")})${TRAIL}$`);
}

function parseCount(word: string): number {
  if (/^\d+$/.test(word)) return Number(word);
  if (word.includes("couple")) return 2;
  return WORD_NUMBERS[word] ?? 1;
}

function pauseUntil(g: Record<string, string | undefined>, now: Date, tz: string): Date {
  if (g.today !== undefined || g.tmrw !== undefined) {
    // "for today" / "till tomorrow": until the next local midnight.
    const tomorrow = addLocalDays(localDateOf(now, tz), 1);
    return zonedToUtc({ ...tomorrow, hour: 0, minute: 0 }, tz).instant;
  }
  if (g.n !== undefined && g.unit !== undefined) {
    const n = Math.max(1, parseCount(g.n));
    const unit = g.unit;
    if (unit.startsWith("h")) {
      const hours = Math.min(n, PIPELINE.maxPauseDays * 24);
      return new Date(now.getTime() + hours * 3_600_000);
    }
    const days = Math.min(unit.startsWith("w") ? n * 7 : n, PIPELINE.maxPauseDays);
    // Same wall-clock time N local days later (DST-safe), not N × 24h.
    const l = toLocal(now, tz);
    return zonedToUtc({ ...addLocalDays(l, days), hour: l.hour, minute: l.minute }, tz).instant;
  }
  return new Date(now.getTime() + PIPELINE.defaultPauseMs);
}
