"use client";
// OWNER: 3.5 (placeholder by 1.6 with final props; 3.5 replaces the body per V2-08 §7.2)

/**
 * Syllabus section of /setup: PDF file input + course hint, posts to /api/syllabus/upload.
 * Placeholder: explains the chat path until 3.5 lands.
 */
import { Section } from "@/app/_components/ui/Section";
import { SETUP_COPY } from "@/shared/copy";

/** @returns the syllabus section (`#syllabus`) */
export function SyllabusUpload() {
  return (
    <Section id="syllabus" title={SETUP_COPY.syllabus.title}>
      <p className="text-base leading-relaxed text-ink-soft">{SETUP_COPY.syllabus.intro}</p>
    </Section>
  );
}
