import { describe, expect, it } from "vitest";
import { scanUltracodeKeyword } from "./ultracode-keyword";

/**
 * What the real Claude Code 2.1.293 binary did with each of 226 texts, sent to it one a turn as a
 * person's message: whether it put its note about a workflow in front of the model.
 *
 * Every character outside printable ASCII is written as an escape, so that a look-alike cannot be
 * taken for the character it resembles: a typographic quote for a straight one, a dash for a
 * hyphen, a space of no width for nothing at all.
 */
const OBSERVED: readonly (readonly [text: string, notice: boolean])[] = [
  ["\tultracode", true],
  ["\n/foo ultracode", true],
  [" /foo ultracode", true],
  [" ultracode", true],
  ["\"ultracode review this", true],
  ["\"ultracode\" is the keyword", false],
  ["\"ultracode\" ultracode", true],
  ["\"use ultracode now\"", false],
  ["# ultracode", true],
  ["#ultracode", true],
  ["$ultracode", true],
  ["'tis ultracode", true],
  ["'ultracode review this", true],
  ["'ultracode' is the keyword", false],
  ["'use ultracode now'", false],
  ["(a (b) ultracode)", true],
  ["(please ultracode this)", false],
  ["(see the notes \"ultracode\" later", true],
  ["(ultracode review this", true],
  ["(ultracode) fix the bug", false],
  ["(ultracode) review this", false],
  ["**ultracode** review this", true],
  ["*ultracode*", true],
  ["- ultracode", true],
  ["--ultracode", false],
  ["-> ultracode", true],
  ["-ultracode", false],
  [".ultracode", true],
  ["/ ultracode", false],
  ["//ultracode", false],
  ["/review\nthen ultracode the result", false],
  ["/tmp/notes.txt mentions ultracode", false],
  ["/ultracode", false],
  ["1. ultracode", true],
  ["100% ultracode", true],
  ["2ultracode", false],
  [":ultracode", true],
  ["</b> ultracode", true],
  ["<3 ultracode", true],
  ["<b>ultracode</b>", true],
  ["<div>ultracode</div> go", true],
  ["<ultracode review this", true],
  ["<ultracode> is the keyword", false],
  ["<ultracode> review this", false],
  ["=> ultracode", true],
  ["> ultracode", true],
  ["@ultracode", true],
  ["@ultracode fix the failing tests", true],
  ["I want ultracode.", true],
  ["ULTRACODE fix the tests", true],
  ["ULTRACODE say hi", true],
  ["ULTRACODE!!!", true],
  ["ULTRACODE?", false],
  ["UltraCode say hi", true],
  ["Ultracode say hi", true],
  ["Ultracode: make it blue", true],
  ["[block 1] ultracode say hi  [block 2, last] fix the tests", true],
  ["[ultracode review this", true],
  ["[ultracode] is the keyword", false],
  ["[ultracode] review this", false],
  ["[x] ultracode", true],
  ["_ultracode_ review this", false],
  ["```\nultracode\n```", false],
  ["```\nultracode\n```\nreview this", false],
  ["``` unclosed\nultracode", true],
  ["``ultracode`` here", true],
  ["``ultracode`` is the keyword", true],
  ["`a` `ultracode` b", false],
  ["`code` ultracode", true],
  ["`ultracode review this", true],
  ["`ultracode` is the keyword", false],
  ["`unclosed ultracode", true],
  ["a \"b then \"ultracode\"", true],
  ["a \"b ultracode", true],
  ["a (b ultracode", true],
  ["a (b) ultracode", true],
  ["a ) ultracode", true],
  ["a < b ultracode", true],
  ["a <b ultracode", true],
  ["a [b [c] ultracode", true],
  ["branch-ultracode", false],
  ["check ultracode's output", true],
  ["don't 'quote' ultracode", true],
  ["don't ultracode this", true],
  ["don't use ultracode yet", true],
  ["e.g. ultracode", true],
  ["f(ultracode)", false],
  ["feature/ultracode", false],
  ["first line\nultracode\nlast line", true],
  ["he said \"go\" and ultracode ran", true],
  ["he said \"use ultracode for this", true],
  ["is ultracode on?", true],
  ["it's 'ultracode' time", false],
  ["it's 5\" wide, ultracode this", true],
  ["me@ultracode.com", false],
  ["merge the ultra-code branch", false],
  ["merge the ultracode branch", true],
  ["merge the ultracode branch, sent on a model where the session reports ultracodeAvailable false while workflows are enabled", true],
  ["merge the ultracode branch, sent with workflowKeywordTriggerEnabled set to false in user settings", true],
  ["mode: ultracode", true],
  ["mode:ultracode", true],
  ["open src/ultracode.ts", false],
  ["open src/ultracode/index.ts", false],
  ["open ultracode.md", false],
  ["open ultracode.md and fix the wt-ultracode folder", false],
  ["please use ultra code for this", false],
  ["please use ultra-code for this", false],
  ["please use ultracode, thanks", true],
  ["please use ultracode.", true],
  ["re: ultracode\u2014thoughts", true],
  ["realm-ultracode-live-", false],
  ["run it with ultracode.", true],
  ["run.ultracode()", true],
  ["say \"hi\" ultracode \"bye\"", true],
  ["say [see [ultracode] here] now", false],
  ["say hi\n\nultracode please", true],
  ["say hi\n/foo ultracode", true],
  ["say hi\nultracode", true],
  ["say hi ultracode", true],
  ["see (1 and @[button \"Try ultracode\"]", true],
  ["see [1 and @[button \"Try ultracode\"]", false],
  ["see https://example.com/?q=ultracode", true],
  ["see https://example.com/ultracode today", false],
  ["see ~/.ultracode", true],
  ["set ultracode_mode", false],
  ["tell me about \u201cultracode\u201d", true],
  ["the user's ultracode", true],
  ["the-ultracode-branch", false],
  ["ultra code this", false],
  ["ultracode", true],
  ["ultracode\n\nwhat do you think?", true],
  ["ultracode\n?", true],
  ["ultracode \"ultracode\"", true],
  ["ultracode \"x\"", true],
  ["ultracode (now)", true],
  ["ultracode -x", true],
  ["ultracode /compact", true],
  ["ultracode 2", true],
  ["ultracode ?", true],
  ["ultracode `x`", true],
  ["ultracode say hi", true],
  ["ultracode ultracode", true],
  ["ultracode \ud83d\ude80", true],
  ["ultracode!?", true],
  ["ultracode!then", true],
  ["ultracode#1", true],
  ["ultracode$", true],
  ["ultracode&", true],
  ["ultracode's switch", true],
  ["ultracode+", true],
  ["ultracode, then report back", true],
  ["ultracode,then", true],
  ["ultracode--", false],
  ["ultracode-branch", false],
  ["ultracode.", true],
  ["ultracode.\nNext", true],
  ["ultracode. Then go", true],
  ["ultracode. next", true],
  ["ultracode.5", false],
  ["ultracode.?", true],
  ["ultracode.Then go", false],
  ["ultracode._x", false],
  ["ultracode.md", false],
  ["ultracode.ts is the file", false],
  ["ultracode/realm", false],
  ["ultracode2", false],
  ["ultracode:", true],
  ["ultracode: make it blue", true],
  ["ultracode::x", true],
  ["ultracode:then", true],
  ["ultracode;", true],
  ["ultracode;then", true],
  ["ultracode=1", true],
  ["ultracode?", false],
  ["ultracode? yes, do it", false],
  ["ultracode?!", false],
  ["ultracode??", false],
  ["ultracode@example.com", true],
  ["ultracode\\", false],
  ["ultracode_branch", false],
  ["ultracoded it", false],
  ["ultracodes", false],
  ["ultracode|x", true],
  ["ultracode~", true],
  ["ultracode\u00a0?", true],
  ["ultracode\u200b", true],
  ["ultracode\u2019s switch", true],
  ["ultracode\u3002", true],
  ["ultracode\u65e5\u672c", true],
  ["ultrathink ultracode", true],
  ["ultra\u200bcode", false],
  ["use \"ultracode\" here", false],
  ["use 'ultracode' here", false],
  ["use `ultracode` here", false],
  ["use ultracode!", true],
  ["use ultracode\" now", true],
  ["use ultracode' now", true],
  ["use ultracode) now", true],
  ["use ultracode* now", true],
  ["use ultracode> now", true],
  ["use ultracode] now", true],
  ["use ultracode} now", true],
  ["use ultracode\u2013now", true],
  ["use ultracode\u2014now", true],
  ["use ultracode\u2026", true],
  ["use \u2018ultracode\u2019 here", true],
  ["use \u201cultracode\u201d here", true],
  ["users' ultracode", true],
  ["v2.ultracode", true],
  ["we ultracoded it yesterday", false],
  ["what does ultracode do?", true],
  ["what is ultracode", true],
  ["what is ultracode?", false],
  ["x 'a' ultracode 'b' y", true],
  ["x < 5 so use ultracode > y", true],
  ["x > ultracode", true],
  ["x=ultracode", true],
  ["{ultracode review this", true],
  ["{ultracode} review this", false],
  ["~~ultracode~~", true],
  ["\u00e9ultracode", true],
  ["\u201cultracode?\u201d", false],
  ["\u201cultracode\u201d is the keyword", true],
  ["\u65e5\u672cultracode", true],
  ["\uff08ultracode\uff09", true],
  ["\ud83d\ude80ultracode", true],
];

