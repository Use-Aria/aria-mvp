import "server-only";
// OWNER: 0.2 (frozen contract; only the orchestrator edits this file — master plan §1.0.2)

/**
 * Agent tool registry (master plan §1.4). Deterministic order — it is part of the cached prompt
 * prefix, so never reorder; the registry test pins names and order.
 */
import type { AgentTool } from "@/server/agent/tools/define";
import { sendInterimTool } from "@/server/agent/tools/send-interim"; // 3.3
import { sendLinkTool } from "@/server/agent/tools/send-link"; // 3.3
import { getAgendaTool } from "@/server/agent/tools/get-agenda"; // 3.3
import { searchDeadlinesTool } from "@/server/agent/tools/search-deadlines"; // 3.3
import { markDoneTool } from "@/server/agent/tools/mark-done"; // 3.3
import { connectCanvasTool } from "@/server/agent/tools/connect-canvas"; // 3.4
import { canvasStatusTool } from "@/server/agent/tools/canvas-status"; // 3.4
import { createReminderTool } from "@/server/agent/tools/create-reminder"; // 2.6
import { listRemindersTool } from "@/server/agent/tools/list-reminders"; // 2.6
import { cancelReminderTool } from "@/server/agent/tools/cancel-reminder"; // 2.6
import { updateNotificationSettingsTool } from "@/server/agent/tools/update-notification-settings"; // 2.6
import { findFreeSlotsTool } from "@/server/agent/tools/find-free-slots"; // 4.2
import { createBlockTool } from "@/server/agent/tools/create-block"; // 4.2
import { moveBlockTool } from "@/server/agent/tools/move-block"; // 4.2
import { deleteBlockTool } from "@/server/agent/tools/delete-block"; // 4.2
import { searchEmailTool } from "@/server/agent/tools/search-email"; // 4.3
import { readEmailTool } from "@/server/agent/tools/read-email"; // 4.3
import { draftEmailTool } from "@/server/agent/tools/draft-email"; // 4.3
import { readSyllabusTool } from "@/server/agent/tools/read-syllabus"; // 3.5
import { syllabusInfoTool } from "@/server/agent/tools/syllabus-info"; // 3.5
import { recallTool } from "@/server/agent/tools/recall"; // 3.3
import { listMemoryTool } from "@/server/agent/tools/list-memory"; // 3.3
import { proposePreferenceTool } from "@/server/agent/tools/propose-preference"; // 3.3
import { confirmPreferenceTool } from "@/server/agent/tools/confirm-preference"; // 3.3
import { forgetTool } from "@/server/agent/tools/forget"; // 3.3
import { updateProfileTool } from "@/server/agent/tools/update-profile"; // 3.3
import { confirmActionTool } from "@/server/agent/tools/confirm-action"; // 3.3
import { cancelActionTool } from "@/server/agent/tools/cancel-action"; // 3.3
import { pauseTool } from "@/server/agent/tools/pause"; // 3.3
import { signOutEverywhereTool } from "@/server/agent/tools/sign-out-everywhere"; // 3.3
import { requestAccountDeletionTool } from "@/server/agent/tools/request-account-deletion"; // 3.3

/** Every agent tool, in registry order (§1.4 table). */
export const TOOLS: readonly AgentTool[] = [
  sendInterimTool,
  sendLinkTool,
  getAgendaTool,
  searchDeadlinesTool,
  markDoneTool,
  connectCanvasTool,
  canvasStatusTool,
  createReminderTool,
  listRemindersTool,
  cancelReminderTool,
  updateNotificationSettingsTool,
  findFreeSlotsTool,
  createBlockTool,
  moveBlockTool,
  deleteBlockTool,
  searchEmailTool,
  readEmailTool,
  draftEmailTool,
  readSyllabusTool,
  syllabusInfoTool,
  recallTool,
  listMemoryTool,
  proposePreferenceTool,
  confirmPreferenceTool,
  forgetTool,
  updateProfileTool,
  confirmActionTool,
  cancelActionTool,
  pauseTool,
  signOutEverywhereTool,
  requestAccountDeletionTool,
];
