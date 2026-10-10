"use client";

/**
 * Landing form: first name + phone → POST /api/signup → "Text Aria" button.
 * The signup only lets Aria greet you by name; texting Aria is what signs you up.
 */
import { useState, useSyncExternalStore, type FormEvent } from "react";
import { detectPlatform, formatNumber, smsLink, type Platform } from "@/shared/sms-link";

type State = "idle" | "saving" | "done";

const noopSubscribe = () => () => {};
const readPlatform = (): Platform => detectPlatform(navigator.userAgent);
const serverPlatform = (): Platform => "apple";

const ERRORS: Record<string, string> = {
  invalid_phone: "Enter a US number like (203) 555-0142, or include your country code.",
  rate_limited: "Too many tries from this network. Wait a few minutes and try again.",
};

export function SignupForm({ ariaNumber }: { ariaNumber: string | null }) {
  const [state, setState] = useState<State>("idle");
  const [error, setError] = useState<string | null>(null);
  // Client-only value without setState-in-effect; the server renders "apple".
  const platform = useSyncExternalStore(noopSubscribe, readPlatform, serverPlatform);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setState("saving");
    const form = new FormData(e.currentTarget);
    try {
      const res = await fetch("/api/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.get("name"),
          phone: form.get("phone"),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      if (!res.ok) {
        const body: { error?: string } = await res.json().catch(() => ({}));
        setError(ERRORS[body.error ?? ""] ?? "That didn't save. Check your details and try again.");
        setState("idle");
        return;
      }
      setState("done");
    } catch {
      setError("You look offline. Check your connection and try again.");
      setState("idle");
    }
  }

  if (state === "done") {
    if (!ariaNumber) {
      return (
        <p className="text-ink-soft" role="status">
          You&apos;re on the list. Aria&apos;s number isn&apos;t live yet, so we&apos;ll text you when it is.
        </p>
      );
    }
    const href = smsLink(ariaNumber, "Hey Aria!", platform);
    return (
      <div className="flex flex-col gap-3" role="status">
        {platform === "desktop" ? (
          <p className="text-lg">
            From your phone, text <strong>{formatNumber(ariaNumber)}</strong> to say hi to Aria.
          </p>
        ) : (
          <>
            <a
              href={href}
              className="inline-flex h-14 items-center justify-center rounded-full bg-aria px-8 text-lg font-semibold text-aria-ink"
            >
              Text Aria
            </a>
            <p className="text-sm text-ink-soft">
              Messages opens with &ldquo;Hey Aria!&rdquo; ready to send. Aria&apos;s number is{" "}
              {formatNumber(ariaNumber)}.
            </p>
          </>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3" noValidate>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">First name</span>
        <input
          name="name"
          required
          maxLength={40}
          autoComplete="given-name"
          className="h-12 rounded-xl border border-field bg-transparent px-4 text-base"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Phone number</span>
        <input
          name="phone"
          type="tel"
          required
          inputMode="tel"
          autoComplete="tel"
          placeholder="(203) 555-0142"
          className="h-12 rounded-xl border border-field bg-transparent px-4 text-base placeholder:text-ink-soft/60"
        />
      </label>
      {error && (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={state === "saving"}
        className="mt-1 h-14 rounded-full bg-aria text-lg font-semibold text-aria-ink disabled:opacity-60"
      >
        {state === "saving" ? "Saving…" : "Continue to Messages"}
      </button>
      <p className="text-xs leading-relaxed text-ink-soft">
        Aria is in a private test. It texts you briefings and reminders; reply STOP anytime to
        stop. Message and data rates may apply.
      </p>
    </form>
  );
}
