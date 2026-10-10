/** A heading + body block for the plain-language legal pages. */
import type { ReactNode } from "react";

/**
 * @param props heading and content
 * @returns the block
 */
export function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xl font-bold tracking-[-0.01em]">{title}</h2>
      <div className="flex flex-col gap-3 text-base leading-relaxed text-ink-soft [&_strong]:text-ink [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5">
        {children}
      </div>
    </section>
  );
}
