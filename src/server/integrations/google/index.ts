import "server-only";
// OWNER: 0.2 (frozen barrel; only the orchestrator edits this file — master plan §1.0.2)

/** Google integration public surface (master plan §1.12, conflicts C20/C21). */

export type GoogleFeature = "calendar_read" | "calendar_write" | "gmail_read" | "gmail_send";
export type GoogleConnectStatus =
  | "connected"
  | "missing_scopes"
  | "denied"
  | "admin_blocked"
  | "stale"
  | "expired"
  | "account_in_use"
  | "error";
export type GoogleStatusView =
  /** revoked/error → web shows "needs reconnect" */
  | { connected: false; reason: "none" | "revoked" | "error" }
  | {
      connected: true;
      email: string;
      features: GoogleFeature[];
      canReadMail: boolean;
      canSendMail: boolean;
      canReadCalendar: boolean;
      canWriteAriaCalendar: boolean;
      connectedAt: Date;
      triage?: { running: boolean; total?: number };
    };
export { getGoogleStatus } from "./status"; // 2.4
export { disconnectGoogle } from "./disconnect"; // 3.6: (userId, {reason: "user"|"account_deleted"}) => Promise<{revoked: boolean}>
export { listEmailItemsForBriefing, markEmailItemsSurfaced } from "./gmail/alerts"; // 4.3 (V2-07 §7.3)
export { readBusy } from "./calendar/busy"; // 4.2
