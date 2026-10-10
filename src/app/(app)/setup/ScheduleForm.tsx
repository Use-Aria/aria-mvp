"use client";
// OWNER: 4.4 (placeholder by 1.6 with final props; 4.4 replaces the body per web plan §7.4)

/**
 * Morning briefing + quiet hours sections of /setup: briefing `<select>`, quiet start/end,
 * overlap warning, time-zone mismatch button. Placeholder: read-only summary until 4.4 lands.
 */
import { Section } from "@/app/_components/ui/Section";
import type { SetupSchedule } from "@/server/web/setup-data";
import { SETUP_COPY } from "@/shared/copy";
import { briefingInQuietHours, formatClock } from "@/shared/schedule-prefs";

/**
 * @param props the user's current schedule settings
 * @returns the `#briefing` and `#quiet` sections
 */
export function ScheduleForm({ schedule }: { schedule: SetupSchedule }) {
  const overlap =
    schedule.briefingEnabled &&
    briefingInQuietHours(schedule.briefingTime, schedule.quietStart, schedule.quietEnd);
  return (
    <>
      <Section id="briefing" title={SETUP_COPY.briefing.title}>
        <p className="text-base leading-relaxed">
          {schedule.briefingEnabled
            ? `${SETUP_COPY.briefing.label} ${formatClock(schedule.briefingTime)}.`
            : `${SETUP_COPY.briefing.off}.`}{" "}
          <span className="text-ink-soft">{SETUP_COPY.briefing.hint}</span>
        </p>
        <p className="text-base text-ink-soft">{SETUP_COPY.briefing.timeZone(schedule.tzLabel)}</p>
        {overlap && <p className="text-base">{SETUP_COPY.quiet.overlap(formatClock(schedule.quietEnd))}</p>}
      </Section>
      <Section id="quiet" title={SETUP_COPY.quiet.title}>
        <p className="text-base leading-relaxed text-ink-soft">{SETUP_COPY.quiet.hint}</p>
        <p className="text-base">
          {SETUP_COPY.quiet.from} {formatClock(schedule.quietStart)} · {SETUP_COPY.quiet.until}{" "}
          {formatClock(schedule.quietEnd)}
        </p>
      </Section>
    </>
  );
}
