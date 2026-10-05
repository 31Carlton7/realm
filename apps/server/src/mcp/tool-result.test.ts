import { describe, expect, it } from "vitest";
import { clip } from "./tool-result";

describe("clip", () => {
  it("leaves a string at the budget untouched", () => {
    expect(clip("abcde", 5)).toBe("abcde");
  });

  it("spends the last character of the budget on the ellipsis, never exceeding it", () => {
    // The budget is what a tool result promises the model; an ellipsis appended AFTER slicing to `n`
    // would make every clipped value one character too long.
    expect(clip("abcdef", 5)).toBe("abcd…");
    expect(clip("abcdef", 5)).toHaveLength(5);
  });

  it("never cuts an emoji in half, at any budget", () => {
    // THE MUTANT: slice by UTF-16 unit. "ab😀" at 4 keeps the emoji's first half, which a tokenizer refuses.
    expect(clip("ab😀cd", 4)).toBe("ab…");
    const s = "a😀b😀😀c🎉d";
    for (let n = 1; n <= s.length; n++) {
      const c = clip(s, n);
      expect(c.match(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/) === null, `at ${n}: ${JSON.stringify(c)}`).toBe(true);
      expect(c.length).toBeLessThanOrEqual(n);
    }
  });

});

