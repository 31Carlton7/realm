import { describe, expect, it } from "vitest";
import { searchEmoji } from "./emoji-search";

/** The characters a query returns, in the order the grid would draw them. */
const chars = (q: string, group: string | null = null): string[] => searchEmoji(q, group).map((r) => r.char);
/** Where a character lands in the results — -1 when the query does not reach it at all. */
const rankOf = (q: string, char: string): number => chars(q).indexOf(char);

/* The search used to be `name.includes(q) || slug.includes(q)` over `unicode-emoji-json`, which is
 * a substring test against the noun Unicode happens to have chosen. That answers "what is this
 * called" and the box is asked "what am I looking for" — so "math" returned NOTHING, while ➗ sat
 * there named "divide". These are the queries that failed, kept as the record of why the keyword
 * layer is here. */
describe("searching emoji by what they are for", () => {
  it("finds the arithmetic on 'math', which matched nothing at all before", () => {
    const r = chars("math");
    expect(r.length).toBeGreaterThan(0);
    for (const c of ["➗", "➕", "➖", "✖️", "🧮"]) expect(r, c).toContain(c);
  });

  it("finds the digits on 'number' and 'numbers' alike", () => {
    for (const q of ["number", "numbers"]) {
      const r = chars(q);
      for (const c of ["🔢", "1️⃣", "🔟"]) expect(r, `${q} → ${c}`).toContain(c);
    }
  });

  it("answers the other intent words a person types at an icon picker", () => {
    const wanted: [string, string[]][] = [
      ["money", ["💰", "💸"]],
      ["code", ["🧑‍💻"]],
      ["school", ["🎓", "🏫"]],
      ["time", ["⏰", "⌛"]],
      ["music", ["🎵", "🎸"]],
      ["rocket", ["🚀"]],
      ["warning", ["⚠️"]],
    ];
    for (const [q, want] of wanted) for (const c of want) expect(chars(q), `${q} → ${c}`).toContain(c);
  });
});

describe("the ranking", () => {
  it("leads with the emoji the query NAMES, not with whatever Unicode ordered first", () => {
    // 🚀 is "rocket"; 🧑‍🚀 "astronaut" merely keeps rockets as a keyword and sorts earlier in the file.
    expect(chars("rocket")[0]).toBe("🚀");
    // 🐱 is "cat face" and 🐈 is "cat" — the exact name wins even though the face comes first.
    expect(chars("cat")[0]).toBe("🐈");
  });

  it("puts a word-prefix match ahead of a match buried inside a word", () => {
    // "police" contains "ice". The old substring search offered the officer alongside the ice cream;
    // this one keeps the officer reachable but behind everything actually named ice.
    expect(rankOf("ice", "🍦")).toBeLessThan(rankOf("ice", "👮"));
    expect(rankOf("ice", "👮")).toBeGreaterThan(-1);
  });

  it("puts a whole keyword ahead of one the query only begins", () => {
    // ➗ ➕ 🧮 each list "math" itself; the three scientists reach it through "mathematician", and a
    // plain prefix rule opened the search on them because they sort earlier in Unicode.
    for (const c of ["➗", "➕", "🧮"]) expect(rankOf("math", c), c).toBeLessThan(rankOf("math", "🧑‍🔬"));
    expect(rankOf("math", "🧑‍🔬"), "the mathematician is still reachable").toBeGreaterThan(-1);
  });

  it("puts a name match ahead of a keyword match", () => {
    // 🎂 is named "birthday cake"; 🎉 only carries birthday as a keyword.
    expect(rankOf("birthday", "🎂")).toBeLessThan(rankOf("birthday", "🎉"));
  });

  it("keeps Unicode's own order inside a tier, so a query re-ranks the grid rather than shuffling it", () => {
    // The twelve hour marks all match "o'clock" the same way — nothing separates them but the order
    // they were dealt, and a sort that was not stable would deal them back in some other one.
    const unicode = chars("");
    const clocks = chars("o'clock").filter((c) => unicode.indexOf(c) > -1 && /^\S+ o’clock$|^\S+ o'clock$/.test(
      searchEmoji("o'clock").find((r) => r.char === c)!.entry.name));
    expect(clocks.length).toBeGreaterThanOrEqual(12);
    expect(clocks).toEqual(clocks.slice().sort((a, b) => unicode.indexOf(a) - unicode.indexOf(b)));
  });
});

describe("multi-word queries", () => {
  it("narrows with each word instead of widening — every word must match", () => {
    const red = chars("red heart");
    expect(red).toContain("❤️");
    // 💛 is a heart and 🚗 is red, but neither is a red heart.
    expect(red).not.toContain("💛");
    expect(red.length).toBeLessThan(chars("heart").length);
  });

  it("matches words typed in any order, and by their beginnings", () => {
    expect(chars("face grin")).toContain("😀");
    expect(chars("grin fac")).toContain("😀");
  });

  it("treats punctuation and separators as spaces, so a slug and a phrase are one question", () => {
    for (const q of ["flexed biceps", "flexed_biceps", "flexed-biceps"]) expect(chars(q), q).toContain("💪");
  });
});

describe("what the search leaves alone", () => {
  it("returns the whole set in Unicode order when nothing is typed", () => {
    const all = searchEmoji("");
    expect(all).toHaveLength(1914);
    expect(all[0]!.char).toBe("😀");
  });

  it("respects the category filter, with and without a query", () => {
    const flags = searchEmoji("", "Flags");
    expect(flags.length).toBeGreaterThan(200);
    expect(flags.every((r) => r.entry.group === "Flags")).toBe(true);
    // "cat" reaches a flag only through the category it is confined to.
    expect(chars("cat", "Flags").every((c) => searchEmoji("", "Flags").some((r) => r.char === c))).toBe(true);
    expect(chars("cat", "Flags")).not.toContain("🐈");
  });

  it("still finds nothing for a query that is nothing", () => {
    expect(chars("zzzznotanemoji")).toEqual([]);
  });
});
