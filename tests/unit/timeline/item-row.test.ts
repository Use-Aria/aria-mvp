/**
 * `getTimelineItemRow` (Wave 5 task 5.3, 2.3 change request): the barrel exposes the stored item so
 * integrations (4.2's Aria calendar blocks) no longer import `timeline/store` directly.
 */
const mockGetItem = jest.fn();
jest.mock("@/server/timeline/store", () => ({ getItem: (...a: unknown[]) => mockGetItem(...a) }));
jest.mock("@/server/jobs/enqueue", () => ({ enqueueJob: jest.fn() }));

import { readFileSync } from "node:fs";
import path from "node:path";
import { getTimelineItemRow } from "@/server/timeline";

describe("getTimelineItemRow", () => {
  it("delegates to the owner-scoped store lookup and returns its result", async () => {
    const item = { id: "x", userId: "u", source: "aria", externalId: "evt1" };
    mockGetItem.mockResolvedValueOnce(item).mockResolvedValueOnce(null);
    await expect(getTimelineItemRow("u", "x")).resolves.toBe(item);
    await expect(getTimelineItemRow("u", "missing")).resolves.toBeNull();
    expect(mockGetItem.mock.calls).toEqual([
      ["u", "x"],
      ["u", "missing"],
    ]);
  });

  it("nothing outside src/server/timeline imports timeline/store any more", () => {
    const file = path.join(process.cwd(), "src/server/integrations/google/calendar/aria-calendar.ts");
    expect(readFileSync(file, "utf8")).not.toMatch(/timeline\/store/);
  });
});
