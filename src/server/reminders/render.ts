import "server-only";
// OWNER: 2.6

/**
 * Deterministic texts for reminders, auto nudges, due-change alerts and the connect-Canvas nudge
 * (V2-06 §2.3, §7 `reminders/render.ts`). Pure: no I/O, no LLM. Times are pre-rendered in the
 * user's local zone by code (`formatForChat`); phrase variants are picked by a stable hash so
 * repeated nudges vary without randomness.
 *
 * Titles and courses come from Canvas/calendar (third-party) but these strings go straight to the
 * user, never into a prompt, so no untrusted wrapping is needed here; they are clipped and stripped
 * of links.
 */
import { formatForChat } from "@/shared/time/tz";

/** Template register (`templateRegister` in `src/shared/persona-prefs.ts`). */
export type Register = "casual" | "neutral";

/** One deadline in a nudge. */
export interface NudgeItem {
  title: string;
  course: string | null;
  dueAt: Date;
}

/** One due-date change in an alert. */
export interface DueChangeItem {
  title: string;
  course: string | null;
  oldDueAt: Date | null;
  newDueAt: Date;
}

const MIN_MS = 60_000;
const TITLE_MAX = 90;
/** Late threshold for the "(from earlier)" prefix (matches `LATE_PREFIX_AFTER_MS`). */
const LATE_PREFIX_MIN = 30;
/** Most items listed one per line before "+N more". */
const LIST_MAX = 5;

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;

/** FNV-1a 32-bit. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function pick<T>(pool: readonly T[], seed: string): T {
  return pool[hash(seed) % pool.length];
}

function tidy(text: string): string {
  return text.replace(/[ \t]{2,}/g, " ").replace(/ +([,.!?])/g, "$1").trim();
}

/**
 * Remove links, keeping only those on `allowOrigin` (our own app). Used on model-written
 * reminder text and on every title we echo back.
 * @param text input text
 * @param allowOrigin the app origin, e.g. "https://aria.vercel.app" ("" keeps nothing)
 * @returns text without foreign URLs (whitespace tidied)
 */
export function stripUrls(text: string, allowOrigin: string): string {
  let origin: string | null = null;
  try {
    origin = allowOrigin ? new URL(allowOrigin).origin : null;
  } catch {
    origin = null;
  }
  const out = text.replace(URL_RE, (raw) => {
    const candidate = raw.replace(/[).,!?;:]+$/, "");
    const trailing = raw.slice(candidate.length);
    if (origin) {
      try {
        const u = new URL(candidate.startsWith("www.") ? `https://${candidate}` : candidate);
        if (u.origin === origin && !u.username && !u.password) return raw;
      } catch {
        // not a URL: drop it
      }
    }
    return trailing;
  });
  return tidy(out);
}

/** Item label: "CS 4190: pset 3" (course prefixed unless the title already names it), clipped, link-free. */
function label(title: string, course: string | null): string {
  const t = stripUrls(title, "").replace(/\s+/g, " ").trim() || "your deadline";
  const c = course ? stripUrls(course, "").replace(/\s+/g, " ").trim() : "";
  const full = c && !t.toLowerCase().includes(c.toLowerCase()) ? `${c}: ${t}` : t;
  return full.length > TITLE_MAX ? `${full.slice(0, TITLE_MAX - 1).trimEnd()}…` : full;
}

/** "~3h", "~45 min", "~2 days" until `at`. */
function until(at: Date, now: Date): string {
  const min = Math.max(0, Math.round((at.getTime() - now.getTime()) / MIN_MS));
  if (min < 60) return `~${Math.max(1, min)} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `~${h}h`;
  return `~${Math.round(h / 24)} days`;
}

/**
 * Text of a user-set reminder at fire time (written by the model at creation time, sent verbatim).
 * @param body stored reminder text
 * @param opts how late the send is, in minutes
 * @returns the bubble text ("(from earlier) …" when more than 30 min late)
 */
export function renderUserReminder(body: string, opts: { lateMinutes: number }): string {
  const text = body.trim();
  return opts.lateMinutes > LATE_PREFIX_MIN ? `(from earlier) ${text}` : text;
}

const NUDGE_ONE_CASUAL: readonly ((l: string, w: string, u: string) => string)[] = [
  (l, w, u) => `heads up: ${l} is due ${w} (${u}) 👀`,
  (l, w, u) => `${l} is due ${w}, ${u} to go. how's it looking?`,
  (l, w, u) => `quick nudge: ${l} due ${w} (${u})`,
  (l, w, u) => `${u} left on ${l} (due ${w}). you got this`,
];
const NUDGE_ONE_NEUTRAL: readonly ((l: string, w: string, u: string) => string)[] = [
  (l, w, u) => `Reminder: ${l} is due ${w} (${u}).`,
  (l, w, u) => `Heads up: ${l} is due ${w}, in ${u.replace("~", "about ")}.`,
];
const NUDGE_MANY_HEAD: Record<Register, readonly string[]> = {
  casual: ["heads up, due soon:", "a few things due soon 👀", "coming up:"],
  neutral: ["Reminder, due soon:", "Coming up soon:"],
};

