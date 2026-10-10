import "server-only";
// OWNER: 4.1
/* eslint-disable @typescript-eslint/no-unused-vars -- Wave 0 stub: params unused until 4.1 lands */

/**
 * Timeline change handler (master plan §1.14; V2-06 §2.8): nudge bookkeeping for every change,
 * immediate alerts or briefing notes per `deliveryHint`. Called by the `timeline_changes` job and
 * synchronously by timeline status changes (lazy import in `timeline/hooks.ts`). Wave 0 stub.
 */
import { notImplemented } from "@/server/_stub";
import type { TimelineChangeBatch } from "@/server/timeline/types";

/**
 * Process one change batch. Idempotent (at-least-once delivery).
 * @param userId owner of the changed items
 * @param batch change batch (titles/courses are untrusted)
 * @param now clock
 * @returns how many alerts were sent and briefing notes written
 */
export async function handleTimelineChanges(
  userId: string,
  batch: TimelineChangeBatch,
  now: Date,
): Promise<{ alerted: number; noted: number }> {
  throw notImplemented("4.1");
}
