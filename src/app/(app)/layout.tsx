/**
 * Shell for the signed-in pages (/week, /setup, /settings, /email): wordmark, nav,
 * safe-area padding, one left-aligned column. NOT an auth boundary: every page and
 * action checks the session itself.
 */
import type { ReactNode } from "react";
import { AppNav } from "@/app/_components/AppNav";
import { RefreshOnFocus } from "@/app/_components/RefreshOnFocus";
import { Wordmark } from "@/app/_components/Wordmark";
import { SubmitButton } from "@/app/_components/ui/SubmitButton";
import { requireViewer } from "@/server/web/guard";
import { SHARED_COPY } from "@/shared/copy";
import { signOut } from "./session-actions";

export default async function AppLayout({ children }: Readonly<{ children: ReactNode }>) {
  const viewer = await requireViewer();
  return (
    <div className="safe-x mx-auto flex min-h-dvh w-full max-w-xl flex-col">
      <a
        href="#main"
        // Off-screen until focused (not `sr-only`: its padding reset fought `px-4` and left a
        // padding-less pill when focused).
        className="absolute left-4 top-[-6rem] z-50 inline-flex min-h-11 items-center rounded-full bg-aria px-5 font-semibold text-aria-ink focus:top-[max(1rem,env(safe-area-inset-top))]"
      >
        Skip to content
      </a>
      <header className="safe-t flex flex-wrap items-center justify-between gap-x-4 gap-y-1 pb-2">
        <Wordmark href={viewer ? "/week" : "/"} />
        {viewer && <AppNav />}
      </header>
      <main id="main" className="flex flex-1 flex-col gap-8 pb-12 pt-6">
        {children}
      </main>
      {viewer && (
        <footer className="safe-b flex flex-wrap items-center gap-4 border-t border-line pt-4 text-sm">
          <form action={signOut}>
            <SubmitButton variant="ghost" pendingLabel="Signing out…">
              {SHARED_COPY.signOut}
            </SubmitButton>
          </form>
        </footer>
      )}
      <RefreshOnFocus />
    </div>
  );
}
