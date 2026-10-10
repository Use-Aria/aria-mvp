import "server-only";
// OWNER: 3.6

/**
 * Job kind `google_post_connect` (master plan §1.3; V2-07 §2.11, §9.1). Enqueued by
 * `/api/google/callback` after `completeConnect` writes the row. Steps, each safe to repeat:
 *
 * 1. Ack bubble via `deliver(…, {proactive:false, reason:"google_connected"})`: the user just
 *    connected, so it's a direct follow-up. Idempotent per connection (dedupe key carries the
 *    integration id + `connected_at`).
 * 2. Calendar list + window sync (`syncCalendarWindow("connect")`). A transient failure here
 *    doesn't hold up Gmail: it's handed to a separate `gcal_sync` job.
 * 3. Calendar push channel (`startCalendarWatch`; schedules `gcal_watch_renew` + the periodic sync).
 *    A non-retryable refusal falls back to periodic polling.
 * 4. Gmail (if granted): `startGmailWatch` only — it already schedules the watch renew and the
 *    periodic history sync.
 * 5. Inbox triage (if Gmail is granted): `startTriage` (task 4.3). A permanent failure there
 *    (incl. the Wave 0 stub) is logged and doesn't fail the job: triage can't be retried by
 *    re-running everything above.
 *
 * Revoked refresh token anywhere → dead (the token layer already marked the integration).
 */
import { z } from "zod";
import { deliver } from "@/server/channels/deliver";
import { textPlan } from "@/server/channels/plan";
import { defineJobKind, PermanentJobError } from "@/server/jobs/types";
import { featuresFor } from "@/server/integrations/google/config";
import { GoogleApiError, GoogleAuthRevokedError, GoogleNotConnectedError } from "@/server/integrations/google/errors";
import { startGmailWatch } from "@/server/integrations/google/gmail/sync";
import { startTriage } from "@/server/integrations/google/gmail/triage";
import { getGoogleIntegration, type GoogleIntegration } from "@/server/integrations/google/store";
import { markGoogleUnavailable } from "@/server/integrations/google/tokens";
import { ensurePeriodicCalendarSync, requestCalendarSync, syncCalendarWindow } from "@/server/integrations/google/calendar/sync";
import { startCalendarWatch } from "@/server/integrations/google/calendar/watch";

/** Payload of `google_post_connect`. Dedupe key: `google_post_connect:<userId>`. */
export const googlePostConnectPayload = z.object({});

/** Ack bubbles (templates, register-neutral). */
export const GOOGLE_CONNECTED_ACK: Readonly<{ withGmail: readonly string[]; calendarOnly: readonly string[] }> = {
  withGmail: ["google's connected ✅ i can see your calendar now", "going through your inbox too, give me a few min"],
  calendarOnly: ["google's connected ✅ i can see your calendar now"],
};

/** Retry delay for a connect-time calendar sync that failed transiently. */
const CONNECT_SYNC_RETRY_MS = 60_000;

/**
 * The connection-scoped dedupe key for the ack (a reconnect gets a new one).
 * @param row the integration
 * @returns dedupe key
 */
export function connectAckKey(row: Pick<GoogleIntegration, "id" | "connected_at">): string {
  const ms = row.connected_at ? new Date(row.connected_at).getTime() : 0;
  return `google_connected:${row.id}:${ms}`;
}

async function sendAck(userId: string, row: GoogleIntegration, gmail: boolean): Promise<void> {
  const texts = gmail ? GOOGLE_CONNECTED_ACK.withGmail : GOOGLE_CONNECTED_ACK.calendarOnly;
  const res = await deliver(userId, textPlan([...texts]), { proactive: false, reason: "google_connected", dedupeKey: connectAckKey(row) });
  if (res.status === "failed") console.warn(`[google] connect ack failed user=${userId}: ${res.error}`);
}

/** Calendar sync at connect; transient failures move to their own `gcal_sync` job. */
async function connectCalendarSync(userId: string): Promise<void> {
  try {
    await syncCalendarWindow(userId, "connect");
  } catch (e) {
    if (e instanceof GoogleAuthRevokedError || e instanceof GoogleNotConnectedError) throw e;
    console.warn(`[google] connect calendar sync failed user=${userId}: ${e instanceof Error ? e.message : "error"}; retrying as gcal_sync`);
    await requestCalendarSync(userId, "connect", CONNECT_SYNC_RETRY_MS);
  }
}

/** Push channel; a non-retryable refusal (bad address, unsupported) falls back to polling. */
async function connectCalendarWatch(userId: string): Promise<void> {
  try {
    await startCalendarWatch(userId);
  } catch (e) {
    if (e instanceof GoogleApiError && !e.retryable) {
      console.warn(`[google] calendar watch refused user=${userId}: ${e.message}; polling instead`);
      await ensurePeriodicCalendarSync(userId, new Date());
      return;
    }
    throw e;
  }
}

/** `google_post_connect` handler (maxAttempts 3). */
export const googlePostConnect = defineJobKind({
  payload: googlePostConnectPayload,
  maxAttempts: 3,
  run: async (ctx) => {
    const userId = ctx.userId;
    if (!userId) throw new PermanentJobError("google_post_connect: job has no user");
    const row = await getGoogleIntegration(userId);
    if (!row || row.status !== "active") return { type: "done" };
    const features = featuresFor(row.scopes ?? []);
    const gmail = features.has("gmail_read");

    try {
      await sendAck(userId, row, gmail);
      if (features.has("calendar_read")) {
        await connectCalendarSync(userId);
        await connectCalendarWatch(userId);
      }
      if (gmail) await startGmailWatch(userId);
    } catch (e) {
      if (e instanceof GoogleNotConnectedError) return { type: "done" };
      if (e instanceof GoogleAuthRevokedError) {
        if (row.enc_refresh_token) await markGoogleUnavailable(userId, e.kind, { expectEncRefreshToken: row.enc_refresh_token });
        throw new PermanentJobError(`google_post_connect: google auth revoked (${e.kind})`);
      }
      throw e;
    }

    if (gmail) {
      try {
        await startTriage(userId);
      } catch (e) {
        if (!(e instanceof PermanentJobError)) throw e;
        console.warn(`[google] triage not started user=${userId}: ${e.message}`);
      }
    }
    console.info(`[google] post-connect done user=${userId} gmail=${gmail}`);
    return { type: "done" };
  },
});