/** The words the scanner counts in a text, each as the text spells it. */
const counted = (text: string): string[] => scanUltracodeKeyword(text).map(({ start, end }) => text.slice(start, end));

describe("scanUltracodeKeyword, held to what the real binary did", () => {
  it("agrees with the binary on every one of the 226 observed texts", () => {
    expect(OBSERVED).toHaveLength(226);
    expect(OBSERVED.filter(([text, notice]) => (scanUltracodeKeyword(text).length > 0) !== notice)).toEqual([]);
  });
});

describe("scanUltracodeKeyword, on the word itself", () => {
  it.each(["ultracode", "Ultracode", "ULTRACODE", "UltraCode"])("finds the word written as %s", (word) => {
    expect(scanUltracodeKeyword(`please ${word} this`)).toEqual([{ start: 7, end: 16 }]);
  });

  it.each(["ultracoded", "ultracodes", "ultracode2", "ultracode_mode", "2ultracode", "_ultracode", "ultra-code", "ultra code"])("finds nothing in %s, where the word does not stand whole", (text) => {
    expect(scanUltracodeKeyword(text)).toEqual([]);
  });

  it("counts the word beside a letter outside A to Z, which the binary's boundary does not take for part of a word", () => {
    expect(counted("\u00e9ultracode")).toEqual(["ultracode"]);
    expect(counted("ultracode\u65e5\u672c")).toEqual(["ultracode"]);
  });
});

