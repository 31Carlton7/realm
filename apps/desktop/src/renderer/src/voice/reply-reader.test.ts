import { describe, expect, it } from "vitest";
import { CODE_MENTION, DIFF_MENTION, ReplyReader, TABLE_MENTION, speakable, takeSentences } from "./reply-reader";

/** Feeds a reply the way the transcript grows it: a few characters at a time, and then settled. */
function stream(reply: string, step = 3): { chunks: string[][]; all: string[] } {
  const reader = new ReplyReader();
  const chunks: string[][] = [];
  for (let n = step; n < reply.length; n += step) chunks.push(reader.feed(reply.slice(0, n)));
  chunks.push(reader.feed(reply, true));
  return { chunks, all: chunks.flat() };
}

describe("ReplyReader", () => {
  it("says each sentence as soon as its end streams in, before the reply has finished", () => {
    const reply = "Two plus two is four. The tests pass too! Anything else?";
    const { chunks, all } = stream(reply);
    expect(all).toEqual(["Two plus two is four.", "The tests pass too!", "Anything else?"]);
    // THE MUTANT: only read a reply once it settles. The first sentence then waits for the whole
    // answer, which is the latency this exists to remove.
    const firstAt = chunks.findIndex((c) => c.includes("Two plus two is four."));
    expect(firstAt).toBeLessThan(chunks.length - 1);
    expect(firstAt).toBeLessThanOrEqual(Math.ceil("Two plus two is four. ".length / 3));
  });

  it("says nothing twice however often the same text is fed", () => {
    const reader = new ReplyReader();
    const text = "First one. Second";
    expect(reader.feed(text)).toEqual(["First one."]);
    expect(reader.feed(text)).toEqual([]);
    expect(reader.feed(`${text} one.`, true)).toEqual(["Second one."]);
  });

  it("carries a sentence across a line break in its paragraph", () => {
    expect(stream("This sentence wraps\nonto a second line. Done.").all).toEqual(["This sentence wraps onto a second line.", "Done."]);
  });

  it("skips a fenced block and says once that the code is in the chat", () => {
    const reply = "Here is the fix.\n```ts\nconst a = 1;\nconsole.log(a.b);\n```\nRun it again.";
    // THE MUTANT: read fenced code like prose — "const a equals one" aloud.
    expect(stream(reply).all).toEqual(["Here is the fix.", CODE_MENTION, "Run it again."]);
  });

  it("calls a diff a diff, and says two blocks in a row once", () => {
    expect(stream("Changed it.\n```diff\n-a\n+b\n```\n```diff\n-c\n+d\n```\n").all).toEqual(["Changed it.", DIFF_MENTION]);
    expect(stream("```py\nx\n```\nThen\n```py\ny\n```").all).toEqual([CODE_MENTION, "Then", CODE_MENTION]);
  });

  it("skips a table and mentions it", () => {
    const reply = "Results:\n| file | lines |\n| --- | --- |\n| a.ts | 10 |\nAll good.";
    // THE MUTANT: a table row read as prose — pipes and dashes aloud.
    expect(stream(reply).all).toEqual(["Results:", TABLE_MENTION, "All good."]);
  });

  it("reads list items and headings as sentences of their own, without their markers", () => {
    const reply = "## Summary\n- Fixed the login bug\n- Added a test\n1. Ship it";
    expect(stream(reply).all).toEqual(["Summary", "Fixed the login bug", "Added a test", "Ship it"]);
  });

  it("does not end a sentence at an abbreviation or inside a number", () => {
    expect(stream("Use a tool, e.g. ripgrep, to look. Version 3.5 is out.").all).toEqual(["Use a tool, e.g. ripgrep, to look.", "Version 3.5 is out."]);
  });

  it("waits on a line too short to classify rather than reading the start of a fence", () => {
    const reader = new ReplyReader();
    expect(reader.feed("Ok.\n`")).toEqual(["Ok."]);
    expect(reader.feed("Ok.\n``")).toEqual([]);
    expect(reader.feed("Ok.\n```js\nlet x = 1;\n")).toEqual([CODE_MENTION]);
  });
});

describe("takeSentences", () => {
  it("keeps what is still being written", () => {
    expect(takeSentences("One. Two. Thr")).toEqual({ sentences: ["One.", "Two."], rest: "Thr" });
    expect(takeSentences("Is it? \"Yes.\" Then")).toEqual({ sentences: ["Is it?", "\"Yes.\""], rest: "Then" });
  });
});

describe("speakable", () => {
  it("says a link's words, a path's file name, and no markup", () => {
    expect(speakable("See [the docs](https://x.dev/a) and **this** in `apps/desktop/src/main.ts`.")).toBe("See the docs and this in main.ts.");
    expect(speakable("Open https://example.com/x now.")).toBe("Open a link now.");
    expect(speakable("Call `npm test` _first_.")).toBe("Call npm test first.");
    // Nothing a voice could say is nothing said at all.
    expect(speakable("---")).toBe("");
  });
});
