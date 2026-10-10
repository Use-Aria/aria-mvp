import type { Metadata } from "next";
import Link from "next/link";
import { SignedOut } from "@/app/_components/SignedOut";
import { Button } from "@/app/_components/ui/Button";
import { requireViewer } from "@/server/web/guard";
import { getWeekView, parseOffsetWeeks } from "@/server/web/week-data";
import { WEEK_COPY } from "@/shared/copy";
import { dayLabel, localDayKey, type WeekItem } from "@/shared/week";
import { formatLocalDate, localDateOf } from "@/shared/time/tz";
import { DayGroup } from "./DayGroup";
import { DeadlineRow } from "./ItemRow";
import { LoadBar } from "./LoadBar";

export const metadata: Metadata = { title: "Your week", robots: { index: false, follow: false } };

type Search = Promise<{ w?: string | string[]; src?: string | string[] }>;

function itemDayKey(item: WeekItem, timeZone: string): string | null {
  if (item.allDay && item.allDayDate) return item.allDayDate;
  const at = item.dueAt ?? item.startsAt;
  return at ? localDayKey(at, timeZone) : null;
}

/**
 * /week (web plan §2.5, §7.5; copy deck §9.3). OWNER: 4.4. Rolling 7 local days (today first,
 * or the following 7 with `?w=1`), "Still open" on top, per-day load, mark done, empty states,
 * and the Canvas sync-failing banner. `?src=pwa` without a session shows the PWA sign-in copy.
 */
export default async function WeekPage({ searchParams }: { searchParams: Search }) {
  const { w, src } = await searchParams;
  const viewer = await requireViewer();
  if (!viewer) return <SignedOut pwa={(Array.isArray(src) ? src[0] : src) === "pwa"} />;

  const offsetWeeks = parseOffsetWeeks(w);
  const now = new Date();
  const view = await getWeekView(viewer, { offsetWeeks, now });
  const { week, timeZone, allowHosts } = view;
  const todayKey = formatLocalDate(localDateOf(now, timeZone));
  const hasAnything = week.stillOpen.length > 0 || week.days.some((d) => d.deadlines.length + d.schedule.length > 0);
  const nothingDue = week.dueCount === 0 && week.stillOpen.length === 0;
  const weekLabel = `${WEEK_COPY.weekLoad[week.load]} · ${WEEK_COPY.thingsDue(week.dueCount)}`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-4xl font-bold leading-tight tracking-[-0.02em]">{WEEK_COPY.title(viewer.name)}</h1>
        <p className="text-base text-ink-soft">{WEEK_COPY.subtitle(offsetWeeks, view.tzLabel)}</p>
        <LoadBar level={week.load} points={week.dueCount} label={weekLabel} />
      </div>

      {view.canvasFailing && (
        <div role="status" className="flex flex-col gap-3 rounded-2xl bg-warn-bg px-4 py-4 text-base leading-relaxed">
          <p>{WEEK_COPY.syncFailing(view.canvasFailingSince ?? "the last check")}</p>
          <Button as="a" href="/setup#canvas" variant="secondary" className="self-start">
            {WEEK_COPY.syncFailingButton}
          </Button>
        </div>
      )}

      {!view.canvas.connected && (
        <div className="flex flex-col gap-4 rounded-3xl bg-bubble p-5">
          <p className="text-lg font-semibold">{WEEK_COPY.emptyNoCanvas.title}</p>
          <p className="text-base text-ink-soft">{WEEK_COPY.emptyNoCanvas.body}</p>
          <Button as="a" href="/setup#canvas" className="self-start">
            {WEEK_COPY.emptyNoCanvas.button}
          </Button>
        </div>
      )}

      {view.canvas.connected && nothingDue && (
        <div role="status" className="flex flex-col gap-1 rounded-3xl bg-bubble p-5">
          <p className="text-lg font-semibold">{WEEK_COPY.emptyConnected.title}</p>
          <p className="text-base text-ink-soft">{WEEK_COPY.emptyConnected.body}</p>
        </div>
      )}

      {week.stillOpen.length > 0 && (
        <section aria-labelledby="still-open" className="flex flex-col gap-3 rounded-3xl bg-warn-bg px-4 py-4">
          <div className="flex flex-col">
            <h2 id="still-open" className="text-xl font-bold tracking-[-0.01em]">
              {WEEK_COPY.stillOpen.title}
            </h2>
            <p className="text-sm text-ink-soft">{WEEK_COPY.stillOpen.hint}</p>
          </div>
          <ul className="flex flex-col gap-2">
            {week.stillOpen.map((item) => {
              const key = itemDayKey(item, timeZone);
              return (
                <DeadlineRow
                  key={item.id}
                  item={item}
                  timeZone={timeZone}
                  allowHosts={allowHosts}
                  whenPrefix={key ? dayLabel(key, todayKey, timeZone) : undefined}
                />
              );
            })}
          </ul>
        </section>
      )}

      {(hasAnything || view.canvas.connected) && (
        <div className="flex flex-col gap-6">
          {week.days.map((day) => (
            <DayGroup key={day.key} day={day} timeZone={timeZone} allowHosts={allowHosts} />
          ))}
        </div>
      )}

      {!view.googleConnected && (
        <p className="text-base text-ink-soft">
          {WEEK_COPY.noGoogle.text}{" "}
          <a href="/setup#google" className="font-semibold text-aria underline underline-offset-4">
            {WEEK_COPY.noGoogle.button}
          </a>
        </p>
      )}

      <nav aria-label="Weeks" className="flex border-t border-line pt-4">
        {offsetWeeks === 0 ? (
          <Link href="/week?w=1" className="inline-flex min-h-11 items-center font-semibold text-aria">
            {WEEK_COPY.nextWeek}
          </Link>
        ) : (
          <Link href="/week" className="inline-flex min-h-11 items-center font-semibold text-aria">
            {WEEK_COPY.thisWeek}
          </Link>
        )}
      </nav>
    </div>
  );
}
