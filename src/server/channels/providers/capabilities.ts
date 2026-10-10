import "server-only";
// OWNER: 1.2

/**
 * Static channel capabilities per provider and transport (no instance state). Provider instances
 * may narrow these at runtime (Sendblue disables reactions after `unsupported_on_this_line`).
 */
import { PIPELINE } from "@/server/pipeline/config";
import type { ChannelCapabilities, ProviderName, Service } from "@/server/channels/types";

/**
 * Capabilities before any runtime narrowing.
 * - iMessage: tapbacks, typing, inline replies ([verify] the sandbox line is a "V2 line"), media
 * - SMS / RCS: media only (reactions → fallback text, replies → quote prefix, no typing)
 * - email handles: same as iMessage; typing/reactions there are [verify] and failures are tolerated
 * @param provider provider name
 * @param service transport
 * @param handleKind handle kind
 * @returns capabilities
 */
export function staticCapabilities(
  provider: ProviderName,
  service: Service,
  handleKind: "phone" | "email" | "bsuid",
): ChannelCapabilities {
  void provider;
  void handleKind;
  const maxBubbleChars = PIPELINE.maxBubbleChars;
  if (service === "imessage") {
    return { reactions: true, typing: true, inlineReplies: true, media: true, maxBubbleChars };
  }
  return { reactions: false, typing: false, inlineReplies: false, media: true, maxBubbleChars };
}
