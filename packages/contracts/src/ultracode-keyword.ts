/** Each character that opens a span in Claude Code's scanner, with the character that closes it. */
const CLOSER: Record<string, string> = { "`": "`", '"': '"', "<": ">", "{": "}", "[": "]", "(": ")", "'": "'" };

/** Whether a character is a letter, a digit or an underscore, by Unicode's classes. The scanner asks
 *  it of the characters beside a straight single quote and of the one after a dot. No character at
 *  all, as at either end of the text, is not one. */
const wordy = (c: string | undefined): boolean => !!c && /[\p{L}\p{N}_]/u.test(c);

/**
 * Where the word `ultracode` stands in a text so that Claude Code will act on it: each hit as
 * `{ start, end }`, in UTF-16 indexes of the text, the end exclusive.
 *
 * This mirrors Claude Code's own scanner, read from the 2.1.293 binary, rule for rule. Claude Code
 * runs that scanner over a message a person sent, and one hit is enough for it to plan the turn as
 * a workflow of sub-agents. A prompter that says so while the person types has to say it in exactly
 * the cases the binary acts on, so nothing here is tidied. A rule that reads like an oversight is a
 * rule the binary has.
 *
 * The rules:
 *
 * - A hit is a match of `\bultracode\b`, in any letter case. The boundary is JavaScript's plain one.
 *   A letter from A to Z, a digit from 0 to 9 or an underscore beside the word joins it, and no
 *   other character does, an accented letter included.
 * - A text whose first character is `/` has no hit. The text is not trimmed first.
 * - A hit that starts inside a closed span does not count. A span opens at a backtick, a straight
 *   double quote, `(`, `[`, `{`, a `<` that a letter from A to Z or a `/` follows, or a straight
 *   single quote that no letter, digit or underscore stands before. It closes at the same quote or
 *   backtick, or at `)`, `]`, `}` or `>`, and a straight single quote closes one only where no
 *   letter, digit or underscore follows it. So an apostrophe inside a word is no quote, and
 *   typographic quotes open nothing.
 * - Spans do not nest. While one is open, every character but its closer is passed over, another
 *   opener included. The one exception is `[` inside an open `[`, which moves the start of the span
 *   to itself.
 * - An opener that never closes spans nothing, and it has passed over every opener after it.
 * - A hit right after `/`, `\` or `-` does not count, and neither does one right before `/`, `\`,
 *   `-` or `?`.
 * - A hit followed by a dot and then a letter, a digit or an underscore does not count.
 *
 * Beside a straight single quote and after a dot, a letter or a digit is whatever Unicode classes
 * as one, where the word's own boundary knows only A to Z and 0 to 9.
 *
 * The table in `ultracode-keyword.test.ts` is what the real 2.1.293 binary did with 226 texts, each
 * sent as a person's message: whether it added its note about a workflow. This function agrees with
 * every row, and a change here has to keep doing so. `live-ultracode-check.ts` in the server's
 * scripts asks the real binary again, which is the check to run when the Agent SDK is bumped.
 */
export function scanUltracodeKeyword(text: string): { start: number; end: number }[] {
  if (!/ultracode/i.test(text)) return [];
  if (text.startsWith("/")) return [];
  const spans: { start: number; end: number }[] = [];
  let open: string | null = null;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (open) {
      if (open === "[" && c === "[") { from = i; continue; }
      if (c !== CLOSER[open]) continue;
      if (open === "'" && wordy(text[i + 1])) continue;
      spans.push({ start: from, end: i + 1 });
      open = null;
    } else if ((c === "<" && i + 1 < text.length && /[a-zA-Z/]/.test(text[i + 1]!)) || (c === "'" && !wordy(text[i - 1])) || (c !== "<" && c !== "'" && c in CLOSER)) {
      open = c;
      from = i;
    }
  }
  const hits: { start: number; end: number }[] = [];
  for (const m of text.matchAll(/\bultracode\b/gi)) {
    const start = m.index;
    const end = start + m[0].length;
    if (spans.some((s) => start >= s.start && start < s.end)) continue;
    const before = text[start - 1];
    const after = text[end];
    if (before === "/" || before === "\\" || before === "-") continue;
    if (after === "/" || after === "\\" || after === "-" || after === "?") continue;
    if (after === "." && wordy(text[end + 1])) continue;
    hits.push({ start, end });
  }
  return hits;
}
