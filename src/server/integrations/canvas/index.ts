import "server-only";
// OWNER: 0.2 (frozen barrel; only the orchestrator edits this file — master plan §1.0.2)

/** Canvas integration public surface (master plan §1.11). */
export {
  connectCanvas,
  disconnectCanvas,
  getCanvasStatus,
  requestCanvasSync,
} from "@/server/integrations/canvas/connect";
export type { CanvasConnectError, ConnectResult, CanvasStatusView } from "@/server/integrations/canvas/connect";
export { runCanvasSync } from "@/server/integrations/canvas/sync";
export type { CanvasSyncOutcome, CanvasSyncReason } from "@/server/integrations/canvas/sync";
