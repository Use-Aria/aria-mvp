import "server-only";
// OWNER: 1.2

/**
 * Sendblue adapter over raw `fetch` — no Sendblue SDK (V2-03 §3, §7; master plan §1.1).
 *
 * - Auth headers `sb-api-key-id` / `sb-api-secret-key`. Base URL from `SENDBLUE_API_BASE`
 *   (default `https://api.sendblue.com`; `.co` per the SDK is [verify]).
 * - 10s timeout per request. `send-message` is retried **once**, only on 429/503 or a connection
 *   error that happened before the request was written (DNS / refused); never on a timeout or an
 *   ambiguous failure (at-most-once). Typing, reactions and mark-read are best-effort with one
 *   retry on 429/503.
 * - Webhook: the `sb-signing-secret` header is a static shared secret (no HMAC, no timestamp),
 *   compared in constant time against every configured secret (comma list → rotation).
 * - A 422 `unsupported_on_this_line` on a reaction disables reactions for this instance; a 400 on
 *   an inline reply disables inline replies (both reflected in `capabilities()`).
 * - Logs carry masked handles only — never message bodies, secrets or tokens.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { maskHandle, normalizeHandle } from "@/server/phone";
import { PIPELINE } from "@/server/pipeline/config";
import { REPLY_REJECTED } from "@/server/channels/execute";
import { isValidReactionType } from "@/server/channels/plan";
import { staticCapabilities } from "@/server/channels/providers/capabilities";
import {
  parseTapbackText,
  SendblueMessagePayload,
  SendblueSendResponse,
  SendblueTypingPayload,
} from "@/server/channels/providers/sendblue-schema";
import type {
  ChannelCapabilities,
  ChannelProvider,
  InboundEvent,
  InboundMedia,
  OutboundTarget,
  ReactionType,
  SendInput,
  SendResult,
  Service,
} from "@/server/channels/types";

/** Default API base (docs). */
export const SENDBLUE_DEFAULT_BASE = "https://api.sendblue.com";
/** Webhook signature header. */
export const SENDBLUE_SIGNATURE_HEADER = "sb-signing-secret";

/** Adapter configuration. */
export interface SendblueConfig {
  apiKey: string;
  apiSecret: string;
  /** API base URL, no trailing slash. */
  base: string;
  /** Accepted webhook secrets (rotation: old + new). */
  signingSecrets: string[];
  /** Default line (`SENDBLUE_FROM_NUMBER`) when a target has no `line`. */
  fromNumber?: string | null;
  /** Injected for tests. */
  fetch?: typeof fetch;
  /** Injected for tests (retry delay). */
  sleep?: (ms: number) => Promise<void>;
  /** Per-request timeout (default 10s). */
  timeoutMs?: number;
  /** Map legacy `Loved “…”` texts to reaction events ([verify]; default off). */
  parseTapbacks?: boolean;
}

type CallOutcome =
  | { kind: "response"; status: number; body: unknown; retryAfterMs: number | null }
  | { kind: "timeout" }
  | { kind: "connect_error"; preWrite: boolean };

const PRE_WRITE_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);
const MAX_RETRY_AFTER_MS = 5_000;
const DEFAULT_RETRY_MS = 1_000;

/**
 * Constant-time check of the `sb-signing-secret` header against the configured secrets.
 * Compares SHA-256 digests so length differences don't leak; checks every secret (no early exit).
 * @param headers request headers
 * @param secrets configured secrets (empty entries ignored)
 * @returns true when the header matches one secret
 */
export function verifySendblueSecret(headers: Headers, secrets: string[]): boolean {
  const got = headers.get(SENDBLUE_SIGNATURE_HEADER)?.trim();
  if (!got) return false;
  const gotDigest = createHash("sha256").update(got, "utf8").digest();
  let ok = false;
  for (const secret of secrets) {
    const s = secret.trim();
    if (!s) continue;
    const digest = createHash("sha256").update(s, "utf8").digest();
    if (timingSafeEqual(gotDigest, digest)) ok = true;
  }
  return ok;
}

/**
 * Splits `SENDBLUE_SIGNING_SECRET` (comma-separated for rotation).
 * @param raw env value
 * @returns non-empty trimmed secrets
 */
