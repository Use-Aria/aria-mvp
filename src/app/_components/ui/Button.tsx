/**
 * Button and button-styled link. Variants: primary, secondary, danger, ghost.
 * Every variant keeps a 44px minimum target (Apple HIG).
 */
import type { AnchorHTMLAttributes, ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

const BASE =
  "inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-full text-base font-semibold transition-opacity motion-safe:duration-150 disabled:cursor-not-allowed disabled:opacity-60";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-aria px-6 py-3 text-aria-ink",
  secondary: "border border-field px-6 py-3 text-ink",
  danger: "bg-danger px-6 py-3 text-paper",
  ghost: "px-1 text-aria underline-offset-4 hover:underline",
};

/**
 * Class string for a variant, for elements that can't use `Button` (e.g. `<summary>`).
 * @param variant visual style
 * @param extra additional classes
 * @returns class names
 */
export function buttonClass(variant: ButtonVariant = "primary", extra = ""): string {
  return `${BASE} ${VARIANTS[variant]} ${extra}`.trim();
}

type AsButton = { as?: "button"; variant?: ButtonVariant } & ButtonHTMLAttributes<HTMLButtonElement>;
type AsLink = { as: "a"; href: string; variant?: ButtonVariant } & AnchorHTMLAttributes<HTMLAnchorElement>;

/**
 * `<button>` by default; `as="a"` renders a plain `<a>` (never `next/link`, so nothing prefetches).
 * @param props element props plus `variant`
 * @returns the element
 */
export function Button(props: AsButton | AsLink) {
  if (props.as === "a") {
    const { as: _as, variant = "primary", className = "", ...rest } = props;
    void _as;
    return <a {...rest} className={buttonClass(variant, className)} />;
  }
  const { as: _as, variant = "primary", className = "", type = "button", ...rest } = props;
  void _as;
  return <button type={type} {...rest} className={buttonClass(variant, className)} />;
}
