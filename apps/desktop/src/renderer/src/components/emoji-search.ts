import emojiData from "unicode-emoji-json/data-by-emoji.json";
import keywordData from "emojilib";

/**
 * The emoji tab's index and its search.
 *
 * Split out of the component because it is the part with behaviour: what "math" should return is a
 * question about the index, and answering it in a test that renders a popover means waiting on a
 * lazy chunk, a Suspense boundary and a 1,900-button grid to find out.
 *
 * IMPORT ONLY FROM `IconPickerEmoji.tsx`. Both datasets here are large (387KB + 270KB of JSON) and
 * live in that tab's lazy chunk on purpose; a static import from anywhere on IconPicker's own graph
 * puts the whole thing back into the startup bundle, which is the cost the split exists to avoid.
 * `icon-picker-emoji.test.tsx` asserts that.
 */
export type EmojiEntry = {
  name: string; slug: string; group: string;
  emoji_version: string; unicode_version: string; skin_tone_support: boolean;
};

export type EmojiRow = { char: string; entry: EmojiEntry };

/** `unicode-emoji-json` gives the display name, the slug and the category. What it does NOT give is
 *  the words a person actually types: nothing in it says a division sign has anything to do with
 *  "math", or that 🔢 is what you want when you type "numbers". `emojilib` is that missing layer —
 *  same author, same 1,914 characters, keyed by the character itself — and it is why searching for
 *  an intent rather than for Unicode's chosen noun now returns anything at all. */
const KEYWORDS = keywordData as Record<string, string[]>;

/** Lowercase word-splitting, shared by the index and the query so both sides tokenise identically.
 *  `_` and `-` are separators (slugs are snake_case, keywords are kebab-ish), and everything else
 *  non-alphanumeric goes with them — a query typed as "e-mail" and one typed as "e mail" are the
 *  same question. */
const words = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);

type Indexed = EmojiRow & {
  /** The display name's words, then the slug's — the strongest signal. */
  name: string[];
  /** emojilib's keywords, plus the category's words. What the thing is FOR, rather than called. */
  hint: string[];
  /** Everything above joined, for the substring fallback below. */
  text: string;
};

/** Built once, when the tab's chunk loads. First-appearance order, i.e. `unicode-emoji-json`'s own
 *  Unicode-recommended ordering — not alphabetical, which would scatter e.g. all the flags across
 *  the alphabet by country name. */
const INDEX: Indexed[] = Object.entries(emojiData as Record<string, EmojiEntry>).map(([char, entry]) => {
  const name = [...words(entry.name), ...words(entry.slug)];
  const hint = [...(KEYWORDS[char] ?? []).flatMap(words), ...words(entry.group)];
  return { char, entry, name, hint, text: [...name, ...hint].join(" ") };
});

export const EMOJI_GROUPS: string[] = Array.from(new Set(INDEX.map((r) => r.entry.group)));

/* How well one query word matches one emoji, lower being better. The tiers are the point: a word
 * PREFIX beats a substring, so typing "ice" no longer hands you the police officer (p-ol-ice) ahead
 * of ice cream, and a name beats a keyword, so "cat" leads with the cat rather than with everything
 * a cat has ever been associated with. A keyword the query matches WHOLE beats one it only begins,
 * which is the difference between "math" opening on ➗ ➕ 🧮 — each of which lists math itself — and
 * opening on the three scientists, who reach it through "mathematician". The substring tier is last
 * and deliberately kept: it is what the search used to be, and dropping it would make things that
 * were findable yesterday unfindable — "bow" would stop reaching the rainbow. */
const NAME_PREFIX = 0, HINT_EXACT = 1, HINT_PREFIX = 2, SUBSTRING = 6, NO_MATCH = Infinity;

const rank = (row: Indexed, token: string): number => {
  if (row.name.some((w) => w.startsWith(token))) return NAME_PREFIX;
  if (row.hint.includes(token)) return HINT_EXACT;
  if (row.hint.some((w) => w.startsWith(token))) return HINT_PREFIX;
  if (row.text.includes(token)) return SUBSTRING;
  return NO_MATCH;
};

/**
 * The rows to draw, in the order to draw them.
 *
 * Every query word must match something — narrowing is what a second word is FOR, and an "any word"
 * search turns "red heart" into every red thing followed by every heart. Within that, the emoji
 * whose own name carries the words comes first.
 */
export function searchEmoji(query: string, group: string | null = null): EmojiRow[] {
  const pool = group === null ? INDEX : INDEX.filter((r) => r.entry.group === group);
  const tokens = words(query);
  if (tokens.length === 0) return pool.map(({ char, entry }) => ({ char, entry }));

  const q = tokens.join(" ");
  const scored: { row: Indexed; score: number }[] = [];
  for (const row of pool) {
    let score = 0;
    for (const token of tokens) {
      const r = rank(row, token);
      if (r === NO_MATCH) { score = NO_MATCH; break; }
      score += r;
    }
    if (score === NO_MATCH) continue;
    // What the user typed IS the thing's name: "cat" must open on the cat, not on the cat face that
    // happens to sort earlier in Unicode. Whole-name equality outranks any accumulation of tiers.
    if (row.entry.name === q) score = -2;
    else if (row.name.join(" ").startsWith(q)) score -= 1;
    scored.push({ row, score });
  }
  // A stable sort on the score alone leaves Unicode's own order inside each tier, which is the order
  // the grid draws with no query at all — so a search re-ranks the grid rather than reshuffling it.
  return scored.sort((a, b) => a.score - b.score).map(({ row }) => ({ char: row.char, entry: row.entry }));
}
