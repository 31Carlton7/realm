import { describe, expect, it } from "vitest";
import { scanMentions, stripMentionAts } from "@realm/contracts";
import { continueList, deleteElementChipBefore, highlightSegments, indentList, listItemAt, toggleList, type Segment } from "./draft-format";

/** A compact readout of the runs that carry a class — plain text is the uninteresting majority. */
const painted = (segs: Segment[]) => segs.filter((s) => s.kind).map((s) => [s.kind, s.text]);
/** Every run concatenated. The mirror draws these in order, so this MUST equal the draft exactly. */
const rejoin = (segs: Segment[]) => segs.map((s) => s.text).join("");

describe("highlightSegments — the mirror paints the draft, never a version of it", () => {
  /* The invariant the whole mirror rests on: the runs are a partition of the string. Drop a
     character and every glyph after it on that line sits one column off the caret above it. */
  it("covers the draft exactly, character for character", () => {
    for (const text of [
      "", "hello", "https://piazza.com/usc", "@mac and `code` and **bold**",
      "- one\n- two\n\n> quote\n# head\n1. first",
      "trailing newline\n", "\n\n", "  - indented @mac https://x.dev/a?b=1 end",
      "*", "**", "``", "@", "- ", "https://",
      '@[button "Sign in"]', 'a @[div#hero] b', "@[", "@[]", '@[link https://x.dev] tail', "@[a\nb]",
    ]) {
      expect(rejoin(highlightSegments(text, ["mac"])), JSON.stringify(text)).toBe(text);
    }
  });

  it("paints an element chip as one run, brackets included", () => {
    expect(painted(highlightSegments('make @[button "Sign in"] blue', []))).toEqual([
      ["element", '@[button "Sign in"]'],
    ]);
  });

  it("a URL inside a chip's label does not cut the token in half", () => {
    // The label is arbitrary page text. A link span winning here would paint half a chip and leave
    // the closing bracket looking like prose.
    expect(painted(highlightSegments("@[link https://x.dev]", []))).toEqual([["element", "@[link https://x.dev]"]]);
  });

  it("an unclosed chip is plain text, not a chip that eats the rest of the draft", () => {
    expect(painted(highlightSegments("@[button and more", []))).toEqual([]);
  });

  it("paints an element chip and a mention in the same draft", () => {
    expect(painted(highlightSegments("@mac look at @[div#hero]", ["mac"]))).toEqual([
      ["mention", "@mac"], ["element", "@[div#hero]"],
    ]);
  });

  it("paints URLs, and stops where the URL does", () => {
    expect(painted(highlightSegments("see https://brightspace.usc.edu/d2l/home now", []))).toEqual([
      ["link", "https://brightspace.usc.edu/d2l/home"],
    ]);
    // A sentence's full stop is not part of the address.
    expect(painted(highlightSegments("go to www.piazza.com/usc.", []))).toEqual([["link", "www.piazza.com/usc"]]);
    // A paren the URL never opened is the prose's, not the link's.
    expect(painted(highlightSegments("(https://x.dev/a)", []))).toEqual([["link", "https://x.dev/a"]]);
    // ...but one it DID open belongs to it.
    expect(painted(highlightSegments("https://x.dev/a_(b)", []))).toEqual([["link", "https://x.dev/a_(b)"]]);
  });

  /* The point of routing through `scanMentions`: the colour and the wire cannot disagree. */
  it("paints an @token if and only if it will resolve as a mention", () => {
    expect(painted(highlightSegments("you can use @mac for this", ["mac"]))).toEqual([["mention", "@mac"]]);
    // Not an enabled skill → not painted, because it is going as plain text.
    expect(painted(highlightSegments("you can use @nope for this", ["mac"]))).toEqual([]);
    // An email is not a mention — the same token-initial rule the send-time scan applies.
    expect(painted(highlightSegments("carlton@mac wrote", ["mac"]))).toEqual([]);
    // A longer id is a different id: `@mac-extras` must not light up as `mac`.
    expect(painted(highlightSegments("@mac-extras", ["mac"]))).toEqual([]);
  });

  it("gives a declared-but-dead mention the warning tone, not the live one", () => {
    expect(painted(highlightSegments("run @web now", ["mac"], ["web"]))).toEqual([["mention-stale", "@web"]]);
  });

  it("paints list, quote and heading markers without touching their text", () => {
    expect(painted(highlightSegments("- one\n* two\n1. three\n2) four", []))).toEqual([
      ["marker", "-"], ["marker", "*"], ["marker", "1."], ["marker", "2)"],
    ]);
    expect(painted(highlightSegments("  - nested", []))).toEqual([["marker", "-"]]);
    expect(painted(highlightSegments("> quoted\n## head", []))).toEqual([["marker", ">"], ["marker", "##"]]);
    // A marker needs its space: `-dash` and `#hashtag` are words.
    expect(painted(highlightSegments("-dash\n#hashtag", []))).toEqual([]);
  });

  it("tints code spans and dims bold's own asterisks", () => {
    expect(painted(highlightSegments("run `pnpm dev` first", []))).toEqual([["code", "`pnpm dev`"]]);
    expect(painted(highlightSegments("this is **very** good", []))).toEqual([["punct", "**"], ["punct", "**"]]);
    // A lone backtick must not tint the rest of the draft.
    expect(painted(highlightSegments("a ` b", []))).toEqual([]);
  });

  it("lets the outer construct win an overlap outright, never half-painting one", () => {
    // Backticks swallow the URL: inside code, it is not a link.
    expect(painted(highlightSegments("`https://x.dev`", []))).toEqual([["code", "`https://x.dev`"]]);
    // And an `@` inside a URL is part of the address, not a mention.
    expect(painted(highlightSegments("https://mac@x.dev/p", ["mac"]))).toEqual([["link", "https://mac@x.dev/p"]]);
  });

  /* Cross-check against the module the server re-runs: whatever the mirror calls a mention is exactly
     what loses its `@` on the wire. This is the mutation the colour would otherwise be free to fail. */
  it("agrees with the wire about which tokens are mentions", () => {
    const text = "use @mac not carlton@mac and not @macs";
    const ids = painted(highlightSegments(text, ["mac"])).map(([, t]) => t as string);
    expect(ids).toEqual(["@mac"]);
    expect(stripMentionAts(text, scanMentions(text, ["mac"]))).toBe("use mac not carlton@mac and not @macs");
  });
});

