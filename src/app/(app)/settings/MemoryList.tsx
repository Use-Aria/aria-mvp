"use client";

/**
 * "What Aria knows about you" rows (web plan §7.6, copy deck §9.4). Each row: text, "Edit"
 * (inline textarea, only with a < 60 min session), "Delete" (confirm in place). Suggestions get
 * "Keep it" (recent sessions only) and "Don't keep". The server re-checks every rule; this only
 * hides buttons that would be refused. Text arrives already cleaned by the DAL.
 */
import { useState, useTransition, type ReactNode } from "react";
import { buttonClass } from "@/app/_components/ui/Button";
import { FIELD_CONTROL_CLASS } from "@/app/_components/ui/Field";
import type { ActionErrorCode, ActionResult } from "@/shared/action-result";
import { SETTINGS_COPY, SHARED_COPY, actionErrorCopy } from "@/shared/copy";
import {
  answerProposalAction,
  deleteFactAction,
  editFactAction,
  editPreferenceAction,
  removePreferenceAction,
} from "./actions";

const COPY = SETTINGS_COPY.memory;

/** One row as the page passes it (mirrors `SettingsMemoryRow`). */
export interface MemoryRowView {
  id: string;
  text: string;
  savedLabel?: string;
}

/** Props: the three lists and whether edits are allowed. */
export interface MemoryListProps {
  memory: { preferences: MemoryRowView[]; proposed: MemoryRowView[]; facts: MemoryRowView[] };
  isRecent: boolean;
}

function errorText(code: ActionErrorCode): string {
  return code === "needs_recent_link" ? COPY.editNeedsRecent : actionErrorCopy(code);
}

function useRowAction(): {
  pending: boolean;
  error: string | null;
  setError: (e: string | null) => void;
  run: (fn: () => Promise<ActionResult>, onOk?: () => void) => void;
} {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<ActionResult>, onOk?: () => void) => {
    setError(null);
    start(async () => {
      try {
        const r = await fn();
        if (r.ok) onOk?.();
        else setError(errorText(r.code));
      } catch {
        setError(actionErrorCopy("server"));
      }
    });
  };
  return { pending, error, setError, run };
}

function RowError({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p role="alert" className="text-sm text-danger">
      {text}
    </p>
  );
}

/** A preference or fact: view / edit / confirm-delete in place. */
function EditableRow({
  row,
  kind,
  isRecent,
}: {
  row: MemoryRowView;
  kind: "preference" | "fact";
  isRecent: boolean;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "confirm">("view");
  const [draft, setDraft] = useState(row.text);
  const { pending, error, setError, run } = useRowAction();
  const max = kind === "preference" ? 280 : 500;
  const fieldId = `edit-${row.id}`;

  const save = () => {
    const text = draft.trim();
    if (!text) return setError(COPY.editEmpty);
    if (text.length > max) return setError(COPY.editTooLong);
    run(
      () => (kind === "preference" ? editPreferenceAction(row.id, text) : editFactAction(row.id, text)),
      () => setMode("view"),
    );
  };
  const remove = () => run(() => (kind === "preference" ? removePreferenceAction(row.id) : deleteFactAction(row.id)));

  return (
    <li className="flex flex-col gap-2 border-b border-line py-3 last:border-b-0">
      {mode === "edit" ? (
        <>
          <label htmlFor={fieldId} className="sr-only">
            {COPY.edit}
          </label>
          <textarea
            id={fieldId}
            value={draft}
            maxLength={max}
            rows={3}
            onChange={(e) => setDraft(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${fieldId}-error` : undefined}
            className={`${FIELD_CONTROL_CLASS} resize-y`}
          />
          <div className="flex flex-wrap gap-3">
            <button type="button" className={buttonClass("primary")} disabled={pending} onClick={save}>
              {pending ? SHARED_COPY.saving : "Save"}
            </button>
            <button
              type="button"
              className={buttonClass("secondary")}
              disabled={pending}
              onClick={() => {
                setDraft(row.text);
                setError(null);
                setMode("view");
              }}
            >
              {COPY.deleteConfirm.cancel}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="break-words text-base leading-relaxed">
            {kind === "preference" ? <>&ldquo;{row.text}&rdquo;</> : row.text}
            {row.savedLabel && <span className="text-ink-soft"> · {COPY.savedOn(row.savedLabel)}</span>}
          </p>
          {mode === "confirm" ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-base">{COPY.deleteConfirm.title}</p>
              <button type="button" className={buttonClass("danger")} disabled={pending} onClick={remove}>
                {pending ? "Deleting…" : COPY.deleteConfirm.confirm}
              </button>
              <button type="button" className={buttonClass("secondary")} disabled={pending} onClick={() => setMode("view")}>
                {COPY.deleteConfirm.cancel}
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-4">
              {isRecent && (
                <button type="button" className={buttonClass("ghost")} onClick={() => setMode("edit")}>
                  {COPY.edit}
                </button>
              )}
              <button type="button" className={buttonClass("ghost")} onClick={() => setMode("confirm")}>
                {COPY.delete}
              </button>
            </div>
          )}
        </>
      )}
      <div id={`${fieldId}-error`}>
        <RowError text={error} />
      </div>
    </li>
  );
}

/** One of Aria's suggestions: "Keep it" / "Don't keep". */
function ProposalRow({ row, isRecent }: { row: MemoryRowView; isRecent: boolean }) {
  const { pending, error, run } = useRowAction();
  return (
    <li className="flex flex-col gap-2 border-b border-line py-3 last:border-b-0">
      <p className="break-words text-base leading-relaxed">&ldquo;{row.text}&rdquo;</p>
      <div className="flex flex-wrap gap-3">
        {isRecent && (
          <button
            type="button"
            className={buttonClass("primary")}
            disabled={pending}
            onClick={() => run(() => answerProposalAction(row.id, true))}
          >
            {COPY.keep}
          </button>
        )}
        <button
          type="button"
          className={buttonClass("secondary")}
          disabled={pending}
          onClick={() => run(() => answerProposalAction(row.id, false))}
        >
          {COPY.dontKeep}
        </button>
      </div>
      <RowError text={error} />
    </li>
  );
}

function Group({ id, title, hint, children }: { id: string; title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1" role="group" aria-labelledby={id}>
      <h3 id={id} className="text-lg font-semibold">
        {title}
      </h3>
      {hint && <p className="text-sm text-ink-soft">{hint}</p>}
      <ul className="flex flex-col">{children}</ul>
    </div>
  );
}

/**
 * @param props memory rows and whether the session may edit
 * @returns the preference, suggestion, and fact groups (each only when non-empty)
 */
export function MemoryList({ memory, isRecent }: MemoryListProps) {
  return (
    <div className="flex flex-col gap-6">
      {memory.preferences.length > 0 && (
        <Group id="memory-preferences" title={COPY.preferencesTitle}>
          {memory.preferences.map((p) => (
            <EditableRow key={p.id} row={p} kind="preference" isRecent={isRecent} />
          ))}
        </Group>
      )}
      {memory.proposed.length > 0 && (
        <Group id="memory-proposed" title={COPY.proposedTitle} hint={COPY.proposedHint}>
          {memory.proposed.map((p) => (
            <ProposalRow key={p.id} row={p} isRecent={isRecent} />
          ))}
        </Group>
      )}
      {memory.facts.length > 0 && (
        <Group id="memory-facts" title={COPY.factsTitle}>
          {memory.facts.map((f) => (
            <EditableRow key={f.id} row={f} kind="fact" isRecent={isRecent} />
          ))}
        </Group>
      )}
    </div>
  );
}
