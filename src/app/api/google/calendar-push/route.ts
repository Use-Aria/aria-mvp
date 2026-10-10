import "server-only";
// OWNER: 3.6
/**
 * `POST /api/google/calendar-push` — Google Calendar push notifications (V2-07 §2.6; AUD-02).
 *
 * Google sends `X-Goog-Channel-ID`, `X-Goog-Channel-Token`, `X-Goog-Resource-ID` and
 * `X-Goog-Resource-State` (no event data). The channel is looked up by id, the token hash and
 * resource id are checked, and a verified `exists` ping enqueues one debounced `gcal_sync`
 * (+20s). Every outcome answers 200 so Google never retries a dead or forged channel; the
 * periodic sync covers anything missed. Logic lives in `calendar/watch.ts#handleCalendarPush`.
 */
import { handleCalendarPush } from "@/server/integrations/google/calendar/watch";

/**
 * Handle one calendar push notification.
 * @param req Google's push request (headers only)
 * @returns 200, always
 */
export async function POST(req: Request): Promise<Response> {
  try {
    await handleCalendarPush(req.headers);
  } catch (e) {
    console.error(`[gcal] push handling failed: ${e instanceof Error ? e.message : "error"}`);
  }
  return new Response(null, { status: 200 });
}
