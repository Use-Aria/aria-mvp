import "server-only";
// OWNER: 3.6
/* eslint-disable @typescript-eslint/no-unused-vars -- Wave 0 stub: params unused until 3.6 lands */

/**
 * Google disconnect (master plan §1.12, C21). Wave 0 stub.
 */
import { notImplemented } from "@/server/_stub";

/** Revoke refresh token at Google, stop Gmail watch + calendar channels, delete the
 *  integration row and derived gcal timeline items / email_items. Idempotent. */
export async function disconnectGoogle(userId: string, opts: { reason: "user" | "account_deleted" }): Promise<{ revoked: boolean }> {
  throw notImplemented("3.6");
}
