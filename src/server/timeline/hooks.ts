import "server-only";
// OWNER: 2.3

/**
 * Synchronous status-change subscribers (master plan §1.9; V2-05 §7.3 `hooks.ts`).
 * Pre-wired in Wave 0 to a LAZY import of `handleTimelineChanges`, which avoids the
 * timeline → alerts → timeline import cycle.
 */
import type { TimelineChangeBatch } from "@/server/timeline/types";

export type TimelineChangeSubscriber = (userId: string, batch: TimelineChangeBatch, now: Date) => Promise<void>;

/** Synchronous subscribers for status changes (V2-06's `handleTimelineChanges`). */
export const TIMELINE_STATUS_SUBSCRIBERS: readonly TimelineChangeSubscriber[] = [
  async (u, b, n) => {
    await (await import("@/server/alerts/timeline-changes")).handleTimelineChanges(u, b, n);
  },
];

/**
 * Run every subscriber; log errors (no bodies), never throw.
 * @param userId owner of the changed items
 * @param batch the status-change batch
 * @param now clock
 */
export async function notifyStatusSubscribers(userId: string, batch: TimelineChangeBatch, now: Date): Promise<void> {
  for (const subscriber of TIMELINE_STATUS_SUBSCRIBERS) {
    try {
      await subscriber(userId, batch, now);
    } catch (err) {
      // Error name only: messages may carry third-party titles.
      const name = err instanceof Error ? err.name : "unknown";
      console.error(`[timeline] status subscriber failed: ${name} (changes=${batch.changes.length})`);
    }
  }
}
