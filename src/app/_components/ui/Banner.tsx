"use client";

/**
 * Inline result banner. `ok`/`warn` announce politely (`role="status"`); `error` uses
 * `role="alert"`. With `focusOnMount`, focus moves to the banner after an action.
 */
import { useEffect, useRef, type ReactNode } from "react";
import type { BannerTone } from "@/shared/copy";

const TONES: Record<BannerTone, string> = {
  ok: "bg-mint text-ink",
  warn: "bg-warn-bg text-ink",
  error: "bg-danger-bg text-ink",
};

/**
 * @param props tone, content, and whether to take focus when it appears
 * @returns the banner
 */
export function Banner({
  tone,
  children,
  focusOnMount = false,
  className = "",
}: {
  tone: BannerTone;
  children: ReactNode;
  focusOnMount?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusOnMount) ref.current?.focus();
  }, [focusOnMount]);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role={tone === "error" ? "alert" : "status"}
      className={`rounded-2xl px-4 py-3 text-base leading-relaxed outline-none ${TONES[tone]} ${className}`}
    >
      {children}
    </div>
  );
}
