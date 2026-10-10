import "server-only";
// OWNER: 1.2

/**
 * Credential-free channel provider for local development, tests and the dev-chat REPL
 * (V2-03 §7, §10.3). Sends succeed instantly and are kept in an in-memory transcript; outbound
 * rows still go to `messages` through delivery, so the REPL can poll the DB. Console logs carry
 * the masked handle and lengths only, never bodies. `getProvider()` refuses this provider in
 * production.
 *
 * Webhook (`POST /api/channels/dev`, route owned by 2.1): requires `x-dev-secret` equal to the
 * configured secret (unset secret → every request is rejected). Body, one of:
 *   `{ handle, text?, mediaUrl?, media?, replyToProviderId?, providerMessageId?, service?, sentAt?, optedOut? }`
 *   `{ type: "typing", handle, isTyping }`
 *   `{ type: "reaction", handle, reaction, targetProviderId?, targetSnippet?, removed? }`
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { maskHandle, normalizeHandle } from "@/server/phone";
import { isValidReactionType } from "@/server/channels/plan";
import { staticCapabilities } from "@/server/channels/providers/capabilities";
import { inboundMediaFromUrl } from "@/server/channels/providers/sendblue";
import type {
  ChannelProvider,
  InboundEvent,
  InboundMedia,
  OutboundTarget,
  ReactionType,
  SendInput,
  SendResult,
  WebhookParse,
} from "@/server/channels/types";

/** Header carrying `DEV_CHANNEL_SECRET`. */
export const DEV_SECRET_HEADER = "x-dev-secret";
/** Line id the dev provider reports for inbound messages. */
export const DEV_LINE = "dev";

/** One thing the dev provider did. */
export type DevEvent =
  | { op: "send"; at: Date; handle: string; providerMessageId: string; text?: string; mediaUrl?: string; replyToProviderId?: string }
  | { op: "react"; at: Date; handle: string; providerMessageId: string; reaction: ReactionType }
  | { op: "typing"; at: Date; handle: string; state: "start" | "stop" }
  | { op: "mark_read"; at: Date; handle: string };

/** Dev provider plus transcript access. */
export type DevProvider = ChannelProvider & {
  /** Everything sent so far (oldest first). */
  transcript(): DevEvent[];
  /** Clears the transcript. */
  reset(): void;
};

const ServiceSchema = z.enum(["imessage", "sms", "rcs"]);
const MediaKind = z.enum(["image", "pdf", "audio", "video", "vcard", "other"]);

const DevMessageBody = z.object({
  type: z.literal("message").optional(),
  handle: z.string().min(1),
  text: z.string().max(20_000).optional(),
  mediaUrl: z.url().optional(),
  media: z
    .array(
      z.object({
        url: z.url(),
        kind: MediaKind.optional(),
        contentType: z.string().optional(),
        filename: z.string().optional(),
        size: z.number().int().nonnegative().optional(),
      }),
    )
    .max(10)
    .optional(),
  replyToProviderId: z.string().min(1).optional(),
  providerMessageId: z.string().min(1).max(200).optional(),
  service: ServiceSchema.optional(),
  sentAt: z.iso.datetime().optional(),
  optedOut: z.boolean().optional(),
});
const DevTypingBody = z.object({ type: z.literal("typing"), handle: z.string().min(1), isTyping: z.boolean() });
const DevReactionBody = z.object({
  type: z.literal("reaction"),
  handle: z.string().min(1),
  reaction: z.string().min(1),
  targetProviderId: z.string().min(1).optional(),
  targetSnippet: z.string().optional(),
  removed: z.boolean().optional(),
});

/**
 * Creates a dev provider.
 * @param opts `secret` = `DEV_CHANNEL_SECRET` (webhook auth); `now` clock for tests
 * @returns provider with an in-memory transcript
 */
