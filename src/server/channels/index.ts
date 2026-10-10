import "server-only";
// OWNER: 1.2

/**
 * Channels barrel: provider selection, channel context, and re-exports (V2-03 §7).
 *
 * Provider choice: `CHANNEL_PROVIDER` (`sendblue` | `dev`), defaulting to `dev` outside production
 * and `sendblue` in production. `dev` in production throws (cross-claimed dev jobs dead-letter
 * instead of sending). Instances are cached per process, so runtime capability narrowing
 * (Sendblue reactions off after `unsupported_on_this_line`) sticks for the invocation.
 */
import type { Tables } from "@/server/db/types";
import { isProduction, optionalEnv, requireEnv } from "@/server/env";
import { isWindowOpen } from "@/server/channels/guards";
import { staticCapabilities } from "@/server/channels/providers/capabilities";
import { createDevProvider } from "@/server/channels/providers/dev";
import {
  createSendblueProvider,
  parseSigningSecrets,
  SENDBLUE_DEFAULT_BASE,
} from "@/server/channels/providers/sendblue";
import type { ChannelContext, ChannelProvider, ProviderName, Service } from "@/server/channels/types";

export * from "@/server/channels/types";
export { deliver, deliverReply, flushOutbox } from "@/server/channels/deliver";
export type { DeliverOptions, DeliverPriority, DeliverResult } from "@/server/channels/deliver";
export { isAllowedLink, mergeOutboxItems, textPlan, validatePlan } from "@/server/channels/plan";

const cache = new Map<ProviderName, ChannelProvider>();

/**
 * Resolves which provider to use (pure; exported for tests).
 * @param env `CHANNEL_PROVIDER` and whether this is production
 * @param requested explicit name (e.g. `channels.provider` of a row)
 * @returns provider name
 * @throws Error when `dev` is selected in production, or the name is unknown
 */
export function resolveProviderName(
  env: { channelProvider?: string | null; production: boolean },
  requested?: ProviderName | string | null,
): ProviderName {
  const name = (requested ?? env.channelProvider ?? (env.production ? "sendblue" : "dev")).trim().toLowerCase();
  if (name !== "sendblue" && name !== "dev") throw new Error(`Unknown channel provider: ${name}`);
  if (name === "dev" && env.production) throw new Error("The dev channel provider is disabled in production");
  return name;
}

/**
 * Returns the (cached) provider instance.
 * @param name explicit provider; default from `CHANNEL_PROVIDER`
 * @returns the provider
 * @throws Error on `dev` in production, or missing Sendblue credentials
 */
export function getProvider(name?: ProviderName): ChannelProvider {
  const resolved = resolveProviderName(
    { channelProvider: optionalEnv("CHANNEL_PROVIDER"), production: isProduction },
    name,
  );
  const hit = cache.get(resolved);
  if (hit) return hit;
  const provider =
    resolved === "dev"
      ? createDevProvider({ secret: optionalEnv("DEV_CHANNEL_SECRET") ?? null })
      : createSendblueProvider({
          apiKey: requireEnv("SENDBLUE_API_KEY"),
          apiSecret: requireEnv("SENDBLUE_API_SECRET"),
          base: optionalEnv("SENDBLUE_API_BASE") ?? SENDBLUE_DEFAULT_BASE,
          signingSecrets: parseSigningSecrets(optionalEnv("SENDBLUE_SIGNING_SECRET")),
          fromNumber: optionalEnv("SENDBLUE_FROM_NUMBER") ?? null,
        });
  cache.set(resolved, provider);
  return provider;
}

/**
 * Model-safe channel description for a `channels` row (never includes the handle).
 * @param row channel row
 * @param opts clock (window check) and the provider instance to read live capabilities from
 * @returns channel context
 */
export function channelContext(
  row: Tables<"channels">,
  opts: { now?: Date; provider?: ChannelProvider } = {},
): ChannelContext {
  const provider: ProviderName = row.provider === "dev" ? "dev" : "sendblue";
  const kind: ChannelContext["kind"] = row.kind === "sms" || row.kind === "whatsapp" ? row.kind : "imessage";
  const service: Service =
    row.last_service === "sms" || row.last_service === "rcs" || row.last_service === "imessage"
      ? row.last_service
      : kind === "sms"
        ? "sms"
        : "imessage";
  const handleKind: ChannelContext["handleKind"] =
    row.handle_kind === "email" || row.handle_kind === "bsuid" ? row.handle_kind : "phone";
  const live = opts.provider && opts.provider.name === provider ? opts.provider : (cache.get(provider) ?? null);
  const capabilities = live
    ? live.capabilities(service, handleKind)
    : staticCapabilities(provider, service, handleKind);
  const lastInbound = row.last_inbound_at ? new Date(row.last_inbound_at) : null;
  return {
    channelId: row.id,
    provider,
    kind,
    service,
    handleKind,
    capabilities,
    windowOpen: isWindowOpen(lastInbound, opts.now ?? new Date()),
  };
}
