"use client";

/**
 * Submit button that disables itself while its form's action is pending, so a double
 * tap can't submit twice. Must be rendered inside a `<form>`.
 */
import { useFormStatus } from "react-dom";
import type { ReactNode } from "react";
import { buttonClass, type ButtonVariant } from "@/app/_components/ui/Button";

/**
 * @param props label, pending label, variant, and an optional extra disable condition
 * @returns the button
 */
export function SubmitButton({
  children,
  pendingLabel,
  variant = "primary",
  disabled = false,
  className = "",
}: {
  children: ReactNode;
  pendingLabel?: string;
  variant?: ButtonVariant;
  disabled?: boolean;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      aria-disabled={pending || disabled}
      className={buttonClass(variant, className)}
    >
      {pending && pendingLabel ? pendingLabel : children}
    </button>
  );
}
