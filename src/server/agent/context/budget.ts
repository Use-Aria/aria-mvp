import "server-only";
// OWNER: 1.3

/**
 * Token estimates for context budgets (V2-04 §7.2 `context/budget.ts`). Pure.
 * `ceil(chars / 3)` is deliberately conservative for the Haiku 5.5 tokenizer, which counts the
 * same text as ~30% more tokens than older Claude tokenizers.
 */

/**
 * Conservative token estimate.
 * @param text any text
 * @returns `ceil(length / 3)` (0 for "")
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/**
 * Longest prefix of `lines` whose estimated size (joined with "\n") fits `maxTokens`.
 * Order is preserved, so callers sort first (most important line first) to keep output stable.
 * @param lines candidate lines, in priority order
 * @param maxTokens budget
 * @returns the kept prefix (never splits a line)
 */
export function clampLines(lines: readonly string[], maxTokens: number): string[] {
  const out: string[] = [];
  let chars = 0;
  for (const line of lines) {
    const next = chars + (out.length > 0 ? 1 : 0) + line.length;
    if (Math.ceil(next / 3) > maxTokens) break;
    out.push(line);
    chars = next;
  }
  return out;
}