describe("scanUltracodeKeyword, on a text that starts with a slash", () => {
  it("finds nothing in a text that starts with a slash, wherever the word stands in it", () => {
    expect(scanUltracodeKeyword("/review\nthen ultracode the result")).toEqual([]);
  });

  it("scans a text whose slash comes after blank space, because it trims nothing", () => {
    expect(scanUltracodeKeyword(" /foo ultracode")).toEqual([{ start: 6, end: 15 }]);
  });
});

describe("scanUltracodeKeyword, on a word inside a closed span", () => {
  it.each([
    ["straight double quotes", '"ultracode" is the keyword'],
    ["straight single quotes", "'ultracode' is the keyword"],
    ["backticks", "`ultracode` is the keyword"],
    ["round brackets", "(ultracode) fix the bug"],
    ["square brackets", "[ultracode] is the keyword"],
    ["curly brackets", "{ultracode} review this"],
    ["a tag's angle brackets", "<ultracode> is the keyword"],
  ])("does not count the word inside closed %s", (_span, text) => {
    expect(scanUltracodeKeyword(text)).toEqual([]);
  });

  it("counts the word inside typographic quotes, which open no span", () => {
    expect(counted("use \u201cultracode\u201d here")).toEqual(["ultracode"]);
  });

  it("opens no span at a less-than sign that neither a letter nor a slash follows", () => {
    expect(counted("x < 5 so use ultracode > y")).toEqual(["ultracode"]);
  });

  it("does not take an apostrophe inside a word for a quote, so the quoted word after it stays in its own span", () => {
    expect(scanUltracodeKeyword("it's 'ultracode' time")).toEqual([]);
  });

  it("opens no quote at an apostrophe that a letter stands before, so a later apostrophe has nothing to close", () => {
    expect(counted("don't use ultracode' now 'x")).toEqual(["ultracode"]);
  });

  it("closes no quote at a straight single quote that a letter follows, so the span runs on to the next one", () => {
    expect(scanUltracodeKeyword("'it's ultracode' x")).toEqual([]);
  });

  it("opens a tag's span at a less-than sign that a slash follows, as at one that a letter follows", () => {
    expect(scanUltracodeKeyword("</b ultracode>")).toEqual([]);
  });
});