/**
 * Auto deadline nudge (T-3h by default). Several items due close together are coalesced into one
 * list bubble.
 * @param items deadlines (soonest first is not required; sorted here)
 * @param tz user zone
 * @param now clock
 * @param register casual | neutral
 * @param seed stable phrase seed (e.g. reminder id + local date)
 * @returns 1–2 bubbles ([] when no items)
 */
export function renderNudge(items: NudgeItem[], tz: string, now: Date, register: Register, seed: string): string[] {
  if (items.length === 0) return [];
  const sorted = [...items].sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
  if (sorted.length === 1) {
    const it = sorted[0];
    const make = pick(register === "casual" ? NUDGE_ONE_CASUAL : NUDGE_ONE_NEUTRAL, seed);
    return [tidy(make(label(it.title, it.course), formatForChat(it.dueAt, tz, now), until(it.dueAt, now)))];
  }
  const shown = sorted.slice(0, LIST_MAX);
  const lines = shown.map((it) => `• ${label(it.title, it.course)}: ${formatForChat(it.dueAt, tz, now)}`);
  if (sorted.length > LIST_MAX) lines.push(register === "casual" ? `+${sorted.length - LIST_MAX} more` : `and ${sorted.length - LIST_MAX} more`);
  return [`${pick(NUDGE_MANY_HEAD[register], seed)}\n${lines.join("\n")}`];
}

/** "Thu 11:59pm → Fri 5pm" / "now due Fri 5pm". */
function moveText(c: DueChangeItem, tz: string, now: Date): string {
  const next = formatForChat(c.newDueAt, tz, now);
  return c.oldDueAt ? `${formatForChat(c.oldDueAt, tz, now)} → ${next}` : `now due ${next}`;
}

/**
 * Due-date change alert (V2-06 §2.8). One change → one sentence; up to 5 → a list; more → a
 * one-line summary (the caller adds the `/week` link).
 * @param changes changed deadlines
 * @param tz user zone
 * @param now clock
 * @param register casual | neutral
 * @returns 1 bubble ([] when no changes)
 */
export function renderDueChangeAlert(changes: DueChangeItem[], tz: string, now: Date, register: Register): string[] {
  if (changes.length === 0) return [];
  if (changes.length === 1) {
    const c = changes[0];
    const l = label(c.title, c.course);
    const moved = c.oldDueAt
      ? c.newDueAt.getTime() < c.oldDueAt.getTime()
        ? register === "casual"
          ? "moved earlier"
          : "was moved earlier"
        : register === "casual"
          ? "moved"
          : "was moved"
      : "";
    if (register === "casual") {
      return [c.oldDueAt ? `heads up: ${l} ${moved}, ${moveText(c, tz, now)}` : `heads up: ${l} is ${moveText(c, tz, now)}`];
    }
    return [c.oldDueAt ? `Heads up: ${l} ${moved}: ${moveText(c, tz, now)}.` : `Heads up: ${l} is ${moveText(c, tz, now)}.`];
  }
  if (changes.length > LIST_MAX) {
    return [
      register === "casual"
        ? `${changes.length} due dates just changed on Canvas, here's the updated week:`
        : `${changes.length} due dates changed on Canvas. Here is the updated week:`,
    ];
  }
  const head = register === "casual" ? "a few due dates changed:" : "Some due dates changed:";
  const lines = changes.map((c) => `• ${label(c.title, c.course)}: ${moveText(c, tz, now)}`);
  return [`${head}\n${lines.join("\n")}`];
}

const CONNECT: Record<Register, Record<1 | 2 | 3, string>> = {
  casual: {
    1: "morning! I can do a daily rundown of your deadlines once Canvas is connected. takes ~1 min:",
    2: "still happy to track your Canvas deadlines for you, just connect it here:",
    3: "last nudge on this, promise: connect Canvas and I'll keep an eye on every due date",
  },
  neutral: {
    1: "Good morning. Once Canvas is connected I can send a daily summary of your deadlines. It takes about a minute:",
    2: "I can still track your Canvas deadlines for you. You can connect it here:",
    3: "Last reminder about this: connect Canvas and I will keep track of every due date.",
  },
};

/**
 * Connect-Canvas nudge sent instead of a briefing on days 1, 3 and 7 (max 3 lifetime). The caller
 * appends the `setup` link as the plan's link bubble.
 * @param attempt which of the three nudges
 * @param register casual | neutral
 * @returns 1 bubble
 */
export function renderConnectNudge(attempt: 1 | 2 | 3, register: Register): string[] {
  return [CONNECT[register][attempt]];
}
