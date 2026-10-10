"use client";

/**
 * Last-resort error page when the root layout itself fails. Renders its own document and
 * imports the global styles (Next doesn't apply them here). Skew errors offer a reload.
 */
import "./globals.css";
import { isSkewError } from "@/shared/action-result";
import { SHARED_COPY } from "@/shared/copy";

export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const skew = isSkewError(error.message);
  const copy = skew ? SHARED_COPY.skew : SHARED_COPY.genericError;
  return (
    <html lang="en">
      <body className="antialiased">
        <title>{copy.title}</title>
        <div className="safe-x mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center gap-6 pb-24">
          <p className="text-xl font-bold tracking-tight text-aria">aria</p>
          <h1 className="text-4xl font-bold leading-tight tracking-[-0.02em]">{copy.title}</h1>
          <p className="max-w-prose text-lg leading-relaxed text-ink-soft">{copy.body}</p>
          <button
            type="button"
            onClick={() => (skew ? window.location.reload() : retry())}
            className="inline-flex min-h-11 items-center self-start rounded-full bg-aria px-6 py-3 text-base font-semibold text-aria-ink"
          >
            {copy.button}
          </button>
        </div>
      </body>
    </html>
  );
}