export function parseSigningSecrets(raw: string | undefined | null): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Maps Sendblue's `service` field (+ `was_downgraded`) to our transport.
 * @param service "iMessage" | "SMS" | "RCS" | other
 * @param downgraded `was_downgraded`
 * @returns transport
 */
export function mapService(service: string | null | undefined, downgraded?: boolean | null): Service {
  const s = (service ?? "").toLowerCase();
  if (s === "sms" || s === "mms") return "sms";
  if (s === "rcs") return "rcs";
  if (downgraded) return "sms";
  return "imessage";
}

/**
 * Infers the attachment kind from a media URL's extension.
 * @param url media URL
 * @returns media entry (kind + filename when the path has one)
 */
export function inboundMediaFromUrl(url: string): InboundMedia {
  let filename: string | undefined;
  let ext = "";
  try {
    const path = new URL(url).pathname;
    const last = decodeURIComponent(path.split("/").pop() ?? "");
    if (last) filename = last;
    const dot = last.lastIndexOf(".");
    if (dot >= 0) ext = last.slice(dot + 1).toLowerCase();
  } catch {
    // keep defaults
  }
  const kind: InboundMedia["kind"] =
    ext === "pdf"
      ? "pdf"
      : ["jpg", "jpeg", "png", "gif", "heic", "heif", "webp", "tif", "tiff", "bmp"].includes(ext)
        ? "image"
        : ["mp3", "m4a", "caf", "aac", "wav", "amr", "ogg", "opus"].includes(ext)
          ? "audio"
          : ["mp4", "mov", "m4v", "3gp", "webm"].includes(ext)
            ? "video"
            : ["vcf", "vcard"].includes(ext)
              ? "vcard"
              : "other";
  return { url, kind, ...(filename ? { filename } : {}) };
}

/**
 * Parses a (verified) Sendblue webhook body into events. Never throws.
 * - `receive` → `message` (handle from `from_number ?? number`, normalized; line from
 *   `sendblue_number ?? to_number`)
 * - group messages → ignored "group"; outbound echoes → ignored "outbound_echo", except
 *   DECLINED/ERROR outbound statuses → `status` (opt-out mirroring)
 * - `typing_indicator` → `typing`; other webhook types → ignored "unsupported"
 * - invalid JSON or an unrecognisable message → ignored "unparseable"
 * @param rawBody request body text
 * @param opts `now` for missing dates; `parseTapbacks` maps legacy tapback texts ([verify])
 * @returns events (one per payload object)
 */
export function parseSendblueWebhook(
  rawBody: string,
  opts: { now?: Date; parseTapbacks?: boolean } = {},
): InboundEvent[] {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return [{ type: "ignored", reason: "unparseable" }];
  }
  const items = Array.isArray(json) ? json : [json];
  if (items.length === 0) return [{ type: "ignored", reason: "unparseable" }];
  return items.map((item) => parseOne(item, opts.now ?? new Date(), opts.parseTapbacks ?? false));
}

