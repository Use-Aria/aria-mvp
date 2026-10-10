import "server-only";
// OWNER: 4.2
/* eslint-disable @typescript-eslint/no-unused-vars -- Wave 0 stub: params unused until 4.2 lands */

/**
 * Busy intervals for slot finding and briefing suggestions (V2-07 §7.2 `calendar/busy.ts`). Wave 0 stub.
 */

/** Half-open time interval [start, end). (`calendar/slots.ts` reuses this type.) */
export interface Interval {
  start: Date;
  end: Date;
}

/**
 * Union of busy time across Google calendars, non-gcal timeline items and class times.
 * @param userId owner
 * @param from window start
 * @param to window end
 * @returns merged busy intervals and how many calendars were checked (Wave 0: none)
 */
export async function readBusy(userId: string, from: Date, to: Date): Promise<{ busy: Interval[]; calendarsChecked: number }> {
  return { busy: [], calendarsChecked: 0 };
}
