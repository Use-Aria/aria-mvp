import "server-only";
// OWNER: 1.3

/**
 * Token estimates for context budgets (V2-04 §7.2 `context/budget.ts`). Pure.
 * `ceil(chars / 2.3)`: the Haiku 5.5 tokenizer counts ~30% more tokens than older Claude
 * tokenizers, so the earlier chars/3 undercounted by ~30% (measured in Wave 2, task 2.2).
 */

/** Tokens for `chars` characters at 2.3 chars/token (integer math: no float drift at exact multiples). */
const tokensForChars = (chars: number): number => Math.ceil((chars * 10) / 23);

/**
 * Conservative token estimate.
 * @param text any text
 * @returns `ceil(length / 2.3)` (0 for "")
 */
export function estimateTokens(text: string): number {
  return tokensForChars(text.length);
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
    if (tokensForChars(next) > maxTokens) break;
    out.push(line);
    chars = next;
  }
  return out;
}
