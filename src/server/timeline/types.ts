import "server-only";
// OWNER: 0.2 (frozen contract; only the orchestrator edits this file — master plan §1.0.2)

/**
 * Timeline contract types (master plan §1.9 = V2-05 §7.3 `types.ts` verbatim, plus `TimelineLike`).
 * `JsonValue` is the canonical JSON type for the server (pending actions, llm meta, briefing notes).
 */
import { z } from "zod";

export type TimelineSource = "canvas" | "gcal" | "gmail" | "syllabus" | "aria";
export type TimelineKind = "assignment" | "exam" | "event" | "class" | "block";
export type TimelineStatus = "upcoming" | "done" | "dismissed";
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/** Writer input. Optional fields default as noted (V2-07/V2-08 `TimelineUpsert` is this type). */
export interface TimelineItemInput {
  externalId: string;
  kind: TimelineKind;
  title: string;
  course?: string | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  dueAt?: Date | null;
  /** default false */
  allDay?: boolean;
  url?: string | null;
  /** default: ISO of (dueAt ?? startsAt); change ⇒ due_changed */
  timingKey?: string;
  /** default null */
  matchKey?: string | null;
  raw?: { [k: string]: JsonValue } | null;
}
/** V2-08 passes source per item. */
export type TimelineUpsert = TimelineItemInput & { source?: TimelineSource };

export interface TimelineItem {
  id: string;
  userId: string;
  source: TimelineSource;
  externalId: string;
  kind: TimelineKind;
  title: string;
  course: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  dueAt: Date | null;
  allDay: boolean;
  url: string | null;
  timingKey: string | null;
  matchKey: string | null;
  status: TimelineStatus;
  anchorAt: Date | null;
  removedAt: Date | null;
  updatedAt: Date;
  raw: { [k: string]: JsonValue } | null;
}
export type Urgency = "overdue" | "now" | "today" | "soon" | "this_week" | "later" | "past";
/** Read view (V2-04 TimelineItemView ∪ web TimelineViewItem). Dates are Date; tools serialize. */
export interface TimelineItemView {
  id: string;
  /** "t_" + first 8 hex of id */
  ref: string;
  source: TimelineSource;
  kind: TimelineKind;
  title: string;
  course: string | null;
  courseKey: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  dueAt: Date | null;
  allDay: boolean;
  /** floating "YYYY-MM-DD" from timing_key / local date */
  allDayDate: string | null;
  url: string | null;
  status: TimelineStatus;
  urgency: Urgency;
  urgencyScore: number;
  hoursUntil: number | null;
  /** formatForChat(anchor, tz, now, {allDay}) */
  label: string;
  /** attached by collapseSyllabusDuplicates */
  syllabus?: { weight_pct: number | null; topics: string[] };
}

/** The fields V2-08's `collapseSyllabusDuplicates` reads (master plan §1.9). */
export type TimelineLike = Pick<
  TimelineItemView,
  "source" | "kind" | "title" | "course" | "dueAt" | "startsAt" | "allDay" | "allDayDate"
>;

/** Change batch — V2-06's contract, extended with optional V2-05 fields. */
export const TimelineChangeSchema = z.object({
  itemId: z.uuid(),
  kind: z.enum(["created", "due_changed", "status_changed", "removed"]),
  source: z.enum(["canvas", "gcal", "syllabus", "aria", "gmail"]),
  itemKind: z.enum(["assignment", "exam", "event", "class", "block"]),
  title: z.string().nullable(),
  course: z.string().nullable(),
  /** anchor = due_at ?? starts_at */
  oldDueAt: z.iso.datetime().nullable(),
  newDueAt: z.iso.datetime().nullable(),
  status: z.enum(["upcoming", "done", "dismissed"]),
  allDay: z.boolean().optional(),
  // V2-05 extensions (optional for consumers)
  externalId: z.string().optional(),
  restored: z.boolean().optional(),
  rekeyed: z.boolean().optional(),
  deliveryHint: z.enum(["immediate", "briefing", "none"]).optional(),
});
/** One committed write's changes (`timeline_changes` job payload). */
export const TimelineChangeBatchSchema = z.object({
  initial: z.boolean(),
  changes: z.array(TimelineChangeSchema).max(5000),
});
export type TimelineChange = z.infer<typeof TimelineChangeSchema>;
export type TimelineChangeBatch = z.infer<typeof TimelineChangeBatchSchema>;
export type Delivery = "immediate" | "briefing" | "none";

export interface SnapshotScope {
  externalIdPrefix?: string;
  windowStart?: Date;
  windowEnd?: Date;
}
export interface ApplyResult {
  created: number;
  updated: number;
  dueChanged: number;
  removed: number;
  restored: number;
  rekeyed: number;
  unchanged: number;
  removalsDeferred: number;
  batch: TimelineChangeBatch;
}
export interface DayLoad {
  date: string;
  count: number;
  examCount: number;
  level: "light" | "busy" | "heavy";
}
