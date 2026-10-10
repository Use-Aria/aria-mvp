import "server-only";
// OWNER: 0.2 (frozen contract; only the orchestrator edits this file — master plan §1.0.2)

/**
 * Channel contract types (master plan §1.1 = V2-03 §7 `channels/types.ts` verbatim, plus):
 *  - `InboundMedia` gains optional `contentType` / `filename` / `size` (V2-08 ask, C35);
 *  - `OutboxItem` + zod schemas (`ReplyPlanSchema`, `OutboxItemSchema`) for the `proactive_flush`
 *    payload. V2-03 named `OutboxItem` in `plan.ts` without defining it; it lives here so the frozen
 *    job registry can validate it. `plan.ts` (task 1.2) re-exports the type.
 *
 * `ReplyPlan` is the ONE plan type for every producer (agent, briefing, reminders, alerts, notices).
 * Reactions are a plan field (there is no `react` tool); a link renders as its own bubble.
 */
import { z } from "zod";

export type ProviderName = "sendblue" | "dev";
export type Service = "imessage" | "sms" | "rcs";
export type ClassicTapback = "love" | "like" | "dislike" | "laugh" | "emphasize" | "question";
/** Classic name or exactly one emoji (Sendblue rejects anything else). */
export type ReactionType = ClassicTapback | (string & { readonly __emoji?: never });

export interface PlanReaction {
  /** messages.id of an INBOUND message from this user. */
  targetMessageId: string;
  type: ReactionType;
  /** Sent as a bubble only when the channel can't do tapbacks (e.g. "👍" for a confirmation). */
  fallbackText?: string;
}
export interface PlanBubble {
  /** ≤ 1200 chars after validation. */
  text: string;
  /** messages.id to thread under (inline reply on iMessage V2 lines). */
  replyToMessageId?: string;
}
export interface ReplyPlan {
  /** ≤ 2 */
  reactions?: PlanReaction[];
  /** 0–3 (0 allowed iff reactions present). A link counts toward the 3-bubble cap. */
  bubbles: PlanBubble[];
  /** appOrigin() or https://mail.google.com/ only. Rendered as its own bubble. */
  link?: { url: string };
  /** appOrigin() only. */
  media?: { url: string; kind: "vcard" | "image" | "file" }[];
}
export interface ChannelCapabilities {
  reactions: boolean;
  typing: boolean;
  inlineReplies: boolean;
  media: boolean;
  maxBubbleChars: number;
}
/** What tools/agent may know about the channel. Never includes the raw handle. */
export interface ChannelContext {
  channelId: string;
  provider: ProviderName;
  kind: "imessage" | "sms" | "whatsapp";
  service: Service;
  handleKind: "phone" | "email" | "bsuid";
  capabilities: ChannelCapabilities;
  windowOpen: boolean;
}
export interface OutboundTarget {
  handle: string;
  line: string | null;
  service: Service;
}
export interface SendInput {
  text?: string;
  mediaUrl?: string;
  replyToProviderId?: string;
}
export interface SendResult {
  providerMessageId: string | null;
  status: "sent" | "queued" | "declined" | "failed";
  service?: Service;
  errorKey?: string;
}
export type InboundEvent =
  | {
      type: "message";
      providerMessageId: string;
      handle: string;
      handleKind: "phone" | "email";
      line: string | null;
      service: Service;
      text: string;
      media: InboundMedia[];
      replyToProviderId?: string;
      sentAt: Date;
      providerOptedOut: boolean;
    }
  | {
      type: "reaction";
      handle: string;
      targetProviderId?: string;
      targetSnippet?: string;
      reaction: ReactionType;
      removed: boolean;
      sentAt: Date;
    } // [verify] shape
  | { type: "status"; providerMessageId: string; status: string; errorKey?: string; service?: Service }
  | { type: "typing"; handle: string; isTyping: boolean }
  | { type: "ignored"; reason: "group" | "outbound_echo" | "unparseable" | "unsupported" };
/** One inbound attachment (`messages.media[]`). Optional fields per V2-08 (C35). */
export interface InboundMedia {
  url: string;
  kind: "image" | "pdf" | "audio" | "video" | "vcard" | "other";
  contentType?: string;
  filename?: string;
  size?: number;
}
export type WebhookParse = { ok: false; status: 401 | 400 } | { ok: true; events: InboundEvent[] };

export interface ChannelProvider {
  readonly name: ProviderName;
  capabilities(service: Service, handleKind: "phone" | "email" | "bsuid"): ChannelCapabilities;
  send(to: OutboundTarget, input: SendInput): Promise<SendResult>;
  react(to: OutboundTarget, providerMessageId: string, reaction: ReactionType): Promise<boolean>;
  typing(to: OutboundTarget, state: "start" | "stop", maxMs?: number): Promise<void>;
  markRead?(to: OutboundTarget): Promise<void>;
  parseWebhook(req: { headers: Headers; rawBody: string }): WebhookParse;
}

// ── zod mirrors (job payloads are JSON; dates are ISO strings) ────────────────────────────

/** zod mirror of `ReplyPlan` (structure only; `validatePlan` in plan.ts enforces caps/allow-lists). */
export const ReplyPlanSchema = z.object({
  reactions: z
    .array(
      z.object({
        targetMessageId: z.string().min(1),
        type: z.string().min(1),
        fallbackText: z.string().optional(),
      }),
    )
    .optional(),
  bubbles: z.array(z.object({ text: z.string(), replyToMessageId: z.string().optional() })),
  link: z.object({ url: z.string() }).optional(),
  media: z.array(z.object({ url: z.string(), kind: z.enum(["vcard", "image", "file"]) })).optional(),
});

/**
 * One queued proactive delivery inside the per-user outbox (`proactive_flush` payload item).
 * Written by `deliver(…, {proactive: true})`; the flush re-applies every guard at send time.
 */
export const OutboxItemSchema = z.object({
  plan: ReplyPlanSchema,
  /** `DeliverOptions.reason`. */
  reason: z.string().min(1).max(64),
  /** `DeliverPriority`. */
  priority: z.enum(["routine", "urgent", "requested"]),
  /** Producer idempotency key (claimed in `proactive_dedupe` at flush). */
  dedupeKey: z.string().min(1).max(200),
  /** Target channel; null = the user's primary channel at flush time. */
  channelId: z.string().nullable(),
  /** ISO instant `deliver` accepted the item (merge order). */
  enqueuedAt: z.iso.datetime(),
  notBefore: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
});
/** One queued proactive delivery (see `OutboxItemSchema`). */
export type OutboxItem = z.output<typeof OutboxItemSchema>;

// Compile-time guard: the zod mirror's output must stay assignable to `ReplyPlan`.
const _planCompat: (p: z.output<typeof ReplyPlanSchema>) => ReplyPlan = (p) => p;
void _planCompat;