function parseOne(item: unknown, now: Date, parseTapbacks: boolean): InboundEvent {
  if (typeof item !== "object" || item === null) return { type: "ignored", reason: "unparseable" };
  const obj = item as Record<string, unknown>;

  if (typeof obj.is_typing === "boolean") {
    const typing = SendblueTypingPayload.safeParse(obj);
    if (!typing.success) return { type: "ignored", reason: "unparseable" };
    const h = normalizeHandle(typing.data.number);
    return h ? { type: "typing", handle: h.handle, isTyping: typing.data.is_typing } : { type: "ignored", reason: "unparseable" };
  }
  if (!("message_handle" in obj)) return { type: "ignored", reason: "unsupported" };

  const parsed = SendblueMessagePayload.safeParse(obj);
  if (!parsed.success) return { type: "ignored", reason: "unparseable" };
  const p = parsed.data;
  const service = mapService(p.service, p.was_downgraded);

  if (p.is_outbound) {
    const status = (p.status ?? "").toUpperCase();
    if (status === "DECLINED" || status === "ERROR") {
      const errorKey = p.error_key ?? (p.error_code != null ? String(p.error_code) : undefined);
      return {
        type: "status",
        providerMessageId: p.message_handle,
        status,
        ...(errorKey ? { errorKey } : {}),
        service,
      };
    }
    return { type: "ignored", reason: "outbound_echo" };
  }
  if ((p.group_id && p.group_id.trim() !== "") || (p.participants && p.participants.length > 1)) {
    return { type: "ignored", reason: "group" };
  }

  const handle = normalizeHandle(p.from_number ?? p.number ?? "");
  if (!handle) return { type: "ignored", reason: "unparseable" };
  const sentAt = parseDate(p.date_sent) ?? parseDate(p.date_updated) ?? now;
  const text = p.content ?? "";

  if (parseTapbacks) {
    const tap = parseTapbackText(text);
    if (tap && isValidReactionType(tap.reaction)) {
      return {
        type: "reaction",
        handle: handle.handle,
        targetSnippet: tap.snippet,
        reaction: tap.reaction,
        removed: tap.removed,
        sentAt,
      };
    }
  }

  const urls = (Array.isArray(p.media_url) ? p.media_url : p.media_url ? [p.media_url] : []).filter(
    (u) => typeof u === "string" && u.trim() !== "",
  );
  const line = p.sendblue_number ?? p.to_number ?? null;
  const replyTo = p.reply_to?.message_handle ?? undefined;
  return {
    type: "message",
    providerMessageId: p.message_handle,
    handle: handle.handle,
    handleKind: handle.kind,
    line: line ? (normalizeHandle(line)?.handle ?? line) : null,
    service,
    text,
    media: urls.map((u) => inboundMediaFromUrl(u.trim())),
    ...(replyTo ? { replyToProviderId: replyTo } : {}),
    sentAt,
    providerOptedOut: p.opted_out === true,
  };
}

function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Creates the Sendblue provider.
 * @param cfg credentials, base URL, webhook secrets, default line; `fetch`/`sleep` injectable
 * @returns a `ChannelProvider` for Sendblue
 */
