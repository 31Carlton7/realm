import { describe, expect, it } from "vitest";
import { looksLikePath, markPaths } from "./file-paths";
import { renderMarkdownWithPaths } from "./Markdown";

/**
 * The false-positive budget is the whole design here. A missed path costs a click; a wrongly marked
 * one puts a button in the middle of a sentence that was not about a file, and a paragraph with six
 * of those is a paragraph nobody reads. Most of this file is therefore about what does NOT match.
 */

const marked = (md: string) => {
  const doc = new DOMParser().parseFromString(renderMarkdownWithPaths(md), "text/html");
  return [...doc.querySelectorAll(".md-path")].map((n) => n.getAttribute("data-path"));
};

describe("looksLikePath", () => {
  it("takes the shapes an agent really writes", () => {
    for (const p of [
      "/Users/carltonaikins/Realm/school/scholarships/PROFILE.md",
      "~/Realm/notes.md",
      "applications/ESSAY-BANK.md",
      "./src/index.ts",
      "../packages/contracts/src/rpc.ts",
      "/var/folders/T/realm-demo/home/",
    ]) expect(looksLikePath(p), p).toBe(true);
  });

  it("refuses the things prose is full of", () => {
    for (const p of [
      "and/or", "he/she", "24/7", "9/11",              // the classic false friends
      "https://example.com/a/b",                        // a url is not a path
      "TODO", "README",                                 // a bare word, however file-ish
      "a b/c.md",                                       // whitespace ends a path
      "N/A",
    ]) expect(looksLikePath(p), p).toBe(false);
  });
});

describe("marking paths in rendered prose", () => {
  it("marks inline code that IS a path, and leaves other inline code alone", () => {
    expect(marked("I wrote `applications/ESSAY-BANK.md` for you.")).toEqual(["applications/ESSAY-BANK.md"]);
    expect(marked("Call `useMemo` and set `--fade-h` to `40px`.")).toEqual([]);
  });

  it("marks an absolute path in running text", () => {
    expect(marked("Everything is in /Users/me/Realm/school/scholarships/ — start there."))
      .toEqual(["/Users/me/Realm/school/scholarships/"]);
  });

  it("drops the sentence's punctuation, not the path's dots", () => {
    expect(marked("See /Users/me/notes.md.")).toEqual(["/Users/me/notes.md"]);
    expect(marked("See /Users/me/a/b.test.ts, then stop.")).toEqual(["/Users/me/a/b.test.ts"]);
  });

  it("does NOT touch relative paths in running text", () => {
    // `and/or` and every date would qualify under any loose rule, and the cost of getting it wrong
    // is a sentence full of buttons. Backticks are how an author says "this is machine text".
    expect(marked("Use one and/or the other, on 24/7 rotation, in src/index.ts.")).toEqual([]);
  });

  it("leaves code blocks and links alone", () => {
    // A block is a thing you copy whole; a link already has a destination.
    expect(marked("```\n/Users/me/a.md\n```")).toEqual([]);
    expect(marked("[the file](https://x.test/a) and /Users/me/a.md")).toEqual(["/Users/me/a.md"]);
  });

  it("leaves a url alone even though it is full of slashes", () => {
    expect(marked("Fetch https://example.com/deep/nested/thing.json now.")).toEqual([]);
  });

  it("marks several in one paragraph, keeping the prose between them", () => {
    const doc = new DOMParser().parseFromString(
      renderMarkdownWithPaths("Wrote /a/b/one.md and then /a/b/two.md."), "text/html");
    expect([...doc.querySelectorAll(".md-path")].map((n) => n.textContent)).toEqual(["/a/b/one.md", "/a/b/two.md"]);
    // `.trim()` for marked's trailing newline after a block, not for anything the scan did.
    expect(doc.body.textContent?.trim()).toBe("Wrote /a/b/one.md and then /a/b/two.md.");
  });

  it("gives every mark a name and a way in from the keyboard", () => {
    const doc = new DOMParser().parseFromString(
      renderMarkdownWithPaths("`applications/ESSAY-BANK.md` and /a/b/c.md"), "text/html");
    for (const n of doc.querySelectorAll(".md-path")) {
      expect(n.getAttribute("title")).toMatch(/click to open$/);
      // The bare-text form is a real button; the inline-code form is a `<code>` given the role, and
      // it needs the tabindex to be reachable at all.
      if (n.tagName === "CODE") {
        expect(n.getAttribute("role")).toBe("button");
        expect(n.getAttribute("tabindex")).toBe("0");
      } else {
        expect(n.tagName).toBe("BUTTON");
      }
    }
  });

  it("counts what it marked, so a caller can skip the pass when there is nothing", () => {
    const doc = new DOMParser().parseFromString("<p>nothing here</p>", "text/html");
    expect(markPaths(doc.body)).toBe(0);
  });
});
