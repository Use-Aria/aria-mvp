import "server-only";
// OWNER: 2.5

/**
 * `POST /api/google/gmail-push` — Gmail Pub/Sub push endpoint (V2-07 §2.9; AUD-01).
 *
 * Verify the Pub/Sub OIDC token → match `emailAddress` to the one active Google integration →
 * enqueue `gmail_history_sync` → 204, well inside the 30s ack deadline. Nothing from the push is
 * stored; the job reads from the stored cursor. Logic lives in `gmail/push.ts#handleGmailPush`.
 */
import { handleGmailPush } from "@/server/integrations/google/gmail/push";

/**
 * Handle one Pub/Sub push delivery.
 * @param req Pub/Sub push request
 * @returns 204 ack; 401/400 on verification failure; 500 when the enqueue failed
 */
export async function POST(req: Request): Promise<Response> {
  return handleGmailPush(req);
}