describe("scanUltracodeKeyword, on the characters beside the word", () => {
  it.each([
    ["a slash", "feature/ultracode"],
    ["a backslash", "C:\\ultracode"],
    ["a hyphen", "branch-ultracode"],
  ])("does not count the word right after %s", (_character, text) => {
    expect(scanUltracodeKeyword(text)).toEqual([]);
  });

  it.each([
    ["a slash", "ultracode/realm"],
    ["a backslash", "ultracode\\"],
    ["a hyphen", "ultracode-branch"],
    ["a question mark", "what is ultracode?"],
  ])("does not count the word right before %s", (_character, text) => {
    expect(scanUltracodeKeyword(text)).toEqual([]);
  });

  it("counts the word in a question whose mark does not touch it", () => {
    expect(counted("what does ultracode do?")).toEqual(["ultracode"]);
  });

  it.each([
    ["a letter", "ultracode.md"],
    ["a digit", "ultracode.5"],
    ["an underscore", "ultracode._x"],
  ])("does not count the word before a dot that %s follows", (_character, text) => {
    expect(scanUltracodeKeyword(text)).toEqual([]);
  });

  it("counts the word before a dot that ends a sentence", () => {
    expect(counted("run it with ultracode.")).toEqual(["ultracode"]);
    expect(counted("ultracode. Then go")).toEqual(["ultracode"]);
  });
});

describe("scanUltracodeKeyword, on spans that meet or never close", () => {
  it("ends a span at its first closer and nests nothing, so a word after an inner pair counts", () => {
    expect(counted("(a (b) ultracode)")).toEqual(["ultracode"]);
  });

  it("moves the start of an open square bracket's span to a later square bracket, which leaves a word between the two outside it", () => {
    expect(counted("[ultracode [x]]")).toEqual(["ultracode"]);
  });

  it("spans nothing with an opener that never closes", () => {
    expect(counted('he said "use ultracode for this')).toEqual(["ultracode"]);
  });

  it("passes over every opener while a span is open, so a quoted word after an unclosed bracket counts", () => {
    expect(counted('(see the notes "ultracode" later')).toEqual(["ultracode"]);
  });
});

describe("scanUltracodeKeyword, on what it returns", () => {
  it("gives a hit's start and exclusive end in UTF-16 indexes, where a character outside the basic plane takes two", () => {
    expect(scanUltracodeKeyword("\ud83d\ude80ultracode")).toEqual([{ start: 2, end: 11 }]);
  });

  it("gives every hit of a text that holds the word more than once", () => {
    expect(scanUltracodeKeyword("ultracode ultracode")).toEqual([{ start: 0, end: 9 }, { start: 10, end: 19 }]);
  });

  it("keeps a hit that counts beside one that does not", () => {
    expect(scanUltracodeKeyword('"ultracode" ultracode')).toEqual([{ start: 12, end: 21 }]);
  });
});