describe("listItemAt", () => {
  it("reads the marker, its indent and what follows", () => {
    expect(listItemAt("- one")).toMatchObject({ indent: "", marker: "-", ordered: false, content: "one" });
    expect(listItemAt("  2. two")).toMatchObject({ indent: "  ", marker: "2.", ordered: true, content: "two" });
    expect(listItemAt("plain")).toBeNull();
    expect(listItemAt("-nospace")).toBeNull();
  });
});

describe("continueList — Enter carries a list on", () => {
  it("opens a sibling item with the same marker and indent", () => {
    const e = continueList("- one", 5)!;
    expect(e.text).toBe("- one\n- ");
    expect(e.start).toBe(8);
    expect(continueList("  * a", 5)!.text).toBe("  * a\n  * ");
  });

  it("counts an ordered list up, keeping its delimiter", () => {
    expect(continueList("1. one", 6)!.text).toBe("1. one\n2. ");
    expect(continueList("9) nine", 7)!.text).toBe("9) nine\n10) ");
  });

  it("splits the item at the caret rather than at the end of the line", () => {
    // Caret between "on" and "e" — the tail moves down with the new bullet, as in any list editor.
    expect(continueList("- one", 4)!.text).toBe("- on\n- e");
  });

  /* The two-step exit. Without it, Enter on an empty bullet emits bullets forever and the only way
     out of a list is to reach for Backspace. */
  it("unwinds an empty item one level, then clears it", () => {
    const nested = continueList("- a\n  - ", 8)!;
    expect(nested.text).toBe("- a\n- ");
    expect(nested.start).toBe(6);
    const outer = continueList("- a\n- ", 6)!;
    expect(outer.text).toBe("- a\n");
    expect(outer.start).toBe(4);
  });

  it("declines outside a list, so Enter stays Enter", () => {
    expect(continueList("just prose", 10)).toBeNull();
    expect(continueList("- one\nprose", 11)).toBeNull();
  });
});

