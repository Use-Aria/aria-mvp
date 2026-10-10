"use client";

/**
 * Reads the token from the URL fragment, scrubs it from history, and submits
 * a navigational POST to /api/session/redeem (which 303s to the target).
 * The visible button is the fallback if the auto-submit is blocked.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";

const noopSubscribe = () => () => {};

// The fragment is scrubbed after the first read, so remember the token for
// the life of the page; a new token in the hash (fresh load) replaces it.
let capturedToken = "";
function readToken(): string {
  const fromHash = new URLSearchParams(window.location.hash.slice(1)).get("t");
  if (fromHash) capturedToken = fromHash;
  return capturedToken;
}
/** On the server the fragment is unknown. */
const serverToken = (): string | null => null;

export function RedeemForm() {
  const formRef = useRef<HTMLFormElement>(null);
  const tokenRef = useRef<HTMLInputElement>(null);
  const token = useSyncExternalStore<string | null>(noopSubscribe, readToken, serverToken);

  useEffect(() => {
    if (!token) return;
    if (tokenRef.current) tokenRef.current.value = token;
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    formRef.current?.submit();
  }, [token]);

  if (token === "") {
    return (
      <p className="text-lg text-ink-soft">
        This link is missing its code. Text Aria &ldquo;new link&rdquo; to get a fresh one.
      </p>
    );
  }

  return (
    <form ref={formRef} method="post" action="/api/session/redeem" className="flex flex-col gap-4">
      <input ref={tokenRef} type="hidden" name="t" />
      <p className="text-lg text-ink-soft">Opening Aria…</p>
      <button
        type="submit"
        className="h-14 rounded-full bg-aria px-8 text-lg font-semibold text-aria-ink"
      >
        Open Aria
      </button>
    </form>
  );
}
