/**
 * One local day on /week (web plan §7.5): header, load bar, deadlines (with mark-done), and
 * schedule rows. Server component. OWNER: 4.4.
 */
import { WEEK_COPY } from "@/shared/copy";
import type { WeekDay } from "@/shared/week";
import { DeadlineRow, ScheduleRow } from "./ItemRow";
import { LoadBar } from "./LoadBar";

/**
 * @param props the grouped day, the viewer's zone, and the link allow-list
 * @returns the day section
 */
export function DayGroup({
  day,
  timeZone,
  allowHosts,
}: {
  day: WeekDay;
  timeZone: string;
  allowHosts: readonly string[];
}) {
  const headingId = `day-${day.key}`;
  const dueCount = day.deadlines.filter((i) => i.status === "upcoming").length;
  const empty = day.deadlines.length === 0 && day.schedule.length === 0;
  return (
    <section aria-labelledby={headingId} data-day={day.key} className="flex flex-col gap-3 border-t border-line pt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={headingId} className="text-xl font-bold tracking-[-0.01em]">
          {day.label}
        </h2>
        <LoadBar level={day.load} points={day.points} label={WEEK_COPY.dayLoadLabel(day.load, dueCount)} />
      </div>
      {empty && <p className="text-base text-ink-soft">{WEEK_COPY.emptyDay}</p>}
      {day.deadlines.length > 0 && (
        <ul className="flex flex-col gap-2">
          {day.deadlines.map((item) => (
            <DeadlineRow key={item.id} item={item} timeZone={timeZone} allowHosts={allowHosts} />
          ))}
        </ul>
      )}
      {day.schedule.length > 0 && (
        <ul className="flex flex-col gap-2 rounded-2xl bg-bubble px-4 py-3">
          {day.schedule.map((item) => (
            <ScheduleRow key={item.id} item={item} timeZone={timeZone} allowHosts={allowHosts} />
          ))}
        </ul>
      )}
    </section>
  );
}
