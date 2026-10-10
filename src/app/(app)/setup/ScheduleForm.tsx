"use client";
// OWNER: 4.4

/**
 * Morning briefing + quiet hours sections of /setup (web plan §7.4, copy deck §9.2): briefing
 * `<select>` (or off), quiet start/end `<select>`s, a live overlap warning when the briefing
 * falls inside quiet hours, and "Use this phone's time zone" when the browser's zone differs
 * from the saved one. Both sections share one form; the time-zone button posts the same form
 * to `saveTimezoneAction`. No `src/server/**` imports: the props type is declared here.
 */
import { useActionState, useState, useSyncExternalStore } from "react";
import { Banner } from "@/app/_components/ui/Banner";
import { FIELD_CONTROL_CLASS, Field } from "@/app/_components/ui/Field";
import { Section } from "@/app/_components/ui/Section";
import { SubmitButton } from "@/app/_components/ui/SubmitButton";
import { buttonClass } from "@/app/_components/ui/Button";
import type { ActionResult } from "@/shared/action-result";
import { actionErrorCopy, SETUP_COPY } from "@/shared/copy";
import {
  BRIEFING_OPTIONS,
  QUIET_END_OPTIONS,
  QUIET_START_OPTIONS,
  briefingInQuietHours,
  formatClock,
  timeZoneLabel,
  type ClockOption,
} from "@/shared/schedule-prefs";
import { saveScheduleAction, saveTimezoneAction } from "./actions";

/** The schedule fields this form reads (structurally the `SetupSchedule` view model). */
export interface ScheduleFormValues {
  /** "HH:MM" (the stored time even when the briefing is off). */
  briefingTime: string;
  briefingEnabled: boolean;
  /** "HH:MM", or "off" when disabled. */
  briefingValue: string;
  quietStart: string;
  quietEnd: string;
  /** Saved IANA zone. */
  timezone: string;
  /** e.g. "Eastern Time". */
  tzLabel: string;
}

/** Options plus the saved value when it isn't one of them (e.g. a 6:30 briefing set in chat). */
function withCurrent(options: readonly ClockOption[], current: string): readonly ClockOption[] {
  if (options.some((o) => o.value === current)) return options;
  let label = current;
  try {
    label = formatClock(current);
  } catch {
    // keep the raw value
  }
  return [{ value: current, label }, ...options];
}

function subscribeNever(): () => void {
  return () => {};
}

function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** The phone's zone after hydration (null during SSR, so markup matches). */
function useBrowserTimeZone(): string | null {
  return useSyncExternalStore(subscribeNever, browserTimeZone, () => null);
}

function ResultBanner({ state }: { state: ActionResult | null }) {
  if (!state) return null;
  return state.ok ? (
    <Banner tone="ok" focusOnMount>
      {SETUP_COPY.save.done}
    </Banner>
  ) : (
    <Banner tone="error" focusOnMount>
      {actionErrorCopy(state.code)}
    </Banner>
  );
}

/**
 * @param props the user's current schedule settings
 * @returns the `#briefing` and `#quiet` sections
 */
export function ScheduleForm({ schedule }: { schedule: ScheduleFormValues }) {
  const [saveState, saveAction] = useActionState(saveScheduleAction, null);
  const [tzState, tzAction] = useActionState(saveTimezoneAction, null);
  const [briefing, setBriefing] = useState(schedule.briefingValue);
  const [quietStart, setQuietStart] = useState(schedule.quietStart);
  const [quietEnd, setQuietEnd] = useState(schedule.quietEnd);
  const phoneZone = useBrowserTimeZone();
  const mismatch = phoneZone !== null && phoneZone !== schedule.timezone ? phoneZone : null;
  const phoneLabel = mismatch ? timeZoneLabel(mismatch) : null;

  const overlap = briefingInQuietHours(briefing, quietStart, quietEnd);
  const briefingOptions = withCurrent(BRIEFING_OPTIONS, schedule.briefingValue);
  const startOptions = withCurrent(QUIET_START_OPTIONS, schedule.quietStart);
  const endOptions = withCurrent(QUIET_END_OPTIONS, schedule.quietEnd);

  return (
    <form action={saveAction} className="flex flex-col gap-8">
      <Section id="briefing" title={SETUP_COPY.briefing.title}>
        <Field id="briefing-time" label={SETUP_COPY.briefing.label} hint={SETUP_COPY.briefing.hint}>
          <select
            name="briefing"
            value={briefing}
            onChange={(e) => setBriefing(e.target.value)}
            className={FIELD_CONTROL_CLASS}
          >
            {briefingOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <p className="text-base text-ink-soft">{SETUP_COPY.briefing.timeZone(schedule.tzLabel)}</p>
        {mismatch && phoneLabel && (
          <div className="flex flex-col gap-3 rounded-2xl bg-bubble px-4 py-3">
            <p className="text-base">{SETUP_COPY.briefing.timeZoneMismatch(phoneLabel)}</p>
            <input type="hidden" name="timezone" value={mismatch} />
            <button type="submit" formAction={tzAction} className={buttonClass("secondary", "self-start")}>
              {SETUP_COPY.briefing.useTimeZone(phoneLabel)}
            </button>
            <ResultBanner state={tzState} />
          </div>
        )}
      </Section>
      <Section id="quiet" title={SETUP_COPY.quiet.title}>
        <p className="text-base leading-relaxed text-ink-soft">{SETUP_COPY.quiet.hint}</p>
        <div className="grid grid-cols-2 gap-3">
          <Field id="quiet-start" label={SETUP_COPY.quiet.from}>
            <select
              name="quietStart"
              value={quietStart}
              onChange={(e) => setQuietStart(e.target.value)}
              className={FIELD_CONTROL_CLASS}
            >
              {startOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <Field id="quiet-end" label={SETUP_COPY.quiet.until}>
            <select
              name="quietEnd"
              value={quietEnd}
              onChange={(e) => setQuietEnd(e.target.value)}
              className={FIELD_CONTROL_CLASS}
            >
              {endOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {overlap && (
          <p role="status" className="rounded-2xl bg-warn-bg px-4 py-3 text-base leading-relaxed">
            {SETUP_COPY.quiet.overlap(formatClock(quietEnd))}
          </p>
        )}
        <div className="flex flex-col gap-3">
          <SubmitButton pendingLabel={SETUP_COPY.save.pending} className="self-start">
            {SETUP_COPY.save.idle}
          </SubmitButton>
          <ResultBanner state={saveState} />
        </div>
      </Section>
    </form>
  );
}
