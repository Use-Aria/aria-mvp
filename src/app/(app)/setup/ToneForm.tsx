"use client";
// OWNER: 4.4 (placeholder by 1.6 with final props; 4.4 replaces the body per web plan §7.4)

/**
 * "How Aria talks" section of /setup: radio group of three tones with a sample bubble each.
 * Placeholder: read-only list with the current tone marked until 4.4 lands.
 */
import { Section } from "@/app/_components/ui/Section";
import { SETUP_COPY } from "@/shared/copy";
import { TONE_OPTIONS, type Tone } from "@/shared/persona-prefs";

/**
 * @param props the saved tone
 * @returns the `#tone` section
 */
export function ToneForm({ tone }: { tone: Tone }) {
  return (
    <Section id="tone" title={SETUP_COPY.tone.title}>
      <ul className="flex flex-col gap-4">
        {TONE_OPTIONS.map((o) => (
          <li key={o.value} className="flex flex-col gap-2" aria-current={o.value === tone ? "true" : undefined}>
            <p className="text-base">
              <span className="font-semibold">{o.label}</span>
              {o.value === tone && <span className="ml-2 rounded-full bg-mint px-2 py-0.5 text-sm">Current</span>}
              <span className="text-ink-soft"> · {o.description}</span>
            </p>
            <p className="w-fit max-w-[85%] rounded-[20px] bg-bubble px-4 py-2 text-[15px] leading-snug">{o.sample}</p>
          </li>
        ))}
      </ul>
    </Section>
  );
}
