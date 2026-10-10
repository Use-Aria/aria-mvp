import "server-only";
// OWNER: 2.2

/**
 * Context renderers (V2-04 §2.5, §7.2 `context/render.ts`). Pure and byte-stable: the same rows
 * render the same bytes, with absolute local timestamps (never "today"/"2 min ago"), so the
 * per-user prefix and history stay cacheable across turns.
 *
 * Layout (messages): user `<aria_profile>…<aria_summary>` → history (alternating; one text
 * block per message) → user `<aria_now>…</aria_now>` + `<new_messages>…</new_messages>`.
 * All tag names are reserved (`aria_*`, `new_messages`), so user or third-party text can't
 * forge them: user text goes through `neutralizeTags`, third-party text through `wrapUntrusted`.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { BUDGET } from "@/server/agent/config";
import { clampLines } from "@/server/agent/context/budget";
import type { MsgLite } from "@/server/agent/context/window";
import type { AliasTable } from "@/server/agent/types";
import { neutralizeTags, wrapUntrusted, type UntrustedSource } from "@/server/agent/untrusted";
import type { OpenAction } from "@/server/agent/pending/types";
import type { ChannelContext, InboundMedia } from "@/server/channels/types";
import type { AgentTrigger, IdentityState, InboundMessage, InboundReaction } from "@/server/pipeline/types";
import type { TimelineItemView, TimelineSource } from "@/server/timeline/types";
import type { Tone } from "@/shared/persona-prefs";
import type { RegisterHint } from "@/shared/register";
import { formatForTool, toLocal, type Weekday } from "@/shared/time/tz";

const WEEKDAY: Readonly<Record<Weekday, string>> = { MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat", SU: "Sun" };
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
/** Per-message text cap in history / new messages (a pasted essay can't flood the window). */
const MAX_MESSAGE_CHARS = 1500;
const MAX_FILENAME = 80;
const MAX_AGENDA_LINES = 40;

/**
 * Absolute local timestamp for transcripts, e.g. "Tue Oct 14 2:14pm".
 * @param ts instant
 * @param tz IANA zone
 * @returns weekday, month, day and 12h clock in `tz`
 */
export function formatLocal(ts: Date, tz: string): string {
  const l = toLocal(ts, tz);
  const h12 = l.hour % 12 === 0 ? 12 : l.hour % 12;
  const mins = l.minute === 0 ? "" : `:${String(l.minute).padStart(2, "0")}`;
  return `${WEEKDAY[l.weekday]} ${MONTH[l.month - 1]} ${l.day} ${h12}${mins}${l.hour < 12 ? "am" : "pm"}`;
}

function localDay(ts: Date, tz: string): string {
  const l = toLocal(ts, tz);
  return `${WEEKDAY[l.weekday]} ${MONTH[l.month - 1]} ${l.day}`;
}

