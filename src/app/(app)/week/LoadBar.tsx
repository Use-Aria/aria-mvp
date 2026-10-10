/**
 * Load meter for a day or the week (web plan §2.5): three segments plus a visible text
 * label, so the level never depends on color alone. OWNER: 4.4.
 */
import type { LoadLevel } from "@/shared/week";

const FILLED: Record<LoadLevel, number> = { light: 1, busy: 2, heavy: 3 };
const FILL_CLASS: Record<LoadLevel, string> = {
  light: "bg-load-light",
  busy: "bg-load-busy",
  heavy: "bg-load-heavy",
};

/**
 * @param props level, the points behind it (exposed as a data attribute), and the text label
 *   (e.g. "Busy day: 2 things due"), which is both shown and used as the accessible name
 * @returns the meter
 */
export function LoadBar({ level, points, label }: { level: LoadLevel; points: number; label: string }) {
  return (
    <div role="img" aria-label={label} data-level={level} data-points={points} className="flex items-center gap-2">
      <span aria-hidden="true" className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={`h-1.5 w-5 rounded-full ${i < FILLED[level] ? FILL_CLASS[level] : "bg-line"}`}
          />
        ))}
      </span>
      <span aria-hidden="true" className="text-sm text-ink-soft">
        {label}
      </span>
    </div>
  );
}
