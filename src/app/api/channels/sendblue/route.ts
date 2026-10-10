import "server-only";
// OWNER: 2.1

/**
 * `POST /api/channels/sendblue` — Sendblue inbound webhook (V2-03 §2.3, §2.12, §7 Routes).
 *
 * Reads the raw body, verifies the static `sb-signing-secret` (constant time, rotation list)
 * before parsing anything, ingests (fast DB work, < 1s), answers, and runs the debounce sleep +
 * fast-path claim in `after()` (bounded by `maxDuration`). 401 bad secret, 400 unparseable,
 * 500 when the DB failed before the insert (Sendblue retries; the insert is idempotent),
 * 503 when the Sendblue provider isn't configured.
 */
import { after } from "next/server";
import { getProvider, type ChannelProvider } from "@/server/channels";
import { respondToWebhook } from "@/server/pipeline/ingest";

export const maxDuration = 300;

/** Refuse bodies larger than this (Sendblue payloads are a few KB). */
const MAX_BODY_BYTES = 256 * 1024;

/** Sendblue webhook (receive / typing / status). */
export async function POST(req: Request): Promise<Response> {
  const startedAt = Date.now();
  let provider: ChannelProvider;
  try {
    provider = getProvider("sendblue");
  } catch {
    console.error("[pipeline] sendblue webhook: provider not configured");
    return Response.json({ error: "channel_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return Response.json({ error: "too_large" }, { status: 413, headers: { "Cache-Control": "no-store" } });
  }
  const parsed = provider.parseWebhook({ headers: req.headers, rawBody });
  return respondToWebhook(provider, parsed, (task) => after(task), startedAt);
}
