/** /setup Schedule + Tone forms (task 4.4, web W4): server-rendered markup. */
import { renderToStaticMarkup } from "react-dom/server";
import { ScheduleForm, type ScheduleFormValues } from "@/app/(app)/setup/ScheduleForm";
import { ToneForm } from "@/app/(app)/setup/ToneForm";

jest.mock("@/app/(app)/setup/actions", () => ({
  saveScheduleAction: jest.fn(),
  saveTimezoneAction: jest.fn(),
  saveToneAction: jest.fn(),
}));

function schedule(over: Partial<ScheduleFormValues>): ScheduleFormValues {
  return {
    briefingTime: "08:00",
    briefingEnabled: true,
    briefingValue: "08:00",
    quietStart: "22:00",
    quietEnd: "08:00",
    timezone: "America/New_York",
    tzLabel: "Eastern Time",
    ...over,
  };
}

describe("ScheduleForm", () => {
  it("renders the selects with the saved values and the zone line", () => {
    const html = renderToStaticMarkup(<ScheduleForm schedule={schedule({ briefingValue: "09:00", briefingTime: "09:00" })} />);
    expect(html).toContain('id="briefing"');
    expect(html).toContain('id="quiet"');
    expect(html).toMatch(/<option value="09:00" selected="">9:00 AM<\/option>/);
    expect(html).toMatch(/<option value="22:00" selected="">10:00 PM<\/option>/);
    expect(html).toContain("Times are in Eastern Time.");
    expect(html).toContain("Don&#x27;t send a briefing");
    expect(html).not.toContain("inside quiet hours");
  });

  it("warns when the briefing time is inside quiet hours", () => {
    // 07:30 briefing, quiet 22:00–09:00 → arrives at 9:00 AM.
    const html = renderToStaticMarkup(
      <ScheduleForm schedule={schedule({ briefingValue: "07:30", briefingTime: "07:30", quietEnd: "09:00" })} />,
    );
    expect(html).toContain("Your briefing time is inside quiet hours, so it will arrive at 9:00 AM instead.");
  });

  it("never warns when the briefing is off", () => {
    const html = renderToStaticMarkup(
      <ScheduleForm schedule={schedule({ briefingEnabled: false, briefingValue: "off", quietEnd: "11:00" })} />,
    );
    expect(html).toMatch(/<option value="off" selected="">/);
    expect(html).not.toContain("inside quiet hours");
  });

  it("offers a stored off-list value (set in chat) so saving unchanged keeps it", () => {
    const html = renderToStaticMarkup(
      <ScheduleForm schedule={schedule({ briefingValue: "06:30", briefingTime: "06:30", quietStart: "23:30" })} />,
    );
    expect(html).toMatch(/<option value="06:30" selected="">6:30 AM<\/option>/);
    expect(html).toMatch(/<option value="23:30" selected="">11:30 PM<\/option>/);
  });

  it("does not show the time-zone switch during server render (browser zone unknown)", () => {
    const html = renderToStaticMarkup(<ScheduleForm schedule={schedule({ timezone: "Asia/Tokyo" })} />);
    expect(html).not.toContain("This phone is set to");
    expect(html).not.toContain('name="timezone"');
  });
});

describe("ToneForm", () => {
  it("checks the saved tone and shows each sample bubble", () => {
    const html = renderToStaticMarkup(<ToneForm tone="casual" />);
    expect(html).toContain('id="tone"');
    expect(html).toMatch(/<input id="tone-casual"[^>]*checked=""[^>]*value="casual"/);
    expect(html).not.toMatch(/<input id="tone-mirror"[^>]*checked=""/);
    expect(html).toContain("ok 3 things this week. pset is the big one, start tmr?");
    expect(html).toContain("Match me");
    expect(html).toContain("Polished");
    expect(html).toContain(">Save<");
  });
});
