import "server-only";
// OWNER: 4.3
/* eslint-disable @typescript-eslint/no-unused-vars -- Wave 0 stub: params unused until 4.3 lands */

/**
 * Inbox triage on connect (master plan §1.12; V2-07 §2.11). Wave 0 stub.
 */
import { notImplemented } from "@/server/_stub";

/**
 * Start a triage run (writes `integrations.gmail_triage`, enqueues the `list` chunk). Called by post-connect (3.6).
 * @param userId owner
 */
export async function startTriage(userId: string): Promise<void> {
  throw notImplemented("4.3");
}
