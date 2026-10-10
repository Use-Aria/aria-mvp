import "server-only";
// OWNER: 2.2

/**
 * History window (V2-04 §2.5). Pure.
 *
 * `conversation_summaries.through_message_id` anchors the window: messages up to and including
 * the anchor are folded into the rolling summary; the window is everything after it. It normally
 * holds 20–30 messages; past 30 the summary job folds the oldest 10 and advances the anchor, so
 * the history prefix (and its aliases) stays byte-stable for ~10 messages at a time. Hard cap 40
 * if the job lags.
 */
import { WINDOW_HARD_MAX, WINDOW_MAX } from "@/server/agent/config";
import type { InboundMedia } from "@/server/channels/types";

/** A message as the context builder needs it. */
export interface MsgLite {
  id: string;
  direction: "in" | "out";
  body: string | null;
  media: InboundMedia[];
  replyToMessageId: string | null;
  createdAt: Date;
}

const MEDIA_KINDS: ReadonlySet<string> = new Set(["image", "pdf", "audio", "video", "vcard", "other"]);

/**
 * Parse `messages.media` leniently.
 * @param json stored value (InboundMedia[] expected)
 * @returns valid entries, in order (unknown kinds → "other")
 */
export function parseMedia(json: unknown): InboundMedia[] {
  if (!Array.isArray(json)) return [];
  const out: InboundMedia[] = [];
  for (const v of json) {
    if (typeof v !== "object" || v === null || Array.isArray(v)) continue;
    const o = v as Record<string, unknown>;
    if (typeof o.url !== "string") continue;
    const kind = typeof o.kind === "string" && MEDIA_KINDS.has(o.kind) ? (o.kind as InboundMedia["kind"]) : "other";
    const m: InboundMedia = { url: o.url, kind };
    if (typeof o.contentType === "string") m.contentType = o.contentType;
    if (typeof o.filename === "string") m.filename = o.filename;
    if (typeof o.size === "number" && Number.isFinite(o.size)) m.size = o.size;
    out.push(m);
  }
  return out;
}

/**
 * Pick the history window.
 * @param msgs messages, oldest first (the newest ≥ WINDOW_HARD_MAX + 1 at least, plus the anchor if near)
 * @param anchorId `through_message_id` (summarized through here), or null
 * @returns the window (oldest first, ≤ 40) and whether the summary job should run (> 30)
 */
export function selectWindow(msgs: readonly MsgLite[], anchorId: string | null): { window: MsgLite[]; needsSummary: boolean } {
  const at = anchorId ? msgs.findIndex((m) => m.id === anchorId) : -1;
  const after = at >= 0 ? msgs.slice(at + 1) : [...msgs];
  return { window: after.slice(-WINDOW_HARD_MAX), needsSummary: after.length > WINDOW_MAX };
}
