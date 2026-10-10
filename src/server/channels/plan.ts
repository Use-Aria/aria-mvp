import "server-only";
// OWNER: 1.2

/**
 * Reply-plan helpers (pure): build, validate/normalize, outbox merge (V2-03 §2.6, §2.10; master
 * plan §1.1). Every producer builds a `ReplyPlan`; delivery runs `validatePlan` before rendering.
 *
 * Caps: ≤ 3 bubbles per plan **including** the link bubble and an interim already sent this run;
 * extra bubbles are merged into the last allowed one, never dropped. ≤ 2 reactions. ≤ 1200 chars
 * per bubble. Links only to the app origin or `https://mail.google.com/`; media only from the app
 * origin.
 */
import { PIPELINE } from "@/server/pipeline/config";
import type {
  ClassicTapback,
  OutboxItem,
  PlanBubble,
  PlanReaction,
  ReactionType,
  ReplyPlan,
} from "@/server/channels/types";

export { OutboxItemSchema } from "@/server/channels/types";
export type { OutboxItem } from "@/server/channels/types";

const CLASSIC_TAPBACKS: readonly ClassicTapback[] = [
  "love",
  "like",
  "dislike",
  "laugh",
  "emphasize",
  "question",
];

const GMAIL_ORIGIN = "https://mail.google.com";
const MERGE_SEPARATOR = "\n\n";
const URL_IN_TEXT_RE = /\bhttps?:\/\/[^\s<>"']+/gi;
const TRAILING_URL_PUNCT_RE = /[.,!?;:)\]}'"]+$/;
const LINK_REMOVED = "[link removed]";

// Built at runtime: `\p{…}` needs the `u` flag, which the ES2017 TS target rejects in literals.
/** A code point that renders as emoji by default (no VS16 needed). */
const EMOJI_PRESENTATION_START_RE = new RegExp("^\\p{Emoji_Presentation}", "u");
/** A text-default emoji code point followed by VS16 (picker form, e.g. "❤️", "1️⃣"). */
const EMOJI_VS16_START_RE = new RegExp("^\\p{Emoji}\\u{FE0F}", "u");
/** Letters, digits, whitespace or punctuation outside an emoji sequence. */
const NON_EMOJI_RE = new RegExp("[\\p{L}\\s]", "u");

/**
 * Counts user-perceived characters (grapheme clusters).
 * @param s any text
 * @returns grapheme count
 */
function graphemeCount(s: string): number {
  let n = 0;
  for (const _ of new Intl.Segmenter("en", { granularity: "grapheme" }).segment(s)) {
    void _;
    n += 1;
  }
  return n;
}

/**
 * Whether a reaction is acceptable to Sendblue: a classic tapback name, or exactly one emoji
 * grapheme in emoji-picker form (a text-default code point like "❤" needs VS16: "❤️").
 * @param type reaction name or emoji
 * @returns true when valid
 */
export function isValidReactionType(type: string): type is ReactionType {
  if ((CLASSIC_TAPBACKS as readonly string[]).includes(type)) return true;
  if (type.length === 0 || type.length > 32) return false;
  if (graphemeCount(type) !== 1) return false;
  if (NON_EMOJI_RE.test(type)) return false;
  return EMOJI_PRESENTATION_START_RE.test(type) || EMOJI_VS16_START_RE.test(type);
}

/**
 * Whether `url` may be sent to a user: same origin as the app, or a Gmail permalink
 * (`https://mail.google.com/…`). Rejects other schemes, embedded credentials and lookalike hosts.
 * @param url candidate absolute URL
 * @param appOrigin the app origin (`appOrigin()`), e.g. "https://aria.vercel.app"
 * @returns true when allowed
 */
export function isAllowedLink(url: string, appOrigin: string): boolean {
  const u = parseUrl(url);
  if (!u) return false;
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.username || u.password) return false;
  if (u.origin === GMAIL_ORIGIN) return true;
  const app = parseUrl(appOrigin);
  return app !== null && u.origin === app.origin;
}

