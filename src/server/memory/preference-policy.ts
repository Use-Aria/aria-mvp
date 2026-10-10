import "server-only";
// OWNER: 2.2

/**
 * Preference lifecycle decisions + rendering (V2-04 §2.7, §2.8). Pure.
 *
 * Lifecycle: proposed → active → superseded (or rejected / queued / expired). An explicit
 * "remember: …" saves at once only when the user's own message in this batch asked for it and
 * the run hasn't read untrusted content yet; everything else asks first, at most one question
 * per conversation.
 */
import { BUDGET, PREFS_MAX_ROWS } from "@/server/agent/config";
import { clampLines } from "@/server/agent/context/budget";
import type { AliasTable } from "@/server/agent/types";
import { neutralizeTags } from "@/server/agent/untrusted";
import type { PreferenceRow } from "@/server/memory/preferences";

/** What to do with a new preference proposal. */
export type ProposalDecision = "activate" | "ask" | "queue" | "reject_no_evidence";

/** Inputs to `decideProposal`. */
export interface ProposalState {
  /** a preference question was already asked in the current conversation */
  openQuestionInConversation: boolean;
  /** the user explicitly said to remember it ("remember: …") */
  explicit: boolean;
  /** the run has read untrusted content (email, Canvas, calendar, syllabus) */
  tainted: boolean;
  /** the evidence alias is a user-authored message of this run's batch */
  evidenceInBatch: boolean;
}

/**
 * Lifecycle decision for a proposal.
 * - no batch evidence → `reject_no_evidence` (memories come only from the user's own words)
 * - explicit + untainted → `activate` (save now, source 'explicit')
 * - a question was already asked this conversation → `queue` (ask later, e.g. in a briefing)
 * - otherwise → `ask` (insert as the one open `proposed` question)
 * @param s proposal state
 * @returns the decision
 */
export function decideProposal(s: ProposalState): ProposalDecision {
  if (!s.evidenceInBatch) return "reject_no_evidence";
  if (s.explicit && !s.tainted) return "activate";
  if (s.openQuestionInConversation) return "queue";
  return "ask";
}

const MAX_STATEMENT = 200;

function categoryOf(r: PreferenceRow): string {
  return r.category ?? "other";
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Sort preferences for rendering: category, then key, then id (total order → stable bytes).
 * @param rows preference rows
 * @returns a sorted copy
 */
export function sortPreferences(rows: readonly PreferenceRow[]): PreferenceRow[] {
  return [...rows].sort((a, b) => cmp(categoryOf(a), categoryOf(b)) || cmp(a.key, b.key) || cmp(a.id, b.id));
}

/**
 * Render active preferences for a prompt: ≤30 rows, ≤600 tokens, sorted by category then key.
 * With an alias table each line carries its `p_` alias (so `forget` can reference it).
 * @param rows active preference rows (any order)
 * @param opts.aliases alias table to mint `p_` aliases in (omit for briefing prompts)
 * @returns newline-joined lines, "" when there are none
 */
export function renderPreferences(rows: readonly PreferenceRow[], opts?: { aliases?: AliasTable }): string {
  const lines = sortPreferences(rows)
    .slice(0, PREFS_MAX_ROWS)
    .map((r) => {
      const statement = neutralizeTags(r.statement.replace(/\s+/g, " ").trim());
      const text = statement.length > MAX_STATEMENT ? `${statement.slice(0, MAX_STATEMENT - 1)}…` : statement;
      const head = opts?.aliases ? `[${opts.aliases.mint("p", r.id)}]` : "-";
      return `${head} ${categoryOf(r)} · ${r.key}: ${text}`;
    });
  return clampLines(lines, BUDGET.prefs).join("\n");
}
