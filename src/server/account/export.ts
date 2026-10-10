import "server-only";
// OWNER: 4.6
/* eslint-disable @typescript-eslint/no-unused-vars -- Wave 0 stub: params unused until 4.6 lands */

/**
 * Account export (master plan §1.16; web §7.6). Wave 0 stub; only 4.6 consumes `AccountExport`,
 * so 4.6 may refine its shape.
 */
import { notImplemented } from "@/server/_stub";
import type { JsonValue } from "@/server/timeline/types";

/** JSON export (version 1): included tables → rows, secrets and internal tables excluded. */
export interface AccountExport {
  version: 1;
  exportedAt: string;
  tables: Record<string, Array<Record<string, JsonValue>>>;
}

/**
 * Collect a user's exportable rows (paged by 1,000).
 * @param userId owner
 * @returns the export document
 */
export async function collectAccountExport(userId: string): Promise<AccountExport> {
  throw notImplemented("4.6");
}
