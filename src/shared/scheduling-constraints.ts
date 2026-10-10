// OWNER: 0.2 (frozen contract; only the orchestrator edits this file — master plan §1.0.2)

/**
 * Hard scheduling constraints (master plan §1.17; V2-07 §2.7 / §9.2 union). Pure, client-safe.
 * Used by `find_free_slots` input and stored in `user_preferences.constraint_json`
 * (`ConstraintPrefSchema`, written by `propose_preference`).
 */
import { z } from "zod";

/** "HH:MM" 24h local wall-clock time. */
export const HHMMSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** RFC 5545 weekday code (same set as `Weekday` in `src/shared/time/tz.ts`). */
export const WeekdaySchema = z.enum(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]);

/** One hard constraint on when a block may be placed. */
export const ConstraintSchema = z.discriminatedUnion("type", [
  /** slot END ≤ time */
  z.object({ type: z.literal("not_after"), time: HHMMSchema, days: z.array(WeekdaySchema).optional() }),
  /** slot START ≥ time */
  z.object({ type: z.literal("not_before"), time: HHMMSchema, days: z.array(WeekdaySchema).optional() }),
  z.object({
    type: z.literal("avoid_range"),
    start: HHMMSchema,
    end: HHMMSchema,
    days: z.array(WeekdaySchema).optional(),
  }),
  z.object({ type: z.literal("avoid_days"), days: z.array(WeekdaySchema).min(1) }),
  z.object({ type: z.literal("only_days"), days: z.array(WeekdaySchema).min(1) }),
  /** overrides the 10-min default buffer */
  z.object({ type: z.literal("buffer_minutes"), minutes: z.number().int().min(0).max(60) }),
]);
export type Constraint = z.infer<typeof ConstraintSchema>;

/**
 * Machine-readable form of a preference (`user_preferences.constraint_json`), e.g.
 * `{applies_to:["gym"], constraint:{type:"not_after", time:"20:00"}, waking:null, signoff:null}`.
 */
export const ConstraintPrefSchema = z.object({
  /** activities this applies to; "*" = all */
  applies_to: z.array(z.string()).min(1),
  constraint: ConstraintSchema.nullable(),
  /** waking-hours override; end may be past midnight */
  waking: z.object({ start: HHMMSchema, end: HHMMSchema }).nullable(),
  /** email sign-off, e.g. "Best,\nDaniel" */
  signoff: z.string().nullable(),
});
export type ConstraintPref = z.infer<typeof ConstraintPrefSchema>;
