import "server-only";
// OWNER: 4.3
/* eslint-disable @typescript-eslint/no-unused-vars -- Wave 0 stub: params unused until 4.3 lands */

/**
 * High-importance email alerts + briefing accessors (master plan §1.12; V2-07 §7.3 `gmail/alerts.ts`).
 * Wave 0 stub: a no-op for empty input (the `classifyIngested` stub yields none), throws otherwise.
 */
import { notImplemented } from "@/server/_stub";
import type { BriefingEmailItem, ClassifiedEmail } from "@/server/integrations/google/gmail/types";

/**
 * Claim and send template alerts for high-importance push emails.
 * @param userId owner
 * @param items classified emails from one ingest
 * @returns alerts sent
 */
export async function alertHighImportance(userId: string, items: ClassifiedEmail[]): Promise<number> {
  if (items.length === 0) return 0;
  throw notImplemented("4.3");
}

/**
 * High/medium email items not yet surfaced, for the briefing (V2-06).
 * @param userId owner
 * @param since earliest received time
 * @returns briefing items (Wave 0: none)
 */
export async function listEmailItemsForBriefing(userId: string, since: Date): Promise<BriefingEmailItem[]> {
  return [];
}

/**
 * Mark email items as included in a briefing/digest.
 * @param ids email_items ids
 */
export async function markEmailItemsSurfaced(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  throw notImplemented("4.3");
}
