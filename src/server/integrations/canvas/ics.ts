import "server-only";
// OWNER: 1.4

/**
 * iCalendar lexer (V2-05 §2.2, §7.2 `ics.ts`). ical.js is used only as a structure parser; values
 * come out as our own {@link IcsDateValue} literals and all instant math lives in `parse.ts` via
 * `src/shared/time/tz.ts`. Swapping the library touches only this file.
 *
 * RFC 5545 folds at 75 *octets*, which can split a multi-byte character, so lines are unfolded at
 * the byte level before UTF-8 decoding.
 */
import ICAL from "ical.js";

/** Wall-clock fields of a DATE-TIME literal (`month` 1–12). */
export interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** A DTSTART/DTEND literal, kept in its source form. */
export type IcsDateValue =
  | { kind: "date"; year: number; month: number; day: number }
  | { kind: "utc"; iso: string }
  | { kind: "zoned"; tzid: string; wall: Wall; utcFromVtimezone: string | null }
  | { kind: "floating"; wall: Wall };

/** One VEVENT, text values unescaped. */
export interface IcsEvent {
  uid: string | null;
  summary: string;
  dtstart: IcsDateValue | null;
  dtend: IcsDateValue | null;
  url: string | null;
  description: string | null;
  dtstamp: string | null;
}

/** A lexed VCALENDAR. `parseWarnings` counts VEVENTs (or values) that could not be read. */
export interface IcsCalendar {
  prodid: string | null;
  calName: string | null;
  events: IcsEvent[];
  parseWarnings: number;
}

/** Input is not an iCalendar document. */
export class IcsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IcsParseError";
  }
}

type ICALComponent = InstanceType<typeof ICAL.Component>;
type ICALTimezone = InstanceType<typeof ICAL.Timezone>;

/**
 * Byte-level unfold → UTF-8 decode → ical.js → {@link IcsCalendar}.
 * If the whole document fails to parse, each VEVENT is parsed on its own and bad ones are skipped
 * (counted in `parseWarnings`), so one malformed event can't hide a whole feed.
 * @param bytes raw response body
 * @returns calendar header fields and events in file order
 * @throws IcsParseError when the input isn't a VCALENDAR
 */
export function lexIcs(bytes: Uint8Array): IcsCalendar {
  const text = new TextDecoder("utf-8").decode(unfoldBytes(stripBom(bytes)));
  const body = text.replace(/^[\s﻿]+/, "");
  if (!/^BEGIN:VCALENDAR\r?\n/i.test(body)) throw new IcsParseError("not an iCalendar document");

  let root: ICALComponent;
  let parseWarnings = 0;
  try {
    root = new ICAL.Component(ICAL.parse(body));
  } catch {
    const salvaged = parseEventByEvent(body);
    if (!salvaged) throw new IcsParseError("unparseable iCalendar document");
    root = salvaged.root;
    parseWarnings += salvaged.failed;
  }
  if (root.name !== "vcalendar") throw new IcsParseError("not an iCalendar document");

  const zones = new Map<string, ICALTimezone>();
  for (const vtz of root.getAllSubcomponents("vtimezone")) {
    try {
      const tz = new ICAL.Timezone(vtz);
      if (tz.tzid) zones.set(tz.tzid, tz);
    } catch {
      parseWarnings++;
    }
  }

  const events: IcsEvent[] = [];
  for (const ev of root.getAllSubcomponents("vevent")) {
    try {
      events.push(readEvent(ev, zones));
    } catch {
      parseWarnings++;
    }
  }

  return {
    prodid: textProp(root, "prodid"),
    calName: textProp(root, "x-wr-calname"),
    events,
    parseWarnings,
  };
}

/**
 * Change-detection key from the source literal (never from a derived instant).
 * @param v a DTSTART literal
 * @returns "D:20261015" | "U:20261016T035900Z" | "Z:<tzid>:20261015T170000" | "F:20261015T170000"
 */
export function timingKeyOf(v: IcsDateValue): string {
  switch (v.kind) {
    case "date":
      return `D:${ymd(v.year, v.month, v.day)}`;
    case "utc":
      return `U:${v.iso.replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "")}`;
    case "zoned":
      return `Z:${v.tzid}:${compactWall(v.wall)}`;
    case "floating":
      return `F:${compactWall(v.wall)}`;
  }
}

// ── internals ───────────────────────────────────────────────────────────────

function stripBom(b: Uint8Array): Uint8Array {
  return b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? b.subarray(3) : b;
}

/** Removes CRLF/LF followed by a single SP or HTAB (RFC 5545 §3.1), on bytes. */
function unfoldBytes(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length);
  let o = 0;
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c === 0x0d && b[i + 1] === 0x0a && (b[i + 2] === 0x20 || b[i + 2] === 0x09)) {
      i += 2;
      continue;
    }
    if (c === 0x0a && (b[i + 1] === 0x20 || b[i + 1] === 0x09)) {
      i += 1;
      continue;
    }
    out[o++] = c;
  }
  return out.subarray(0, o);
}

