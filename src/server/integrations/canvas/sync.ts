import "server-only";
// OWNER: 3.4
/* eslint-disable @typescript-eslint/no-unused-vars -- Wave 0 stub: params unused until 3.4 lands */

/**
 * Canvas sync (master plan §1.11 = V2-05 §7.2 `sync.ts` verbatim). Wave 0 stub.
 */
import { notImplemented } from "@/server/_stub";
import type { FeedFetchClass, FeedFetchErrorCode } from "@/server/integrations/canvas/fetch-feed";
import type { ParsedCanvasFeed } from "@/server/integrations/canvas/parse";
import type { ApplyResult } from "@/server/timeline/types";
import type { CanvasFeedUrl } from "@/shared/canvas-url";

export type CanvasSyncReason = "scheduled" | "connect" | "manual" | "email_hint";
export type CanvasSyncOutcome =
  | {
      ok: true;
      skipped: "unchanged" | "lease_held" | "disabled" | null;
      initial: boolean;
      result: ApplyResult;
      warnings: ParsedCanvasFeed["warnings"];
    }
  | {
      ok: false;
      code: FeedFetchErrorCode | "parse_error" | "not_canvas" | "no_integration" | "internal";
      cls: FeedFetchClass;
    };

/** Lease → decrypt → fetch → lex → parse → applySnapshot (enqueues the change batch) → schedule next; failure bookkeeping; one-time notices. */
export async function runCanvasSync(
  userId: string,
  opts: { reason: CanvasSyncReason; now?: Date; urlOverride?: CanvasFeedUrl; initial?: boolean },
): Promise<CanvasSyncOutcome> {
  throw notImplemented("3.4");
}
