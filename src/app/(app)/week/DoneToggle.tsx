"use client";
/**
 * Mark-done toggle for one deadline (web plan §2.5, §7.5). OWNER: 4.4.
 * Optimistic (`useOptimistic` inside a transition): the row strikes through on the tap, then
 * the server action's `refresh()` reconciles. The server toggle is idempotent, so a double tap
 * is harmless. The row content (server-rendered) is passed as children and styled through
 * `data-done` on the wrapper.
 */
import { useOptimistic, useState, useTransition, type ReactNode } from "react";
import { actionErrorCopy, SHARED_COPY, WEEK_COPY } from "@/shared/copy";
import type { ActionErrorCode } from "@/shared/action-result";
import { setItemStatusAction } from "./actions";

/** Codes that mean "the save itself failed" (shown as the generic mark-done error). */
const GENERIC: ReadonlySet<ActionErrorCode> = new Set(["server", "invalid", "not_found"]);

/**
 * @param props timeline item id, its (untrusted, already cleaned) title for the accessible
 *   label, whether it is done, and the row content
 * @returns the toggle plus row
 */
export function DoneToggle({
  itemId,
  title,
  done,
  children,
}: {
  itemId: string;
  title: string;
  done: boolean;
  children?: ReactNode;
}) {
  const [optimisticDone, setOptimisticDone] = useOptimistic(done);
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggle() {
    const next = !optimisticDone;
    setError(null);
    startTransition(async () => {
      setOptimisticDone(next);
      try {
        const res = await setItemStatusAction(itemId, next);
        if (!res.ok) setError(GENERIC.has(res.code) ? WEEK_COPY.markDoneError : actionErrorCopy(res.code));
      } catch {
        setError(SHARED_COPY.offline);
      }
    });
  }

  const label = optimisticDone ? WEEK_COPY.markNotDone(title) : WEEK_COPY.markDone(title);
  return (
    <div data-done={optimisticDone ? "true" : "false"} className="group flex flex-col gap-1">
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={toggle}
          aria-pressed={optimisticDone}
          aria-label={label}
          className="-ml-2 inline-flex size-11 shrink-0 items-center justify-center rounded-full"
        >
          <span
            aria-hidden="true"
            className={`flex size-6 items-center justify-center rounded-full border-2 text-sm font-bold motion-safe:transition-colors motion-safe:duration-150 ${
              optimisticDone ? "border-aria bg-aria text-aria-ink" : "border-field"
            }`}
          >
            {optimisticDone ? "✓" : ""}
          </span>
        </button>
        <div className="min-w-0 flex-1 pt-2.5">
          {children}
          {optimisticDone && (
            <p className="mt-1 text-sm text-ink-soft">
              {WEEK_COPY.done} ·{" "}
              <button
                type="button"
                onClick={toggle}
                aria-label={label}
                className="min-h-11 px-1 font-semibold text-aria underline-offset-4 hover:underline"
              >
                {WEEK_COPY.undo}
              </button>
            </p>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="pl-11 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
