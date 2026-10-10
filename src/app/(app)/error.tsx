"use client";

/**
 * Error boundary for the app pages. Deploy skew ("Failed to find Server Action", a tab
 * opened before a deploy) gets "Aria just updated" + Reload; anything else gets the
 * generic message + retry().
 */
import { useEffect } from "react";
import { buttonClass } from "@/app/_components/ui/Button";
import { isSkewError } from "@/shared/action-result";
import { SHARED_COPY } from "@/shared/copy";

export default function AppError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const skew = isSkewError(error.message);
  useEffect(() => {
    console.error("[app] render error", error.digest ?? "");
  }, [error]);
  const copy = skew ? SHARED_COPY.skew : SHARED_COPY.genericError;
  return (
    <div role="alert" className="flex flex-col gap-6 py-6">
      <h1 className="text-4xl font-bold leading-tight tracking-[-0.02em]">{copy.title}</h1>
      <p className="max-w-prose text-lg leading-relaxed text-ink-soft">{copy.body}</p>
      <button
        type="button"
        className={buttonClass("primary", "self-start")}
        onClick={() => (skew ? window.location.reload() : retry())}
      >
        {copy.button}
      </button>
    </div>
  );
}
