import "server-only";
// OWNER: 1.2

/**
 * Plan → steps (pure; V2-03 §2.10). Order: reactions first (a tapback reads as "seen"), then for
 * each bubble typing → pause ∝ length → send, then the link bubble, then media. On channels
 * without reactions / inline replies (SMS, RCS) the plan degrades: reactions become their
 * `fallbackText` bubble (or vanish), and `replyTo` becomes a quote prefix when the plan answers
 * more than one distinct message.
 *
 * Every send/react step carries a unique `bubbleIndex`; delivery uses it for idempotency keys
 * (`<runId>:<i>`), so indices must be stable for a given plan + capabilities.
 */
import { PIPELINE } from "@/server/pipeline/config";
import type { ChannelCapabilities, ReactionType, ReplyPlan } from "@/server/channels/types";

/** What a send step carries. */
export type SendKind = "bubble" | "link" | "media" | "fallback";

/** One executable step. */
export type RenderStep =
  | {
      t: "react";
      targetMessageId: string;
      reaction: ReactionType;
      /** Sent as a bubble if the reaction can't be delivered (e.g. reactions disabled mid-run). */
      fallbackText?: string;
      bubbleIndex: number;
    }
  | { t: "typing"; state: "start" | "stop" }
  | { t: "pause"; ms: number }
  | {
      t: "send";
      kind: SendKind;
      text?: string;
      mediaUrl?: string;
      replyToMessageId?: string;
      bubbleIndex: number;
    };

/** A send step (narrowed). */
export type SendStep = Extract<RenderStep, { t: "send" }>;
/** A react step (narrowed). */
export type ReactStep = Extract<RenderStep, { t: "react" }>;

const SNIPPET_CHARS = 24;

/**
 * Typing pause for a bubble: `clamp(chars / 35 * 1000, 800, 4000)` ms (chars = code points).
 * @param text bubble text
 * @returns pause in whole milliseconds
 */
export function bubblePauseMs(text: string): number {
  const chars = Array.from(text).length;
  const raw = Math.round((chars / PIPELINE.charsPerSecond) * 1000);
  return Math.min(PIPELINE.maxPauseMs, Math.max(PIPELINE.minPauseMs, raw));
}

/**
 * Quote prefix used when inline replies are unavailable: `“<first 24 chars>…” → `.
 * @param snippet the quoted message text
 * @returns the prefix, or "" when there is nothing to quote
 */
export function quotePrefix(snippet: string | undefined): string {
  const s = (snippet ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  const chars = Array.from(s);
  const head = chars.slice(0, SNIPPET_CHARS).join("").trimEnd();
  return `“${head}${chars.length > SNIPPET_CHARS ? "…" : ""}” → `;
}

/**
 * Turns a validated plan into executable steps for a channel.
 * @param plan validated plan (`validatePlan` output)
 * @param caps channel capabilities
 * @param opts `elapsedMs` since the run started (LLM latency already counts as "typing" time for
 *   the first bubble); `snippets` maps message ids to their text for SMS quote prefixes
 * @returns ordered steps
 */
export function renderPlan(
  plan: ReplyPlan,
  caps: ChannelCapabilities,
  opts: { elapsedMs: number; snippets: Record<string, string> },
): RenderStep[] {
  const steps: RenderStep[] = [];
  let index = 0;

  // 1. Reactions (or their fallback text on channels without tapbacks).
  const texts: { text: string; replyToMessageId?: string; kind: SendKind }[] = [];
  for (const r of plan.reactions ?? []) {
    if (caps.reactions) {
      steps.push({
        t: "react",
        targetMessageId: r.targetMessageId,
        reaction: r.type,
        ...(r.fallbackText ? { fallbackText: r.fallbackText } : {}),
        bubbleIndex: index++,
      });
    } else if (r.fallbackText) {
      texts.push({ text: r.fallbackText, kind: "fallback" });
    }
  }

  // 2. Bubbles, with SMS degradation of inline replies.
  const targets = new Set(plan.bubbles.map((b) => b.replyToMessageId).filter((id): id is string => !!id));
  for (const b of plan.bubbles) {
    if (b.replyToMessageId && caps.inlineReplies) {
      texts.push({ text: b.text, replyToMessageId: b.replyToMessageId, kind: "bubble" });
    } else if (b.replyToMessageId && targets.size > 1) {
      texts.push({ text: `${quotePrefix(opts.snippets[b.replyToMessageId])}${b.text}`, kind: "bubble" });
    } else {
      texts.push({ text: b.text, kind: "bubble" });
    }
  }

  // 3. The link as its own bubble, unless a bubble already contains it.
  const url = plan.link?.url;
  if (url && !plan.bubbles.some((b) => b.text.includes(url))) texts.push({ text: url, kind: "link" });

  let first = true;
  for (const item of texts) {
    if (caps.typing) steps.push({ t: "typing", state: "start" });
    const computed = bubblePauseMs(item.text);
    const ms = first ? Math.max(PIPELINE.minPauseMs, computed - Math.max(0, opts.elapsedMs)) : computed;
    first = false;
    steps.push({ t: "pause", ms });
    steps.push({
      t: "send",
      kind: item.kind,
      text: item.text,
      ...(item.replyToMessageId ? { replyToMessageId: item.replyToMessageId } : {}),
      bubbleIndex: index++,
    });
  }

  // 4. Media, outside the bubble cap.
  if (caps.media) {
    for (const m of plan.media ?? []) {
      steps.push({ t: "send", kind: "media", mediaUrl: m.url, bubbleIndex: index++ });
    }
  }

  // 5. Nothing to send: clear the typing indicator started on inbound.
  if (!steps.some((s) => s.t === "send") && caps.typing) steps.push({ t: "typing", state: "stop" });
  return steps;
}