/** Fallback: header + each VTIMEZONE/VEVENT block parsed separately. Null if even the header fails. */
function parseEventByEvent(text: string): { root: ICALComponent; failed: number } | null {
  const lines = text.split(/\r?\n/);
  const header: string[] = [];
  const zones: string[][] = [];
  const events: string[][] = [];
  let block: string[] | null = null;
  let blockKind: "vevent" | "vtimezone" | null = null;
  let depth = 0;
  for (const line of lines) {
    const upper = line.toUpperCase();
    if (block) {
      block.push(line);
      if (upper.startsWith("BEGIN:")) depth++;
      else if (upper.startsWith("END:")) {
        depth--;
        if (depth === 0) {
          (blockKind === "vevent" ? events : zones).push(block);
          block = null;
          blockKind = null;
        }
      }
      continue;
    }
    if (upper === "BEGIN:VEVENT" || upper === "BEGIN:VTIMEZONE") {
      block = [line];
      blockKind = upper === "BEGIN:VEVENT" ? "vevent" : "vtimezone";
      depth = 1;
      continue;
    }
    if (upper === "END:VCALENDAR" || line.trim() === "") continue;
    header.push(line);
  }
  let root: ICALComponent;
  try {
    root = new ICAL.Component(ICAL.parse([...header, "END:VCALENDAR"].join("\r\n")));
  } catch {
    return null;
  }
  let failed = 0;
  for (const [kind, blocks] of [["vtimezone", zones], ["vevent", events]] as const) {
    for (const lines2 of blocks) {
      try {
        const doc = new ICAL.Component(ICAL.parse(["BEGIN:VCALENDAR", ...lines2, "END:VCALENDAR"].join("\r\n")));
        const sub = doc.getFirstSubcomponent(kind);
        if (sub) root.addSubcomponent(sub);
        else failed++;
      } catch {
        failed++;
      }
    }
  }
  return { root, failed };
}

function readEvent(ev: ICALComponent, zones: Map<string, ICALTimezone>): IcsEvent {
  return {
    uid: nonEmpty(textProp(ev, "uid")),
    summary: textProp(ev, "summary") ?? "",
    dtstart: dateProp(ev, "dtstart", zones),
    dtend: dateProp(ev, "dtend", zones),
    url: nonEmpty(textProp(ev, "url")),
    description: nonEmpty(textProp(ev, "description")),
    dtstamp: stampProp(ev),
  };
}

/** First value of a property as a string (text, uri, or anything with a string form). */
function textProp(c: ICALComponent, name: string): string | null {
  const prop = c.getFirstProperty(name);
  if (!prop) return null;
  const v: unknown = prop.getFirstValue();
  if (v === null || v === undefined) return null;
  return typeof v === "string" ? v : String(v);
}

function stampProp(c: ICALComponent): string | null {
  const prop = c.getFirstProperty("dtstamp");
  if (!prop) return null;
  const v: unknown = prop.getFirstValue();
  if (v instanceof ICAL.Time) return v.toString();
  return typeof v === "string" ? v : null;
}

function dateProp(c: ICALComponent, name: string, zones: Map<string, ICALTimezone>): IcsDateValue | null {
  const prop = c.getFirstProperty(name);
  if (!prop) return null;
  // Read the literal from jCal: ical.js's Time silently normalizes out-of-range fields (month 13 → next year).
  const raw: unknown = prop.jCal[3];
  if (typeof raw !== "string") throw new Error("missing date value");
  return toDateValue(raw.trim(), prop.getParameter("tzid"), zones);
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z?)$/;

function toDateValue(raw: string, tzidParam: unknown, zones: Map<string, ICALTimezone>): IcsDateValue {
  const d = DATE_RE.exec(raw);
  if (d) {
    const [year, month, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
    if (!validDate(year, month, day)) throw new Error("invalid date");
    return { kind: "date", year, month, day };
  }
  const m = DATE_TIME_RE.exec(raw);
  if (!m) throw new Error("invalid date-time");
  const wall: Wall = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: Number(m[6]),
  };
  if (!validDate(wall.year, wall.month, wall.day) || wall.hour > 23 || wall.minute > 59 || wall.second > 60) {
    throw new Error("invalid date-time");
  }
  const isoUtc = `${ymdDash(wall)}T${hms(wall)}Z`;
  if (m[7] === "Z") return { kind: "utc", iso: isoUtc };

  const tzid = (Array.isArray(tzidParam) ? String(tzidParam[0] ?? "") : typeof tzidParam === "string" ? tzidParam : "").trim();
  if (tzid === "") return { kind: "floating", wall };
  if (/^(?:UTC|Etc\/UTC|Z|GMT)$/i.test(tzid)) return { kind: "utc", iso: isoUtc };

  const zone = zones.get(tzid);
  let utcFromVtimezone: string | null = null;
  if (zone) {
    try {
      const local = ICAL.Time.fromData({ ...wall, isDate: false }, zone);
      const ms = local.toUnixTime() * 1000;
      if (Number.isFinite(ms)) utcFromVtimezone = new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
    } catch {
      utcFromVtimezone = null;
    }
  }
  return { kind: "zoned", tzid, wall, utcFromVtimezone };
}

function validDate(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return false;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= daysInMonth;
}

function nonEmpty(s: string | null): string | null {
  return s === null || s.trim() === "" ? null : s;
}

function p2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function ymd(y: number, m: number, d: number): string {
  return `${y}${p2(m)}${p2(d)}`;
}

function ymdDash(w: Wall): string {
  return `${w.year}-${p2(w.month)}-${p2(w.day)}`;
}

function hms(w: Wall): string {
  return `${p2(w.hour)}:${p2(w.minute)}:${p2(w.second)}`;
}

function compactWall(w: Wall): string {
  return `${ymd(w.year, w.month, w.day)}T${p2(w.hour)}${p2(w.minute)}${p2(w.second)}`;
}
