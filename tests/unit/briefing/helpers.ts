/**
 * Fixtures for the briefing unit tests (task 4.1): timeline views built through the real `toView`
 * so labels, urgency scores and all-day dates match production.
 */
import { randomUUID } from "node:crypto";
import type { BriefingInputs } from "@/server/briefing/snapshot";
import { toView } from "@/server/timeline/view";
import type { TimelineItem, TimelineItemView, TimelineKind, TimelineSource } from "@/server/timeline/types";

export const NY = "America/New_York";
/** Mon Oct 12 2026, 08:00 EDT (the briefing time). */
export const MON_8AM = new Date("2026-10-12T12:00:00Z");
export const MIN = 60_000;
export const H = 60 * MIN;
export const D = 24 * H;

/** A stored item → read view at `now`. */
export function view(
  p: {
    kind: TimelineKind;
    title: string;
    course?: string | null;
    dueAt?: Date | null;
    startsAt?: Date | null;
    endsAt?: Date | null;
    allDay?: boolean;
    timingKey?: string | null;
    source?: TimelineSource;
    raw?: TimelineItem["raw"];
    id?: string;
  },
  now: Date = MON_8AM,
): TimelineItemView {
  const item: TimelineItem = {
    id: p.id ?? randomUUID(),
    userId: "u1",
    source: p.source ?? "canvas",
    externalId: `x-${Math.random()}`,
    kind: p.kind,
    title: p.title,
    course: p.course ?? null,
    startsAt: p.startsAt ?? null,
    endsAt: p.endsAt ?? null,
    dueAt: p.dueAt ?? null,
    allDay: p.allDay ?? false,
    url: null,
    timingKey: p.timingKey ?? null,
    matchKey: null,
    status: "upcoming",
    anchorAt: p.dueAt ?? p.startsAt ?? null,
    removedAt: null,
    updatedAt: now,
    raw: p.raw ?? null,
  };
  return toView(item, now, NY);
}

/** Inputs with sensible defaults (NY, 08:00 briefing, casual, Canvas connected). */
export function inputs(p: Partial<BriefingInputs> = {}): BriefingInputs {
  return {
    user: { name: null, tz: NY, briefingTime: { hour: 8, minute: 0 }, register: "casual" },
    now: MON_8AM,
    localDate: { year: 2026, month: 10, day: 12 },
    mode: "daily",
    items: [],
    notes: [],
    emails: [],
    busy: [],
    integrations: { canvas: true, google: false },
    proposal: null,
    ...p,
  };
}
