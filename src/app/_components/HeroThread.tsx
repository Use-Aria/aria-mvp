/**
 * The landing hero: a real-shaped Aria conversation that plays in once.
 * Static markup + CSS delays (no JS); reduced motion shows it all at once.
 */

type Line =
  | { from: "me" | "aria"; text: string; tapback?: string }
  | { from: "typing" };

const THREAD: Line[] = [
  { from: "me", text: "what do i have this week" },
  { from: "typing" },
  {
    from: "aria",
    text: "3 things: CPSC 323 pset 4 wed 11:59pm, ECON 115 midterm thu 9am, essay draft fri",
  },
  { from: "aria", text: "you've got a 2hr gap tmr at 2, good for the pset" },
  { from: "me", text: "ok put it in my cal", tapback: "👍" },
  { from: "aria", text: "done, 2–4pm tmr ✅" },
];

const STEP_MS = 650;

export function HeroThread() {
  return (
    <div
      role="img"
      aria-label="Example conversation: a student asks Aria what's due this week, Aria lists three deadlines, suggests a free slot, and adds a study block to their calendar."
      className="flex w-full max-w-sm flex-col gap-1.5 text-[15px] leading-snug"
    >
      {THREAD.map((line, i) => {
        const style = { animationDelay: `${300 + i * STEP_MS}ms` };
        if (line.from === "typing") {
          return (
            <div
              key={i}
              aria-hidden
              style={style}
              className="typing-flash flex w-fit gap-1 rounded-[20px] bg-bubble px-4 py-3"
            >
              {[0, 1, 2].map((d) => (
                <span
                  key={d}
                  className="typing-dot size-2 rounded-full bg-ink-soft"
                  style={{ animationDelay: `${d * 160}ms` }}
                />
              ))}
            </div>
          );
        }
        const mine = line.from === "me";
        return (
          <div
            key={i}
            style={style}
            className={`bubble-in relative max-w-[82%] rounded-[20px] px-4 py-2 ${
              mine ? "self-end bg-aria text-aria-ink" : "self-start bg-bubble text-ink"
            } ${line.tapback ? "mt-4" : ""}`}
          >
            {line.text}
            {line.tapback && (
              <span
                aria-hidden
                className="absolute -left-3 -top-4 grid size-8 place-items-center rounded-full border-2 border-paper bg-bubble text-sm"
              >
                {line.tapback}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
