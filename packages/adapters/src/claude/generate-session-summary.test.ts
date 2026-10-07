import { describe, expect, it } from "vitest";
import { SUMMARY_MAX, cleanSummary } from "./generate-session-summary";

describe("cleanSummary", () => {
  it("returns prose that fits untouched, unwrapped and unquoted", () => {
    expect(cleanSummary('  "You asked for the login redirect to be fixed; it was."  '))
      .toBe("You asked for the login redirect to be fixed; it was.");
    expect(cleanSummary("Summary: you fixed the redirect.")).toBe("you fixed the redirect.");
  });

  it("keeps whole sentences when over budget, even when only the short opener fits", () => {
    // The shape that used to truncate mid-word: a ~80-char opener, then a long second sentence.
    const opener = "You asked how file memory is managed in Realm uploads and whether they're copied.";
    const rest = ` You received ${"a detailed architectural proposal ".repeat(12)}covering it.`;
    const out = cleanSummary(opener + rest);
    expect(out).toBe(opener);
    expect(out.endsWith("…")).toBe(false);
  });

  it("keeps as many complete sentences as fit", () => {
    const one = `${"a".repeat(100)}. `;
    const out = cleanSummary(one.repeat(6));
    expect(out.endsWith(".")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(SUMMARY_MAX);
    expect(out).toBe(`${one.repeat(3).trimEnd()}`); // three whole sentences, the fourth dropped
  });

  it("counts a sentence that ends exactly on the ceiling", () => {
    const exact = `${"a".repeat(SUMMARY_MAX - 1)}. and then more words after it`;
    expect(cleanSummary(exact)).toBe(`${"a".repeat(SUMMARY_MAX - 1)}.`);
  });

  it("ellipsis only when the first sentence is itself over budget — and never mid-word", () => {
    const out = cleanSummary("word ".repeat(200));
    expect(out.endsWith("…")).toBe(true);
    expect(out.endsWith("wor…")).toBe(false);
    expect(out.length).toBeLessThanOrEqual(SUMMARY_MAX);
  });
});
