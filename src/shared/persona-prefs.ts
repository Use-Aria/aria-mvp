/**
 * How Aria talks: the persona dial stored in `users.persona_prefs` (master plan §1.17, C19).
 * Pure and client-safe. The agent, the web Tone form, and template renderers all read the
 * tone through `parsePersonaPrefs`, so a malformed row can never break a reply.
 */
import { z } from "zod";
import { computeRegisterHint, registerClass } from "@/shared/register";

/** Tone values, in display order. `mirror` is the default (locked decision). */
export const TONES = ["mirror", "casual", "polished"] as const;
export type Tone = (typeof TONES)[number];

/** Zod schema for the persisted prefs object (other keys pass through untouched). */
export const PersonaPrefsSchema = z.object({ tone: z.enum(TONES).default("mirror") });

/** Parsed persona prefs. */
export interface PersonaPrefs {
  tone: Tone;
}

/** Defaults for a user who never chose. */
export const DEFAULT_PERSONA_PREFS: PersonaPrefs = { tone: "mirror" };

/**
 * Reads persona prefs from the stored JSON. Never throws.
 * @param json `users.persona_prefs` (any shape: `{}`, null, garbage)
 * @returns prefs with `tone` defaulted to `mirror` when missing or unknown
 */
export function parsePersonaPrefs(json: unknown): PersonaPrefs {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return { ...DEFAULT_PERSONA_PREFS };
  }
  const tone = (json as Record<string, unknown>).tone;
  return { tone: isTone(tone) ? tone : DEFAULT_PERSONA_PREFS.tone };
}

/**
 * Type guard for a tone value.
 * @param value anything
 * @returns true when `value` is one of `TONES`
 */
export function isTone(value: unknown): value is Tone {
  return typeof value === "string" && (TONES as readonly string[]).includes(value);
}

/**
 * Returns a new prefs object with `tone` set, keeping any other keys already stored.
 * @param existing current `users.persona_prefs`
 * @param tone new tone
 * @returns the object to write back
 */
export function withTone(existing: unknown, tone: Tone): Record<string, unknown> {
  const base =
    existing !== null && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  return { ...base, tone };
}

/** One radio option on the web Tone form (copy deck §9.2). */
export interface ToneOption {
  value: Tone;
  label: string;
  description: string;
  sample: string;
}

/** Tone choices with labels, descriptions, and a sample bubble each. */
export const TONE_OPTIONS: readonly ToneOption[] = [
  {
    value: "mirror",
    label: "Match me",
    description: "Aria picks up how you text.",
    sample: "3 things due this week, the pset's the big one",
  },
  {
    value: "casual",
    label: "Casual",
    description: "lowercase, short, a little slang.",
    sample: "ok 3 things this week. pset is the big one, start tmr?",
  },
  {
    value: "polished",
    label: "Polished",
    description: "Full sentences, no slang.",
    sample: "You have 3 deadlines this week. The problem set is the largest.",
  },
];

/**
 * Which register deterministic templates (alerts, reminders, briefing fallbacks) should use.
 * polished → neutral; casual → casual; mirror → the register heuristic over the user's own texts.
 * @param prefs parsed persona prefs
 * @param recentUserTexts the user's recent inbound texts, oldest first (user-authored only)
 * @returns "casual" | "neutral"
 */
export function templateRegister(
  prefs: PersonaPrefs,
  recentUserTexts: readonly string[],
): "casual" | "neutral" {
  if (prefs.tone === "polished") return "neutral";
  if (prefs.tone === "casual") return "casual";
  return registerClass(computeRegisterHint([...recentUserTexts]));
}
