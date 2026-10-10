import "server-only";
// OWNER: 2.4

/**
 * Google status read model for /setup, /settings and the agent context (master plan §1.12, C21).
 * Never exposes tokens. `toStatusView` is pure (unit-tested); `getGoogleStatus` adds the DB read.
 */
import type { GoogleStatusView } from "@/server/integrations/google";
import { featureList } from "@/server/integrations/google/config";
import { getGoogleIntegration, type GoogleIntegration } from "@/server/integrations/google/store";

/**
 * Map an integration row to the public view. Pure.
 * - no row / `disconnected` → `{connected:false, reason:"none"}`
 * - `revoked` → `reason:"revoked"`; `error` (or any unknown status) → `reason:"error"`
 * - `active` → connected, with features from the granted scopes and the triage progress
 * @param row the user's Google row, or null
 * @returns status view
 */
export function toStatusView(row: GoogleIntegration | null): GoogleStatusView {
  if (!row || row.status === "disconnected") return { connected: false, reason: "none" };
  if (row.status === "revoked") return { connected: false, reason: "revoked" };
  if (row.status !== "active") return { connected: false, reason: "error" };

  const features = featureList(row.scopes ?? []);
  const view: GoogleStatusView = {
    connected: true,
    email: row.account_email ?? "",
    features,
    canReadMail: features.includes("gmail_read"),
    canSendMail: features.includes("gmail_send"),
    canReadCalendar: features.includes("calendar_read"),
    canWriteAriaCalendar: features.includes("calendar_write"),
    connectedAt: new Date(row.connected_at ?? row.created_at),
  };
  const triage = triageView(row.gmail_triage);
  if (triage) view.triage = triage;
  return view;
}

/** `gmail_triage` jsonb `{run_id, started_at, total, …, completed_at}` → `{running, total?}`. */
function triageView(raw: GoogleIntegration["gmail_triage"]): { running: boolean; total?: number } | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const started = typeof raw.started_at === "string" && raw.started_at.length > 0;
  if (!started) return undefined;
  const completed = typeof raw.completed_at === "string" && raw.completed_at.length > 0;
  const out: { running: boolean; total?: number } = { running: !completed };
  if (typeof raw.total === "number" && Number.isFinite(raw.total)) out.total = raw.total;
  return out;
}

/**
 * Current Google connection status.
 * @param userId owner
 * @returns status view (§1.12 `GoogleStatusView`)
 * @throws on a DB error (callers such as `/setup` fall back to "not connected")
 */
export async function getGoogleStatus(userId: string): Promise<GoogleStatusView> {
  return toStatusView(await getGoogleIntegration(userId));
}