describe("indentList — Tab shifts an item a level", () => {
  it("indents and outdents by one level", () => {
    expect(indentList("- one", 5, 5, 1)!.text).toBe("  - one");
    expect(indentList("  - one", 7, 7, -1)!.text).toBe("- one");
    // Already at the outer level: outdent is a no-op, not a line-start amputation.
    expect(indentList("- one", 5, 5, -1)!.text).toBe("- one");
  });

  it("moves every list line the selection touches, and leaves the rest alone", () => {
    const text = "- a\nprose\n- b";
    expect(indentList(text, 0, text.length, 1)!.text).toBe("  - a\nprose\n  - b");
  });

  it("keeps the caret over the same character", () => {
    const e = indentList("- one", 4, 4, 1)!; // caret before the "e"
    expect(e.text.slice(0, e.start)).toBe("  - on");
  });

  it("never lets an outdent pull the caret onto the previous line", () => {
    const e = indentList("  - one", 1, 1, -1)!; // caret inside the indent being removed
    expect(e.start).toBe(0);
    expect(e.end).toBe(0);
  });

  /* Tab is the tab key everywhere else — a textarea that eats it is a keyboard trap. */
  it("declines when nothing selected is a list item", () => {
    expect(indentList("just prose", 4, 4, 1)).toBeNull();
    expect(indentList("", 0, 0, 1)).toBeNull();
  });
});

describe("toggleList — ⌘⇧8 / ⌘⇧7", () => {
  it("turns lines into a list and back off again", () => {
    const on = toggleList("a\nb", 0, 3, false);
    expect(on.text).toBe("- a\n- b");
    expect(toggleList(on.text, 0, on.text.length, false).text).toBe("a\nb");
  });

  it("numbers an ordered list from one, whatever the lines were", () => {
    expect(toggleList("a\nb\nc", 0, 5, true).text).toBe("1. a\n2. b\n3. c");
  });

  it("converts between the two kinds instead of stacking markers", () => {
    expect(toggleList("- a\n- b", 0, 7, true).text).toBe("1. a\n2. b");
    expect(toggleList("1. a\n2. b", 0, 9, false).text).toBe("- a\n- b");
  });

  it("leaves a blank line blank rather than giving it an empty bullet", () => {
    expect(toggleList("a\n\nb", 0, 4, false).text).toBe("- a\n\n- b");
  });

  it("keeps the indent of an item it re-marks", () => {
    expect(toggleList("  - a", 0, 5, true).text).toBe("  1. a");
  });

  it("selects the whole rewritten range, so a second press toggles the same lines back", () => {
    const on = toggleList("a\nb", 0, 3, false);
    expect(on.text.slice(on.start, on.end)).toBe("- a\n- b");
  });

  it("turns off only when every filled line is already that kind", () => {
    // One plain line among bullets means the gesture still means "make these a list".
    expect(toggleList("- a\nplain", 0, 9, false).text).toBe("- a\n- plain");
  });
});

describe("deleteElementChipBefore", () => {
  const draft = 'make @[button "Sign in"] blue';
  const chipEnd = draft.indexOf("]") + 1;

  it("takes the whole token when the caret sits at its trailing edge", () => {
    expect(deleteElementChipBefore(draft, chipEnd)).toEqual({ text: "make  blue", start: 5, end: 5 });
  });

  it("leaves the caret where the chip was, so the next keystroke lands in its place", () => {
    const edit = deleteElementChipBefore(draft, chipEnd)!;
    expect(edit.text.slice(0, edit.start)).toBe("make ");
  });

  it("does nothing anywhere else in the token, or in the prose around it", () => {
    for (const caret of [0, 5, 6, chipEnd - 1, chipEnd + 1, draft.length])
      expect(deleteElementChipBefore(draft, caret), String(caret)).toBeNull();
  });

  it("does nothing to a mention — a hand types straight through `@mac` on its way to `@mac-cli`", () => {
    expect(deleteElementChipBefore("use @mac", 8)).toBeNull();
  });

  it("picks the chip that actually ends at the caret when a draft holds several", () => {
    const two = "@[a] @[bb]";
    expect(deleteElementChipBefore(two, two.length)).toEqual({ text: "@[a] ", start: 5, end: 5 });
    expect(deleteElementChipBefore(two, 4)).toEqual({ text: " @[bb]", start: 0, end: 0 });
  });
});