/**
 * Whether a media URL may be sent: app origin only (our vCard and our own files).
 * @param url candidate absolute URL
 * @param appOrigin the app origin
 * @returns true when allowed
 */
export function isAllowedMediaUrl(url: string, appOrigin: string): boolean {
  const u = parseUrl(url);
  const app = parseUrl(appOrigin);
  if (!u || !app) return false;
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.username || u.password) return false;
  return u.origin === app.origin;
}

/**
 * Producers' helper: one bubble per non-empty text, plus an optional link bubble.
 * The result still goes through `validatePlan` at delivery (caps, allow-list).
 * @param texts bubble texts in order (blank entries are skipped)
 * @param link optional URL rendered as its own bubble
 * @returns a `ReplyPlan`
 */
export function textPlan(texts: string[], link?: string | null): ReplyPlan {
  const bubbles: PlanBubble[] = texts
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((text) => ({ text }));
  const plan: ReplyPlan = { bubbles };
  const url = link?.trim();
  if (url) plan.link = { url };
  return plan;
}

/**
 * Validates and normalizes a plan for sending. Never throws; every fix is reported in `warnings`.
 * - reactions: invalid types dropped, at most 2 kept, blank `fallbackText` removed
 * - bubbles: trimmed, blanks dropped, disallowed URLs in text replaced by "[link removed]",
 *   truncated to 1200 chars, then capped (3, minus the link bubble, minus 1 if an interim
 *   was already sent) by merging the overflow into the last kept bubble
 * - link: dropped if not allowed or already present in a bubble's text
 * - media: dropped unless from the app origin
 * An empty plan (no bubbles, reactions, link or media) is valid: it means "say nothing".
 * @param plan producer's plan
 * @param opts app origin for the allow-lists; `interimSent` reduces the bubble cap by one
 * @returns the normalized plan and warning codes
 */
export function validatePlan(
  plan: ReplyPlan,
  opts: { appOrigin: string; interimSent?: boolean },
): { plan: ReplyPlan; warnings: string[] } {
  const warnings: string[] = [];

  // Reactions.
  const reactions: PlanReaction[] = [];
  for (const r of plan.reactions ?? []) {
    if (!r.targetMessageId || !isValidReactionType(r.type)) {
      warnings.push("reaction_invalid");
      continue;
    }
    if (reactions.length >= PIPELINE.maxReactions) {
      warnings.push("reactions_capped");
      break;
    }
    const fallbackText = r.fallbackText?.trim();
    reactions.push({
      targetMessageId: r.targetMessageId,
      type: r.type,
      ...(fallbackText ? { fallbackText } : {}),
    });
  }

  // Link.
  let link: { url: string } | undefined;
  const rawLink = plan.link?.url.trim();
  if (rawLink) {
    if (!isAllowedLink(rawLink, opts.appOrigin)) warnings.push("link_disallowed");
    else link = { url: rawLink };
  }

  // Bubbles.
  let bubbles: PlanBubble[] = [];
  for (const b of plan.bubbles) {
    let text = b.text.trim();
    const scrubbed = scrubUrls(text, opts.appOrigin);
    if (scrubbed !== text) {
      warnings.push("bubble_url_removed");
      text = scrubbed.trim();
    }
    if (text.length === 0) {
      warnings.push("bubble_empty");
      continue;
    }
    bubbles.push({ text, ...(b.replyToMessageId ? { replyToMessageId: b.replyToMessageId } : {}) });
  }
  const linkUrl = link?.url;
  if (linkUrl && bubbles.some((b) => b.text.includes(linkUrl))) {
    warnings.push("link_in_bubble");
    link = undefined;
  }

  const cap = Math.max(1, PIPELINE.maxBubbles - (link ? 1 : 0) - (opts.interimSent ? 1 : 0));
  if (bubbles.length > cap) {
    warnings.push("bubbles_merged");
    bubbles = capBubbles(bubbles, cap);
  }
  bubbles = bubbles.map((b) => {
    if (b.text.length <= PIPELINE.maxBubbleChars) return b;
    warnings.push("bubble_truncated");
    return { ...b, text: truncate(b.text, PIPELINE.maxBubbleChars) };
  });

  // Media.
  const media: NonNullable<ReplyPlan["media"]> = [];
  for (const m of plan.media ?? []) {
    if (!isAllowedMediaUrl(m.url, opts.appOrigin)) {
      warnings.push("media_disallowed");
      continue;
    }
    media.push({ url: m.url, kind: m.kind });
  }

  const out: ReplyPlan = { bubbles };
  if (reactions.length > 0) out.reactions = reactions;
  if (link) out.link = link;
  if (media.length > 0) out.media = media;
  return { plan: out, warnings };
}

