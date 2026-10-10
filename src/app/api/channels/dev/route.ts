import "server-only";
// OWNER: 2.1

/**
 * `POST /api/channels/dev` — credential-free inbound channel for local development, the dev-chat
 * REPL (`--http`) and evals (V2-03 §2.12, §7 Routes, §10.3).
 *
 * Active only outside production, and only when `CHANNEL_PROVIDER=dev` or `DEV_CHANNEL_SECRET` is
 * set; otherwise 404. Every request needs `x-dev-secret: $DEV_CHANNEL_SECRET` (checked by the dev
 * provider before anything else). Body: see `channels/providers/dev.ts`, plus two conveniences
 * mapped here from our ids to provider ids (the RPC resolves reply-to by provider id):
 *   `replyToMessageId` (messages.id) → `replyToProviderId`,
 *   `targetMessageId` (messages.id, reactions) → `targetProviderId`.
 * Then the same ingest path as Sendblue.
 */
import { after } from "next/server";
import { getProvider, type ChannelProvider } from "@/server/channels";
import { getProviderMessageId } from "@/server/channels/repo";
import { isProduction, optionalEnv } from "@/server/env";
import { devRouteEnabled, respondToWebhook } from "@/server/pipeline/ingest";

export const maxDuration = 300;

const MAX_BODY_BYTES = 256 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notFound(): Response {
  return new Response("Not Found", { status: 404 });
}

/** Rewrites our message ids to provider ids; null when a referenced message has no provider id. */
async function mapIds(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const out: Record<string, unknown> = { ...body };
  for (const [ours, theirs] of [
    ["replyToMessageId", "replyToProviderId"],
    ["targetMessageId", "targetProviderId"],
  ] as const) {
    const id = out[ours];
    if (id === undefined) continue;
    delete out[ours];
    if (typeof id !== "string" || !UUID_RE.test(id)) return null;
    const providerId = await getProviderMessageId(id);
    if (!providerId) return null;
    out[theirs] = providerId;
  }
  return out;
}

/** Dev inbound message / typing / reaction. */
export async function POST(req: Request): Promise<Response> {
  const startedAt = Date.now();
  const enabled = devRouteEnabled({
    production: isProduction,
    channelProvider: optionalEnv("CHANNEL_PROVIDER"),
    devSecret: optionalEnv("DEV_CHANNEL_SECRET"),
  });
  if (!enabled) return notFound();
  let provider: ChannelProvider;
  try {
    provider = getProvider("dev");
  } catch {
    return notFound();
  }
  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) return Response.json({ error: "too_large" }, { status: 413 });

  // Authenticate (and validate) first; only then touch the DB to map ids.
  let parsed = provider.parseWebhook({ headers: req.headers, rawBody });
  if (parsed.ok) {
    const body: unknown = JSON.parse(rawBody);
    if (body && typeof body === "object" && ("replyToMessageId" in body || "targetMessageId" in body)) {
      const mapped = await mapIds(body as Record<string, unknown>);
      parsed = mapped
        ? provider.parseWebhook({ headers: req.headers, rawBody: JSON.stringify(mapped) })
        : { ok: false, status: 400 };
    }
  }
  return respondToWebhook(provider, parsed, (task) => after(task), startedAt);
}