export function createDevProvider(opts: { secret?: string | null; now?: () => Date } = {}): DevProvider {
  const now = opts.now ?? (() => new Date());
  let events: DevEvent[] = [];

  return {
    name: "dev",

    capabilities(service, handleKind) {
      return staticCapabilities("dev", service, handleKind);
    },

    async send(to: OutboundTarget, input: SendInput): Promise<SendResult> {
      const providerMessageId = `dev-out-${randomUUID()}`;
      events.push({
        op: "send",
        at: now(),
        handle: to.handle,
        providerMessageId,
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.mediaUrl !== undefined ? { mediaUrl: input.mediaUrl } : {}),
        ...(input.replyToProviderId ? { replyToProviderId: input.replyToProviderId } : {}),
      });
      console.info(
        `[dev-channel] → ${maskHandle(to.handle)} ${input.mediaUrl ? "media" : `bubble (${input.text?.length ?? 0} chars)`}`,
      );
      return { providerMessageId, status: "sent", service: to.service };
    },

    async react(to: OutboundTarget, providerMessageId: string, reaction: ReactionType): Promise<boolean> {
      events.push({ op: "react", at: now(), handle: to.handle, providerMessageId, reaction });
      return true;
    },

    async typing(to: OutboundTarget, state: "start" | "stop"): Promise<void> {
      events.push({ op: "typing", at: now(), handle: to.handle, state });
    },

    async markRead(to: OutboundTarget): Promise<void> {
      events.push({ op: "mark_read", at: now(), handle: to.handle });
    },

    parseWebhook(req): WebhookParse {
      if (!opts.secret || !secretMatches(req.headers.get(DEV_SECRET_HEADER), opts.secret)) {
        return { ok: false, status: 401 };
      }
      let json: unknown;
      try {
        json = JSON.parse(req.rawBody);
      } catch {
        return { ok: false, status: 400 };
      }
      const event = parseDevBody(json, now());
      return event ? { ok: true, events: [event] } : { ok: false, status: 400 };
    },

    transcript: () => [...events],
    reset: () => {
      events = [];
    },
  };
}

/**
 * Parses a dev webhook body into one inbound event.
 * @param json parsed body
 * @param now default `sentAt`
 * @returns the event, or null when the body is invalid
 */
export function parseDevBody(json: unknown, now: Date): InboundEvent | null {
  const typing = DevTypingBody.safeParse(json);
  if (typing.success) {
    const h = normalizeHandle(typing.data.handle);
    return h ? { type: "typing", handle: h.handle, isTyping: typing.data.isTyping } : null;
  }
  const reaction = DevReactionBody.safeParse(json);
  if (reaction.success) {
    const h = normalizeHandle(reaction.data.handle);
    if (!h || !isValidReactionType(reaction.data.reaction)) return null;
    return {
      type: "reaction",
      handle: h.handle,
      ...(reaction.data.targetProviderId ? { targetProviderId: reaction.data.targetProviderId } : {}),
      ...(reaction.data.targetSnippet ? { targetSnippet: reaction.data.targetSnippet } : {}),
      reaction: reaction.data.reaction,
      removed: reaction.data.removed ?? false,
      sentAt: now,
    };
  }
  const msg = DevMessageBody.safeParse(json);
  if (!msg.success) return null;
  const b = msg.data;
  const h = normalizeHandle(b.handle);
  if (!h) return null;
  const media: InboundMedia[] = [
    ...(b.mediaUrl ? [inboundMediaFromUrl(b.mediaUrl)] : []),
    ...(b.media ?? []).map((m) => {
      const inferred = inboundMediaFromUrl(m.url);
      return {
        ...inferred,
        kind: m.kind ?? inferred.kind,
        ...(m.contentType ? { contentType: m.contentType } : {}),
        ...(m.filename ? { filename: m.filename } : {}),
        ...(m.size !== undefined ? { size: m.size } : {}),
      };
    }),
  ];
  return {
    type: "message",
    providerMessageId: b.providerMessageId ?? `dev-in-${randomUUID()}`,
    handle: h.handle,
    handleKind: h.kind,
    line: DEV_LINE,
    service: b.service ?? "imessage",
    text: b.text ?? "",
    media,
    ...(b.replyToProviderId ? { replyToProviderId: b.replyToProviderId } : {}),
    sentAt: b.sentAt ? new Date(b.sentAt) : now,
    providerOptedOut: b.optedOut ?? false,
  };
}

function secretMatches(got: string | null, secret: string): boolean {
  if (!got) return false;
  const a = createHash("sha256").update(got.trim(), "utf8").digest();
  const b = createHash("sha256").update(secret.trim(), "utf8").digest();
  return timingSafeEqual(a, b);
}