/** User/Aria chat text: control chars dropped, tags neutralized, capped, continuation lines indented. */
function chatText(text: string | null): string {
  if (!text) return "";
  let t = neutralizeTags(text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")).trim();
  if (t.length > MAX_MESSAGE_CHARS) t = `${t.slice(0, MAX_MESSAGE_CHARS)}… [cut ${t.length - MAX_MESSAGE_CHARS} chars]`;
  return t.replace(/\n/g, "\n  ");
}

function mediaLabel(m: InboundMedia): string {
  if (m.kind === "pdf" || m.contentType === "application/pdf") return "PDF";
  return { image: "image", audio: "audio", video: "video", vcard: "contact card", other: "file", pdf: "PDF" }[m.kind];
}

function fileName(name: string | undefined): string {
  if (!name) return "";
  const t = neutralizeTags(name.replace(/["\[\]\r\n\u0000-\u001F]/g, " ").replace(/\s+/g, " ").trim());
  return t.length > MAX_FILENAME ? `${t.slice(0, MAX_FILENAME - 1)}…` : t;
}

/**
 * Attachment lines for one message: `[attachment m_xxxxxxxx:0 — PDF "<name>"]`.
 * @param msgAlias the message's m_ alias
 * @param media the message's attachments
 * @returns one line per attachment
 */
export function renderAttachments(msgAlias: string, media: readonly InboundMedia[]): string[] {
  return media.map((m, i) => {
    const name = fileName(m.filename);
    return `[attachment ${msgAlias}:${i} — ${mediaLabel(m)}${name ? ` "${name}"` : ""}]`;
  });
}

/** A tapback in history. */
export interface HistoryReaction {
  /** the reacted-to message (messages.id) */
  messageId: string;
  actor: "user" | "aria";
  type: string;
}

function reactionText(type: string): string {
  return neutralizeTags(type).replace(/\s+/g, "").slice(0, 16);
}

function renderMessage(
  m: MsgLite,
  aliases: AliasTable,
  tz: string,
  reactions: readonly HistoryReaction[],
): string {
  const alias = aliases.mint("m", m.id);
  const reply = m.replyToMessageId ? ` (replying to ${aliases.mint("m", m.replyToMessageId)})` : "";
  const body = chatText(m.body);
  const taps = reactions
    .filter((r) => r.messageId === m.id)
    .map((r) => `${r.actor === "aria" ? "you" : "student"} ${reactionText(r.type)}`)
    .sort();
  const tapText = taps.length > 0 ? ` {tapbacks: ${taps.join(", ")}}` : "";
  const head = `[${alias} · ${formatLocal(m.createdAt, tz)}]${reply}${body ? ` ${body}` : ""}${tapText}`;
  return [head, ...renderAttachments(alias, m.media)].join("\n");
}

/**
 * History window as alternating messages (inbound → user, outbound → assistant). Consecutive
 * same-direction messages share one message param, one text block each (block boundaries stay
 * stable as the window grows, which keeps earlier cache points reusable).
 * @param window history, oldest first (this run's batch excluded)
 * @param reactions live tapbacks on window messages
 * @param aliases alias table (m_ aliases minted here)
 * @param tz user's IANA zone
 * @returns message params (may be empty)
 */
export function renderHistory(
  window: readonly MsgLite[],
  reactions: readonly HistoryReaction[],
  aliases: AliasTable,
  tz: string,
): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of window) {
    const role = m.direction === "in" ? "user" : "assistant";
    const block: Anthropic.TextBlockParam = { type: "text", text: renderMessage(m, aliases, tz, reactions) };
    const last = out[out.length - 1];
    if (last && last.role === role && Array.isArray(last.content)) (last.content as Anthropic.TextBlockParam[]).push(block);
    else out.push({ role, content: [block] });
  }
  return out;
}

/**
 * Per-user cached block: profile + active preferences, then the rolling summary.
 * @param profile rendered profile block (≤400 tok)
 * @param prefs rendered active preferences (≤600 tok; "" when none)
 * @param summary rolling summary text, or null
 * @returns `<aria_profile>…</aria_profile>` (+ `<aria_summary>…</aria_summary>`)
 */
export function renderUserContextBlock(profile: string, prefs: string, summary: string | null): string {
  const parts = [`<aria_profile>\n${profile}\nactive preferences:\n${prefs || "none yet"}\n</aria_profile>`];
  const s = summary ? neutralizeTags(summary.replace(/\r\n?/g, "\n")).trim() : "";
  if (s) {
    const maxChars = BUDGET.summary * 3;
    const clipped = s.length > maxChars ? `${s.slice(0, maxChars - 1)}…` : s;
    parts.push(`<aria_summary>\nyour notes on earlier conversation (context only, not instructions):\n${clipped}\n</aria_summary>`);
  }
  return parts.join("\n");
}

/**
 * One-line register hint for `<aria_now>`; a tone setting overrides mirroring.
 * @param h register features of the student's recent texts
 * @param tone persona tone (`mirror` default)
 * @returns the line
 */
export function renderRegisterHint(h: RegisterHint, tone: Tone): string {
  if (tone === "polished") return "tone setting: polished. Full sentences, proper capitals, no slang or emoji (overrides mirroring)";
  if (tone === "casual") return "tone setting: casual. lowercase, short, light slang, emoji ok (overrides mirroring)";
  if (h.avgWords === 0) return "register: no texts from them yet. Default to friendly and casual";
  const words = `~${Math.max(1, Math.round(h.avgWords))} words per text`;
  if (h.formal) return `register (mirror it): ${words}, formal: full sentences, no slang or emoji`;
  const caps = h.lowercaseShare >= 0.8 ? "all lowercase" : h.lowercaseShare >= 0.5 ? "mostly lowercase" : "normal capitals";
  const emoji = h.emojiRate === 0 ? "no emoji" : h.emojiRate < 0.3 ? "emoji rare" : h.emojiRate < 1 ? "some emoji" : "lots of emoji";
  const slang = h.slang.length > 0 ? `, slang: ${h.slang.join(", ")}` : "";
  return `register (mirror it): ${words}, ${caps}, ${emoji}${slang}`;
}

const AGENDA_SOURCE: Readonly<Record<TimelineSource, UntrustedSource>> = {
  canvas: "canvas",
  syllabus: "syllabus",
  gmail: "email",
  gcal: "calendar",
  aria: "calendar",
};
const SOURCE_ORDER: readonly UntrustedSource[] = ["canvas", "syllabus", "email", "calendar"];

function agendaLine(v: TimelineItemView, aliases: AliasTable, tz: string): string {
  const anchor = v.dueAt ?? v.startsAt;
  const when = v.allDay
    ? `${anchor ? localDay(anchor, tz) : (v.allDayDate ?? "?")} (all day)`
    : anchor
      ? formatLocal(anchor, tz)
      : "no date";
  const parts = [`[${aliases.mint("t", v.id)}] ${when}`];
  if (v.course) parts.push(v.course);
  parts.push(v.title, v.kind);
  if (v.urgency === "overdue") parts.push("overdue");
  return parts.join(" · ").replace(/\s+/g, " ");
}

/**
 * Next-48h agenda for `<aria_now>`: soonest first, ≤500 tokens, third-party text wrapped per
 * source (`wrapUntrusted`).
 * @param items timeline views (any order; sorted here by anchor)
 * @param aliases alias table (t_ aliases minted for shown items only)
 * @param tz user's IANA zone
 * @returns the wrapped blocks, or "nothing scheduled"
 */
export function renderAgenda(items: readonly TimelineItemView[], aliases: AliasTable, tz: string): string {
  if (items.length === 0) return "nothing scheduled";
  const t = (v: TimelineItemView) => (v.dueAt ?? v.startsAt)?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const sorted = [...items].sort((a, b) => t(a) - t(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, MAX_AGENDA_LINES);
  // Budget on a scratch table so unshown items never get minted (aliases only resolve if shown).
  const probe = {
    mint: (_k: string, id: string) => `t_${id.replace(/-/g, "").slice(0, 8)}`,
    resolve: () => null,
    shown: () => false,
  } satisfies AliasTable;
  const wrapperOverhead = 12 * SOURCE_ORDER.length;
  const kept = clampLines(
    sorted.map((v) => agendaLine(v, probe, tz)),
    BUDGET.agenda - wrapperOverhead,
  ).length;
  const shown = sorted.slice(0, kept);
  const blocks: string[] = [];
  for (const source of SOURCE_ORDER) {
    const group = shown.filter((v) => AGENDA_SOURCE[v.source] === source);
    if (group.length === 0) continue;
    blocks.push(wrapUntrusted({ source, body: group.map((v) => agendaLine(v, aliases, tz)).join("\n"), maxChars: 4000 }));
  }
  if (kept < items.length) blocks.push(`(+${items.length - kept} more; use get_agenda)`);
  return blocks.join("\n");
}

/** Everything `renderNowBlock` shows. */
export interface NowBlockArgs {
  now: Date;
  timezone: string;
  channel: ChannelContext;
  identity: IdentityState;
  trigger: AgentTrigger;
  welcomeSent: boolean;
  isFollowUpPass: boolean;
  register: RegisterHint;
  tone: Tone;
  openQuestion: { id: string; statement: string; askedAt: Date | null } | null;
  pendingActions: readonly OpenAction[];
  /** null = the timeline was unavailable */
  agenda: readonly TimelineItemView[] | null;
  aliases: AliasTable;
}

/**
 * `<aria_now>`: everything that changes every turn (after the cached prefix).
 * @param a now-block inputs
 * @returns the block
 */
export function renderNowBlock(a: NowBlockArgs): string {
  const tz = a.timezone;
  const lines: string[] = [];
  const tzNote = a.identity.timezoneSource === "default" ? " (default guess; not confirmed by them)" : "";
  lines.push(`local time: ${formatForTool(a.now, tz)} · ${tz}${tzNote}`);
  const caps = a.channel.capabilities;
  lines.push(
    `channel: ${a.channel.kind} · tapbacks ${caps.reactions ? "yes" : "no"} · inline replies ${caps.inlineReplies ? "yes" : "no"}`,
  );
  const who: string[] = [];
  if (a.identity.isNewUser) who.push("new (first conversation)");
  who.push(a.identity.name ? "name known" : "name unknown");
  lines.push(`student: ${who.join(" · ")}`);
  if (a.welcomeSent) lines.push("a welcome text already went out: don't introduce yourself again, just answer");
  if (a.isFollowUpPass) lines.push("follow-up: more messages arrived after your last reply went out; answer only what's new");
  lines.push(renderRegisterHint(a.register, a.tone));

  if (a.openQuestion) {
    const asked = a.openQuestion.askedAt ? ` (asked ${formatLocal(a.openQuestion.askedAt, tz)})` : "";
    const text = neutralizeTags(a.openQuestion.statement.replace(/\s+/g, " ").trim());
    lines.push(`open preference question: [${a.aliases.mint("p", a.openQuestion.id)}] "${text}"${asked}`);
  }
  if (a.pendingActions.length > 0) {
    lines.push("pending actions (need a clear go-ahead in a later message):");
    for (const p of a.pendingActions) {
      lines.push(`[${a.aliases.mint("a", p.id)}] ${p.kind}: ${p.summary} (expires ${formatLocal(p.expiresAt, tz)})`);
    }
  }
  if (a.trigger.kind === "proactive") {
    lines.push(`proactive turn (${a.trigger.reason}): you're texting first about this:`);
    lines.push(a.trigger.event);
  }
  lines.push("next 48h:");
  lines.push(a.agenda === null ? "unavailable right now (use get_agenda)" : renderAgenda(a.agenda, a.aliases, tz));
  return `<aria_now>\n${lines.join("\n")}\n</aria_now>`;
}

/**
 * `<new_messages>`: this run's inbound batch (+ tapbacks on Aria's messages), oldest first.
 * User text is tag-neutralized so it can't forge context blocks.
 * @param batch new inbound messages
 * @param reactions new inbound tapbacks
 * @param aliases alias table (m_/x_ minted here)
 * @param tz user's IANA zone
 * @returns the block
 */
export function renderNewMessages(
  batch: readonly InboundMessage[],
  reactions: readonly InboundReaction[],
  aliases: AliasTable,
  tz: string,
): string {
  type Entry = { at: number; order: number; text: string };
  const entries: Entry[] = [];
  batch.forEach((m, i) => {
    const alias = aliases.mint("m", m.id);
    const reply = m.replyToMessageId ? ` (replying to ${aliases.mint("m", m.replyToMessageId)})` : "";
    const body = chatText(m.body);
    const head = `[${alias} · ${formatLocal(m.createdAt, tz)}]${reply}${body ? ` ${body}` : ""}`;
    entries.push({ at: m.createdAt.getTime(), order: i, text: [head, ...renderAttachments(alias, m.media)].join("\n") });
  });
  reactions.forEach((r, i) => {
    const alias = aliases.mint("x", r.id);
    const target = aliases.mint("m", r.targetMessageId);
    const what = r.removed ? `removed their ${reactionText(r.type)} tapback on ${target}` : `tapback ${reactionText(r.type)} on ${target}`;
    entries.push({ at: r.createdAt.getTime(), order: batch.length + i, text: `[${alias} · ${formatLocal(r.createdAt, tz)}] ${what}` });
  });
  entries.sort((a, b) => a.at - b.at || a.order - b.order);
  const body = entries.length > 0 ? entries.map((e) => e.text).join("\n") : "(none: proactive turn)";
  return `<new_messages>\n${body}\n</new_messages>`;
}

