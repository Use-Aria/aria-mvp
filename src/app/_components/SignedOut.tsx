/**
 * Shown on session-gated pages when the browser has no valid session (copy deck §9.1).
 * `ask` picks the keyword the "Text Aria" button prefills; `pwa` is for the Home Screen
 * app, which on iOS never shares Safari's cookie.
 */
import { TextAriaButton } from "@/app/_components/TextAriaButton";
import { SHARED_COPY } from "@/shared/copy";

/**
 * @param props which link to ask Aria for, and whether this is the installed PWA
 * @returns the signed-out panel (rendered inside a page's `<main>`)
 */
export async function SignedOut({
  ask = "new link",
  pwa = false,
}: {
  ask?: "new link" | "setup" | "settings";
  pwa?: boolean;
}) {
  const copy = pwa ? SHARED_COPY.signedOut.pwa : SHARED_COPY.signedOut[ask];
  return (
    <div className="flex flex-col gap-6 py-6">
      <h1 className="text-4xl font-bold leading-tight tracking-[-0.02em]">{copy.title}</h1>
      <p className="max-w-prose text-lg leading-relaxed text-ink-soft">{copy.body}</p>
      <TextAriaButton body={copy.keyword} label={copy.button} />
    </div>
  );
}