/**
 * Merges queued proactive items into one plan (outbox flush). Items are ordered by `enqueuedAt`
 * (stable); a repeated `dedupeKey` is dropped (first wins); bubbles keep their order; the first
 * link wins; reactions and media are concatenated (media deduped by URL); the bubble cap (3,
 * counting the link) is applied by merging overflow into the last bubble. The caller filters
 * items that are not due or expired and runs `validatePlan` on the result.
 * @param items outbox items
 * @returns the merged plan
 */
export function mergeOutboxItems(items: OutboxItem[]): ReplyPlan {
  const ordered = items
    .map((item, index) => {
      const at = Date.parse(item.enqueuedAt);
      return { item, index, at: Number.isNaN(at) ? 0 : at };
    })
    .sort((a, b) => a.at - b.at || a.index - b.index);

  const seen = new Set<string>();
  const bubbles: PlanBubble[] = [];
  const reactions: PlanReaction[] = [];
  const media: NonNullable<ReplyPlan["media"]> = [];
  let link: { url: string } | undefined;

  for (const { item } of ordered) {
    if (seen.has(item.dedupeKey)) continue;
    seen.add(item.dedupeKey);
    const p = item.plan;
    for (const b of p.bubbles) bubbles.push({ ...b });
    for (const r of p.reactions ?? []) reactions.push({ ...r });
    for (const m of p.media ?? []) if (!media.some((x) => x.url === m.url)) media.push({ ...m });
    if (!link && p.link?.url) link = { url: p.link.url };
  }

  const cap = Math.max(1, PIPELINE.maxBubbles - (link ? 1 : 0));
  const out: ReplyPlan = { bubbles: capBubbles(bubbles, cap) };
  if (reactions.length > 0) out.reactions = reactions.slice(0, PIPELINE.maxReactions);
  if (link) out.link = link;
  if (media.length > 0) out.media = media;
  return out;
}

// ── internals ───────────────────────────────────────────────────────────────

function parseUrl(s: string): URL | null {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

/** Keeps the first `cap - 1` bubbles and joins the rest into the last one. */
function capBubbles(bubbles: PlanBubble[], cap: number): PlanBubble[] {
  if (bubbles.length <= cap) return bubbles;
  const head = bubbles.slice(0, cap - 1);
  const tail = bubbles.slice(cap - 1);
  const merged: PlanBubble = { text: tail.map((b) => b.text).join(MERGE_SEPARATOR) };
  const replyTo = tail[0].replyToMessageId;
  if (replyTo) merged.replyToMessageId = replyTo;
  return [...head, merged];
}

/** Cuts to `max` UTF-16 units (never splitting a surrogate pair) and ends with "…". */
function truncate(text: string, max: number): string {
  let cut = text.slice(0, max - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/** Replaces http(s) URLs that fail the link allow-list. */
function scrubUrls(text: string, appOrigin: string): string {
  return text.replace(URL_IN_TEXT_RE, (match) => {
    const url = match.replace(TRAILING_URL_PUNCT_RE, "");
    const trailing = match.slice(url.length);
    return isAllowedLink(url, appOrigin) ? match : `${LINK_REMOVED}${trailing}`;
  });
}
