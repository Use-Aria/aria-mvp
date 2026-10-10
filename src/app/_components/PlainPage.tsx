/**
 * Frame for standalone pages outside the app shell (404, signed out, link expired, legal):
 * wordmark on top, one left-aligned column, safe-area padding.
 */
import type { ReactNode } from "react";
import { Wordmark } from "@/app/_components/Wordmark";

/**
 * @param props content, and whether to center it vertically (short status pages)
 * @returns the page frame with `<main>`
 */
export function PlainPage({ children, center = true }: { children: ReactNode; center?: boolean }) {
  return (
    <div className="safe-x mx-auto flex min-h-dvh w-full max-w-xl flex-col">
      <header className="safe-t pb-2">
        <Wordmark />
      </header>
      <main
        id="main"
        className={`safe-b flex flex-1 flex-col gap-6 pt-6 ${center ? "justify-center pb-24" : "pb-12"}`}
      >
        {children}
      </main>
    </div>
  );
}
