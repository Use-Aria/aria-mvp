"use client";
// OWNER: 4.4

/**
 * "How Aria talks" section of /setup (web plan §7.4, copy deck §9.2): a radio group of the
 * three tones, each with a sample bubble, saved with `saveToneAction`.
 */
import { useActionState, useState } from "react";
import { Banner } from "@/app/_components/ui/Banner";
import { Section } from "@/app/_components/ui/Section";
import { SubmitButton } from "@/app/_components/ui/SubmitButton";
import { actionErrorCopy, SETUP_COPY } from "@/shared/copy";
import { TONE_OPTIONS, type Tone } from "@/shared/persona-prefs";
import { saveToneAction } from "./actions";

/**
 * @param props the saved tone
 * @returns the `#tone` section
 */
export function ToneForm({ tone }: { tone: Tone }) {
  const [state, formAction] = useActionState(saveToneAction, null);
  const [selected, setSelected] = useState<Tone>(tone);

  return (
    <Section id="tone" title={SETUP_COPY.tone.title}>
      <form action={formAction} className="flex flex-col gap-4">
        <fieldset className="flex flex-col gap-3">
          <legend className="sr-only">{SETUP_COPY.tone.title}</legend>
          {TONE_OPTIONS.map((o) => {
            const id = `tone-${o.value}`;
            const checked = selected === o.value;
            return (
              <label
                key={o.value}
                htmlFor={id}
                className={`flex cursor-pointer items-start gap-3 rounded-2xl border px-4 py-3 ${
                  checked ? "border-aria" : "border-line"
                }`}
              >
                <input
                  id={id}
                  type="radio"
                  name="tone"
                  value={o.value}
                  checked={checked}
                  onChange={() => setSelected(o.value)}
                  aria-describedby={`${id}-desc ${id}-sample`}
                  className="mt-1 size-5 shrink-0 accent-[var(--aria)]"
                />
                <span className="flex min-w-0 flex-col gap-2">
                  <span className="text-base">
                    <span className="font-semibold">{o.label}</span>
                    <span id={`${id}-desc`} className="text-ink-soft">
                      {" "}
                      · {o.description}
                    </span>
                  </span>
                  <span
                    id={`${id}-sample`}
                    className="w-fit max-w-[85%] rounded-[20px] bg-bubble px-4 py-2 text-[15px] leading-snug"
                  >
                    {o.sample}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>
        <SubmitButton pendingLabel={SETUP_COPY.save.pending} className="self-start">
          {SETUP_COPY.save.idle}
        </SubmitButton>
        {state &&
          (state.ok ? (
            <Banner tone="ok" focusOnMount>
              {SETUP_COPY.save.done}
            </Banner>
          ) : (
            <Banner tone="error" focusOnMount>
              {actionErrorCopy(state.code)}
            </Banner>
          ))}
      </form>
    </Section>
  );
}
