/**
 * One /week row (copy deck §9.3). OWNER: 4.4. Deadlines get a mark-done toggle; schedule rows
 * read "10:30–11:45 AM · {title}". Titles and courses are untrusted: React escapes them, and
 * links render only through `ExternalLink` (https + host allow-list).
 */
import { ExternalLink } from "@/app/_components/ExternalLink";
import { WEEK_COPY } from "@/shared/copy";
import { safeExternalUrl } from "@/shared/safe-url";
import { formatItemTime, type WeekItem } from "@/shared/week";
import { DoneToggle } from "./DoneToggle";

function openLabel(item: WeekItem): string | null {
  if (item.source === "canvas") return WEEK_COPY.openCanvas;
  if (item.source === "gcal") return WEEK_COPY.openGoogle;
  return null;
}

function OpenLink({ item, allowHosts }: { item: WeekItem; allowHosts: readonly string[] }) {
  const text = openLabel(item);
  // An unsafe or off-list URL renders nothing (a dead "Open in Canvas" text would mislead).
  if (!text || !safeExternalUrl(item.url, allowHosts)) return null;
  return (
    <ExternalLink
      href={item.url}
      allowHosts={allowHosts}
      label={`${text}: ${item.title}`}
      className="inline-flex min-h-11 items-center text-sm font-semibold text-aria underline underline-offset-4"
    >
      {text}
    </ExternalLink>
  );
}

/**
 * A deadline (assignment/exam) with its toggle, due line, course, and open link.
 * @param props item, zone, link allow-list, and an optional prefix for the time line
 *   (e.g. the day label in "Still open")
 * @returns the row
 */
export function DeadlineRow({
  item,
  timeZone,
  allowHosts,
  whenPrefix,
}: {
  item: WeekItem;
  timeZone: string;
  allowHosts: readonly string[];
  whenPrefix?: string;
}) {
  const when = formatItemTime(item, timeZone);
  return (
    <li data-kind={item.kind}>
      <DoneToggle itemId={item.id} title={item.title} done={item.status === "done"}>
        <p className="break-words text-base font-semibold leading-snug group-data-[done=true]:text-ink-soft group-data-[done=true]:line-through">
          {item.title}
        </p>
        <p className="text-sm text-ink-soft">
          {whenPrefix ? `${whenPrefix} · ` : ""}
          {when}
          {item.course ? ` · ${item.course}` : ""}
        </p>
        <OpenLink item={item} allowHosts={allowHosts} />
      </DoneToggle>
    </li>
  );
}

/**
 * A schedule item (class, event, block): "10:30–11:45 AM · {title}" / "All day · {title}".
 * @param props item, zone, link allow-list
 * @returns the row
 */
export function ScheduleRow({
  item,
  timeZone,
  allowHosts,
}: {
  item: WeekItem;
  timeZone: string;
  allowHosts: readonly string[];
}) {
  return (
    <li data-kind={item.kind} className="flex flex-col">
      <p className="break-words text-base leading-snug">
        <span className="text-ink-soft">{formatItemTime(item, timeZone)} · </span>
        {item.title}
      </p>
      <OpenLink item={item} allowHosts={allowHosts} />
    </li>
  );
}
