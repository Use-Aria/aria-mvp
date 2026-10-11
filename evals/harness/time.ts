/**
 * Local-time helpers for fixtures (DST-safe, via the production tz module).
 */
import { addLocalDays, localDateOf, zonedToUtc, type LocalDate } from "@/shared/time/tz";

/**
 * An instant at a local wall-clock time, `days` local days from today.
 * @param tz IANA zone
 * @param days 0 = today, 1 = tomorrow, …
 * @param hour local hour
 * @param minute local minute
 * @returns the instant
 */
export function localAt(tz: string, days: number, hour: number, minute = 0): Date {
  const d: LocalDate = addLocalDays(localDateOf(new Date(), tz), days);
  return zonedToUtc({ ...d, hour, minute }, tz).instant;
}

/**
 * Local hour and date offset (from today) of an instant.
 * @param instant the time
 * @param tz IANA zone
 * @returns { daysFromToday, hour, minute }
 */
export function localParts(instant: Date, tz: string): { daysFromToday: number; hour: number; minute: number } {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" });
  const parts = Object.fromEntries(f.formatToParts(instant).map((p) => [p.type, p.value]));
  const a = localDateOf(new Date(), tz);
  const b = localDateOf(instant, tz);
  const days = Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
  return { daysFromToday: days, hour: Number(parts.hour), minute: Number(parts.minute) };
}
