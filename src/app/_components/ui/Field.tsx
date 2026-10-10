/**
 * Labeled form field: label, hint, and error, wired to the control with `id`,
 * `aria-describedby`, and `aria-invalid`. Pass exactly one control element as the child.
 */
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";

/** Input/select/textarea classes: 16px text (no iOS focus zoom), 3:1 outline. */
export const FIELD_CONTROL_CLASS =
  "min-h-12 w-full rounded-xl border border-field bg-transparent px-4 py-2 text-base text-ink placeholder:text-ink-soft/70 aria-[invalid=true]:border-danger";

/**
 * @param props field id, label, optional hint and error, and the control
 * @returns the field group
 */
export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactElement;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        id,
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : undefined,
      })
    : children;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {control}
      {hint && (
        <p id={hintId} className="text-sm text-ink-soft">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
