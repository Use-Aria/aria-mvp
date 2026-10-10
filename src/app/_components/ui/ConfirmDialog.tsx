"use client";

/**
 * Confirm step on a native `<dialog>` (`showModal()`: focus trap, Esc closes, inert
 * background). Optional "type DELETE"-style gate before the confirm button enables.
 * The confirm submits a form to `formAction` (a server action).
 */
import { useId, useRef, useState, type ReactNode } from "react";
import { buttonClass, type ButtonVariant } from "@/app/_components/ui/Button";
import { FIELD_CONTROL_CLASS } from "@/app/_components/ui/Field";
import { SubmitButton } from "@/app/_components/ui/SubmitButton";

/**
 * @param props trigger label, dialog title/body, confirm/cancel labels, optional typed gate, and the action
 * @returns trigger button plus dialog
 */
export function ConfirmDialog({
  trigger,
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  pendingLabel,
  requireText,
  requireLabel,
  formAction,
  hidden,
  triggerVariant = "secondary",
  confirmVariant = "danger",
}: {
  trigger: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  pendingLabel?: string;
  /** When set, the confirm button stays disabled until the user types this (case-insensitive). */
  requireText?: string;
  requireLabel?: ReactNode;
  formAction: (formData: FormData) => void | Promise<void>;
  /** Hidden inputs posted with the confirm. */
  hidden?: Record<string, string>;
  triggerVariant?: ButtonVariant;
  confirmVariant?: ButtonVariant;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState("");
  const titleId = useId();
  const inputId = useId();
  const gateOpen = !requireText || typed.trim().toLowerCase() === requireText.toLowerCase();

  return (
    <>
      <button type="button" className={buttonClass(triggerVariant)} onClick={() => ref.current?.showModal()}>
        {trigger}
      </button>
      <dialog
        ref={ref}
        aria-labelledby={titleId}
        onClose={() => setTyped("")}
        className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-3xl bg-paper p-6 text-ink backdrop:bg-ink/40"
      >
        <form action={formAction} className="flex flex-col gap-4">
          {hidden &&
            Object.entries(hidden).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
          <h2 id={titleId} className="text-2xl font-bold tracking-[-0.01em]">
            {title}
          </h2>
          {children && <div className="text-base leading-relaxed text-ink-soft">{children}</div>}
          {requireText && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={inputId} className="text-sm font-medium">
                {requireLabel ?? `Type ${requireText} to confirm.`}
              </label>
              <input
                id={inputId}
                name="confirm"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                className={FIELD_CONTROL_CLASS}
              />
            </div>
          )}
          <div className="flex flex-wrap gap-3">
            <SubmitButton variant={confirmVariant} pendingLabel={pendingLabel} disabled={!gateOpen}>
              {confirmLabel}
            </SubmitButton>
            <button type="button" className={buttonClass("secondary")} onClick={() => ref.current?.close()}>
              {cancelLabel}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