export function createSendblueProvider(cfg: SendblueConfig): ChannelProvider {
  const doFetch = cfg.fetch ?? fetch;
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = cfg.timeoutMs ?? PIPELINE.providerTimeoutMs;
  const base = cfg.base.replace(/\/+$/, "");
  let reactionsDisabled = false;
  let inlineRepliesDisabled = false;
  let loggedReactionsOff = false;

  async function call(path: string, body: Record<string, unknown>): Promise<CallOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(`${base}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "sb-api-key-id": cfg.apiKey,
          "sb-api-secret-key": cfg.apiSecret,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text().catch(() => "");
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      return { kind: "response", status: res.status, body: parsed, retryAfterMs: retryAfter(res.headers) };
    } catch (err) {
      if (controller.signal.aborted) return { kind: "timeout" };
      return { kind: "connect_error", preWrite: isPreWriteError(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** One call plus at most one retry on 429/503 (and, if allowed, a pre-write connect error). */
  async function callWithRetry(path: string, body: Record<string, unknown>, retryConnect: boolean): Promise<CallOutcome> {
    const first = await call(path, body);
    const retryable =
      (first.kind === "response" && (first.status === 429 || first.status === 503)) ||
      (retryConnect && first.kind === "connect_error" && first.preWrite);
    if (!retryable) return first;
    await sleep(first.kind === "response" && first.retryAfterMs !== null ? first.retryAfterMs : DEFAULT_RETRY_MS);
    return call(path, body);
  }

  function fromNumber(to: OutboundTarget): string | undefined {
    return to.line ?? cfg.fromNumber ?? undefined;
  }

  return {
    name: "sendblue",

    capabilities(service, handleKind): ChannelCapabilities {
      const caps = staticCapabilities("sendblue", service, handleKind);
      return {
        ...caps,
        reactions: caps.reactions && !reactionsDisabled,
        inlineReplies: caps.inlineReplies && !inlineRepliesDisabled,
      };
    },

    async send(to: OutboundTarget, input: SendInput): Promise<SendResult> {
      const body: Record<string, unknown> = { number: to.handle };
      const from = fromNumber(to);
      if (from) body.from_number = from;
      if (input.text !== undefined) body.content = input.text;
      if (input.mediaUrl !== undefined) body.media_url = input.mediaUrl;
      if (input.replyToProviderId) body.reply_to = { message_handle: input.replyToProviderId };

      const out = await callWithRetry("/api/send-message", body, true);
      if (out.kind === "timeout") {
        console.warn(`[sendblue] send timeout for ${maskHandle(to.handle)} (not resent)`);
        return { providerMessageId: null, status: "failed", errorKey: "timeout" };
      }
      if (out.kind === "connect_error") {
        console.warn(`[sendblue] send connection error for ${maskHandle(to.handle)}`);
        return { providerMessageId: null, status: "failed", errorKey: "connection_error" };
      }
      const parsed = SendblueSendResponse.safeParse(out.body);
      const r = parsed.success ? parsed.data : null;
      const providerMessageId = r?.message_handle ?? null;
      const status = (r?.status ?? "").toUpperCase();
      const errorKey = r?.error_key ?? undefined;
      const service = r ? mapService(r.service, r.was_downgraded) : undefined;

      if (out.status >= 200 && out.status < 300) {
        if (status === "DECLINED") return { providerMessageId, status: "declined", errorKey: errorKey ?? "DECLINED", service };
        if (status === "ERROR") return { providerMessageId, status: "failed", errorKey: errorKey ?? "ERROR", service };
        const sent = status === "SENT" || status === "DELIVERED";
        return { providerMessageId, status: sent ? "sent" : "queued", ...(service ? { service } : {}) };
      }
      if (out.status === 400) {
        if (input.replyToProviderId && status !== "DECLINED" && errorKey !== "OPTED_OUT") {
          if (!inlineRepliesDisabled) console.warn("[sendblue] inline reply rejected; disabling inline replies");
          inlineRepliesDisabled = true;
          return { providerMessageId, status: "failed", errorKey: REPLY_REJECTED };
        }
        return { providerMessageId, status: "declined", errorKey: errorKey ?? "DECLINED" };
      }
      console.warn(`[sendblue] send http ${out.status} for ${maskHandle(to.handle)}`);
      return { providerMessageId, status: "failed", errorKey: errorKey ?? `http_${out.status}` };
    },

    async react(to: OutboundTarget, providerMessageId: string, reaction: ReactionType): Promise<boolean> {
      if (reactionsDisabled) return false;
      const body: Record<string, unknown> = { message_handle: providerMessageId, reaction };
      const from = fromNumber(to);
      if (from) body.from_number = from;
      const out = await callWithRetry("/api/send-reaction", body, false);
      if (out.kind !== "response") return false;
      if (out.status >= 200 && out.status < 300) return true;
      if (out.status === 422 && JSON.stringify(out.body ?? "").includes("unsupported_on_this_line")) {
        reactionsDisabled = true;
        if (!loggedReactionsOff) {
          loggedReactionsOff = true;
          console.warn("[sendblue] reactions unsupported on this line; disabled for this instance");
        }
      }
      return false;
    },

    async typing(to: OutboundTarget, state: "start" | "stop", maxMs?: number): Promise<void> {
      if (to.service !== "imessage") return;
      const body: Record<string, unknown> = { number: to.handle, state };
      const from = fromNumber(to);
      if (from) body.from_number = from;
      if (maxMs !== undefined) body.max_duration_ms = Math.min(300_000, Math.max(1, Math.round(maxMs)));
      await callWithRetry("/api/send-typing-indicator", body, false);
    },

    async markRead(to: OutboundTarget): Promise<void> {
      const body: Record<string, unknown> = { number: to.handle };
      const from = fromNumber(to);
      if (from) body.from_number = from;
      await callWithRetry("/api/mark-read", body, false);
    },

    parseWebhook(req) {
      if (!verifySendblueSecret(req.headers, cfg.signingSecrets)) return { ok: false, status: 401 };
      try {
        JSON.parse(req.rawBody);
      } catch {
        return { ok: false, status: 400 };
      }
      return { ok: true, events: parseSendblueWebhook(req.rawBody, { parseTapbacks: cfg.parseTapbacks }) };
    },
  };
}

function retryAfter(headers: Headers): number | null {
  const v = headers.get("retry-after");
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(MAX_RETRY_AFTER_MS, secs * 1000);
  return null;
}

function isPreWriteError(err: unknown): boolean {
  const code = errorCode(err) ?? (err instanceof Error ? errorCode(err.cause) : undefined);
  return code !== undefined && PRE_WRITE_CODES.has(code);
}

function errorCode(e: unknown): string | undefined {
  if (typeof e === "object" && e !== null && "code" in e) {
    const c = (e as { code: unknown }).code;
    return typeof c === "string" ? c : undefined;
  }
  return undefined;
}
