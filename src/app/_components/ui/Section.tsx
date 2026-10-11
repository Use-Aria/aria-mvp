/**
 * A page section with a labeled heading (`<section aria-labelledby>`) and an optional
 * status pill, e.g. "Connected".
 */
import type { ReactNode } from "react";

/**
 * @param props anchor id, heading, optional status, and content
 * @returns the section
 */
export function Section({
  id,
  title,
  status,
  statusTone = "neutral",
  children,
}: {
  id: string;
  title: ReactNode;
  status?: ReactNode;
  statusTone?: "neutral" | "ok" | "warn";
  children: ReactNode;
}) {
  const headingId = `${id}-title`;
  const pill =
    statusTone === "ok" ? "bg-mint text-ink" : statusTone === "warn" ? "bg-warn-bg text-ink" : "bg-bubble text-ink-soft";
  return (
    <section id={id} aria-labelledby={headingId} className="flex scroll-mt-24 flex-col gap-4 border-t border-line pt-8">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id={headingId} className="text-2xl font-bold tracking-[-0.01em]">
          {title}
        </h2>
        {status && (
          // Long values (a Google address) wrap inside the column instead of poking past it.
          <span className={`max-w-full rounded-2xl px-3 py-0.5 text-sm font-medium [overflow-wrap:anywhere] ${pill}`}>
            {status}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}
