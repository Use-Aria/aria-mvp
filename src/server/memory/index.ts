import "server-only";
// OWNER: 2.2 (extraction/summary: 3.3)

/**
 * Memory API barrel (master plan §1.7 + web §8 memory shapes). Profile, preferences (propose →
 * confirm via `decide_preference`), facts (FTS recall, hard delete), and the /settings web API.
 * Extraction and the rolling summary (task 3.3) live in `extraction.ts` / `summary.ts`.
 */
export { renderProfileBlock, refreshProfileBlock, loadProfileBlock, getProfile, parseCourses, parseClassTimes } from "@/server/memory/profile";
export type { ClassTime } from "@/server/memory/profile";
export {
  listActivePreferences,
  getOpenQuestion,
  listQueuedProposals,
  insertProposal,
  saveExplicitPreference,
  decidePreference,
  retirePreferences,
  expireStaleQuestions,
  toPreferenceRow,
  PreferenceNotOpenError,
} from "@/server/memory/preferences";
export type { PreferenceRow, OpenQuestionRow } from "@/server/memory/preferences";
export { decideProposal, renderPreferences, sortPreferences } from "@/server/memory/preference-policy";
export type { ProposalDecision, ProposalState } from "@/server/memory/preference-policy";
export { conversationStartedAt, askedInCurrentConversation } from "@/server/memory/conversation";
export { recallFacts, listRecentFacts, insertFact, updateFact, deleteFacts } from "@/server/memory/facts";
export type { RecalledFact, FactRow, FactCategory, FactSource } from "@/server/memory/facts";
export { listMemory, editPreference, removePreference, answerProposal, editFact, deleteFact, setProfileSchool } from "@/server/memory/web";
export type { MemoryView } from "@/server/memory/web";
