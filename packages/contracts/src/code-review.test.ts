import { describe, expect, it } from "vitest";
import { PrRefSchema, SubmitReviewSchema, parsePrRef, prKey, prName } from "./code-review";

describe("a pull request named in pasted text", () => {
  it("reads the page's URL however it was copied", () => {
    const want = { owner: "acme", repo: "widgets", number: 42 };
    for (const text of [
      "https://github.com/acme/widgets/pull/42",
      "  https://github.com/acme/widgets/pull/42/files  ",
      "https://github.com/acme/widgets/pull/42#discussion_r123",
      "https://www.github.com/acme/widgets/pull/42?diff=split",
      "github.com/acme/widgets/pull/42",
      "acme/widgets#42",
    ]) expect(parsePrRef(text), text).toEqual(want);
  });

  it("keeps the case it was written in, and keys it without", () => {
    const ref = parsePrRef("https://github.com/Acme/Widgets.js/pull/7")!;
    expect(ref).toEqual({ owner: "Acme", repo: "Widgets.js", number: 7 });
    expect(prName(ref)).toBe("Acme/Widgets.js#7");
    expect(prKey(ref)).toBe("acme/widgets.js#7");
  });

  it("is not an address when it is a search, an issue, or another site", () => {
    for (const text of ["tokenizer", "https://github.com/acme/widgets/issues/42", "https://gitlab.com/acme/widgets/pull/42", "acme/widgets", "#42", ""]) {
      expect(parsePrRef(text), text).toBeNull();
    }
  });

  it("refuses a name that could steer the API path a ref is spliced into", () => {
    // THE MUTANT: a loose `[^/]+` lets `..` or an encoded slash walk out of repos/<owner>/<repo>/.
    for (const bad of [{ owner: "..", repo: "x" }, { owner: "acme", repo: ".." }, { owner: "acme", repo: "a b" }, { owner: "ac/me", repo: "x" }, { owner: "-acme", repo: "x" }, { owner: "acme", repo: "x%2F.." }]) {
      expect(PrRefSchema.safeParse({ ...bad, number: 1 }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(parsePrRef("https://github.com/../widgets/pull/1")).toBeNull();
  });
});

describe("a review as the wire takes it", () => {
  const base = { ref: { owner: "acme", repo: "widgets", number: 42 }, headSha: "abc1234", event: "APPROVE" };
  it("needs a comment whatever the event", () => {
    expect(SubmitReviewSchema.safeParse({ ...base, body: "LGTM" }).success).toBe(true);
    expect(SubmitReviewSchema.safeParse({ ...base, body: " \n " }).success).toBe(false);
    expect(SubmitReviewSchema.safeParse({ ...base, body: "x", event: "MERGE" }).success).toBe(false);
  });
  it("takes line comments only with a side, a line and words", () => {
    const comment = { path: "a.ts", line: 3, side: "RIGHT", body: "x" };
    expect(SubmitReviewSchema.safeParse({ ...base, body: "x", comments: [comment] }).success).toBe(true);
    for (const bad of [{ ...comment, side: "BOTH" }, { ...comment, line: 0 }, { ...comment, body: "" }]) {
      expect(SubmitReviewSchema.safeParse({ ...base, body: "x", comments: [bad] }).success).toBe(false);
    }
  });
});
