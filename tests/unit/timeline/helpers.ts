/** Shared builders for timeline unit tests (not a test file). */
import type { TimelineItem, TimelineItemInput } from "@/server/timeline/types";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const NOW = new Date("2026-10-14T16:00:00Z"); // Wed Oct 14, 12:00 EDT

let seq = 0;

/** Deterministic uuid-shaped id with a chosen 8-hex prefix. */
export function uid(prefix8?: string): string {
  seq += 1;
  const p = prefix8 ?? (0xa0000000 + seq).toString(16);
  return `${p}-0000-4000-8000-${seq.toString(16).padStart(12, "0")}`;
}

/** Instant `h` hours from NOW. */
export function at(h: number): Date {
  return new Date(NOW.getTime() + h * HOUR);
}

/** Stored item builder (assignment due in 48h by default). */
export function row(p: Partial<TimelineItem> & { externalId: string }): TimelineItem {
  const dueAt = p.dueAt === undefined ? at(48) : p.dueAt;
  const startsAt = p.startsAt ?? null;
  return {
    id: p.id ?? uid(),
    userId: "u1",
    source: p.source ?? "canvas",
    externalId: p.externalId,
    kind: p.kind ?? "assignment",
    title: p.title ?? "Pset 4",
    course: p.course === undefined ? "CPSC 323 01 (FA26)" : p.course,
    startsAt,
    endsAt: p.endsAt ?? null,
    dueAt,
    allDay: p.allDay ?? false,
    url: p.url ?? null,
    timingKey: p.timingKey === undefined ? ((dueAt ?? startsAt)?.toISOString() ?? null) : p.timingKey,
    matchKey: p.matchKey ?? null,
    status: p.status ?? "upcoming",
    anchorAt: p.anchorAt ?? dueAt ?? startsAt,
    removedAt: p.removedAt ?? null,
    updatedAt: NOW,
    raw: p.raw ?? null,
  };
}

/** Fresh input mirroring a stored row (same values → unchanged). */
export function input(r: TimelineItem, over: Partial<TimelineItemInput> = {}): TimelineItemInput {
  return {
    externalId: r.externalId,
    kind: r.kind,
    title: r.title,
    course: r.course,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    dueAt: r.dueAt,
    allDay: r.allDay,
    url: r.url,
    timingKey: r.timingKey ?? undefined,
    matchKey: r.matchKey,
    raw: r.raw,
    ...over,
  };
}
