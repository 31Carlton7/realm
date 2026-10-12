import { describe, expect, it } from "vitest";
import {
  EVERY_OWNER, PrOwnersSchema, PrRefSchema, SubmitReviewSchema, hasSearchQualifiers, ownerQualifiers, parsePrRef, prAccountKey, prKey, prName, prOwnersKey, sameOwner,
} from "./code-review";

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

  it("reads a request in a repository a managed user owns, whose login GitHub writes with an underscore", () => {
    const want = { owner: "mona-cat_octo", repo: "notes", number: 7 };
    expect(parsePrRef("https://github.com/mona-cat_octo/notes/pull/7")).toEqual(want);
    expect(parsePrRef("mona-cat_octo/notes#7")).toEqual(want);
  });
});

describe("a profile's choice of owners, as what it adds to a search", () => {
  it("adds nothing while every owner is listed, whatever the list out of play names", () => {
    expect(ownerQualifiers(EVERY_OWNER)).toBe("");
    expect(ownerQualifiers({ hidden: [], shown: ["acme"], others: true })).toBe("");
  });

  it("leaves out each hidden owner while other owners are listed, and makes nothing of the shown ones", () => {
    expect(ownerQualifiers({ hidden: ["acme", "Mara"], shown: ["widgets-inc"], others: true })).toBe("-org:acme -org:Mara");
  });

  it("lists the shown owners alone once other owners are not, and makes nothing of the hidden ones", () => {
    expect(ownerQualifiers({ hidden: ["acme"], shown: ["widgets-inc", "Mara"], others: false })).toBe("org:widgets-inc org:Mara");
  });

  it("answers that nothing can match, and not with the empty string, when other owners are not listed and none is shown", () => {
    expect(ownerQualifiers({ hidden: ["acme"], shown: [], others: false })).toBeNull();
    expect(ownerQualifiers({ hidden: [], shown: [], others: false })).toBeNull();
  });

  it("names an owner once, as first spelled, however often and in whatever case a list holds it", () => {
    expect(ownerQualifiers({ hidden: ["Acme", "acme", "mara", "ACME"], shown: [], others: true })).toBe("-org:Acme -org:mara");
    expect(ownerQualifiers({ hidden: [], shown: ["mara", "MARA"], others: false })).toBe("org:mara");
  });

  it("compares two owners as GitHub does, without regard to letter case", () => {
    expect(sameOwner("Acme", "acme")).toBe(true);
    expect(sameOwner("acme", "acme-inc")).toBe(false);
  });
});

describe("a profile's choice of owners as the wire and the store take it", () => {
  it("takes only owners GitHub could have, so nothing in one can be read as more of the search", () => {
    for (const bad of ["acme widgets", "acme org:mara", "-acme", "", "acme/widgets", "@acme", "acme\n-org:mara"]) {
      expect(PrOwnersSchema.safeParse({ hidden: [bad], shown: [], others: true }).success, bad).toBe(false);
      expect(PrOwnersSchema.safeParse({ hidden: [], shown: [bad], others: false }).success, bad).toBe(false);
    }
    expect(PrOwnersSchema.safeParse({ hidden: ["acme", "mona-cat_octo"], shown: ["Widgets-Inc"], others: false }).success).toBe(true);
  });

  it("is not a choice with one of its three parts missing", () => {
    expect(PrOwnersSchema.safeParse({ hidden: [], shown: [] }).success).toBe(false);
    expect(PrOwnersSchema.safeParse({ hidden: [], others: true }).success).toBe(false);
    expect(PrOwnersSchema.safeParse({ shown: [], others: false }).success).toBe(false);
  });

  it("takes a list of hundreds of owners whole, with none dropped from the choice or from the search", () => {
    const many = Array.from({ length: 500 }, (_, i) => `owner-${i}`);
    const parsed = PrOwnersSchema.safeParse({ hidden: many, shown: [], others: true });
    expect(parsed.success && parsed.data.hidden).toEqual(many);
    expect(ownerQualifiers({ hidden: many, shown: [], others: true })!.split(" ")).toHaveLength(500);
  });

  it("is kept under a key of the profile's own, apart from its account's", () => {
    expect(prOwnersKey("p1")).toBe("codeReview.owners:p1");
    expect(prOwnersKey("p2")).not.toBe(prOwnersKey("p1"));
    expect(prOwnersKey("p1")).not.toBe(prAccountKey("p1"));
  });
});

describe("words typed into the search", () => {
  it("carry GitHub's own qualifiers when one is among them, negated or not, and are plain words otherwise", () => {
    for (const typed of ["repo:acme/widgets parser", "-author:@me draft", "tokenizer is:open"]) expect(hasSearchQualifiers(typed), typed).toBe(true);
    for (const plain of ["tokenizer", "fix: the parser", "stream - parse", "12:30 build"]) expect(hasSearchQualifiers(plain), plain).toBe(false);
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
