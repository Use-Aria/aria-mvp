import "server-only";
// OWNER: 4.3
/* eslint-disable @typescript-eslint/no-unused-vars -- Wave 0 stub: params unused until 4.3 lands */

/**
 * Email classification entry point for Gmail ingest (master plan §1.12). Wave 0 stub returns [].
 */
import type { ClassifiedEmail, EmailMeta, PrefilterHint } from "@/server/integrations/google/gmail/types";

/**
 * Classify prefiltered emails (Haiku `classify` route; content wrapped as untrusted) and persist results.
 * @param userId owner
 * @param items email_items ids with metadata and prefilter hint
 * @returns classifications (Wave 0: none)
 */
export async function classifyIngested(
  userId: string,
  items: { id: string; meta: EmailMeta; hint: PrefilterHint }[],
): Promise<ClassifiedEmail[]> {
  return [];
}
