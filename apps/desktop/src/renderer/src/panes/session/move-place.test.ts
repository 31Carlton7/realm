import { describe, expect, it } from "vitest";
import { moveFailureReason, movedSentence, placeName, shortPath } from "./move-place";

const place = (cwd: string, branch: string | null) => ({ machine: null, environmentId: "e", cwd, branch });

describe("naming the ends of a move", () => {
  it("names a checkout by its folder and branch", () => {
    expect(placeName(place("/Users/me/shop", "main"))).toBe("shop (main)");
    expect(placeName(place("/Users/me/shop", null))).toBe("shop");
  });

  it("leaves out a branch that only repeats the folder", () => {
    expect(placeName(place("/Users/me/Realm/worktrees/01M6/fix-tests", "realm/fix-tests"))).toBe("fix-tests");
    expect(placeName(place("/Users/me/fix-tests", "fix-tests"))).toBe("fix-tests");
    expect(placeName(place("/Users/me/fix-tests", "realm/other"))).toBe("fix-tests (realm/other)");
    expect(placeName(place("/Users/me/fix-tests", "me/fix-tests"))).toBe("fix-tests (me/fix-tests)");
  });

  it("says the moved line without a path in it", () => {
    expect(movedSentence({ from: place("/Users/me/shop", "main"), to: place("/Users/me/Realm/worktrees/01M6HDE0JV8Y1B2DVQZN8B29YC/fix-tests", "realm/fix-tests"), conversation: "native" }))
      .toBe("Moved from shop (main) to fix-tests. The conversation continued.");
    expect(movedSentence({ from: place("/a/shop", null), to: place("/b/shop-2", null), conversation: "notes" }))
      .toBe("Moved from shop to shop-2. The conversation continued from notes.");
  });
});

describe("shortPath", () => {
  it("leaves a short path whole, home-shortened", () => {
    expect(shortPath("/Users/me/realm")).toBe("~/realm");
    expect(shortPath("/Users/me/Realm/worktrees/fix-tests")).toBe("~/Realm/worktrees/fix-tests");
  });

  it("cuts an id out of the middle and keeps the tail", () => {
    expect(shortPath("/Users/me/Realm/worktrees/01M1DTDHHCR3B7N1JBZA0DAXE7/polish-session-move"))
      .toBe("~/Realm/worktrees/…/polish-session-move");
  });

  it("cuts a temp path at its first long name, keeping one run of folders before the last", () => {
    const p = "/var/folders/14/224nwfmx72lbz5rd86370k840000gn/T/realm-session-move-live-xl1qhD/home/worktrees/01M6HDE0JV8Y1B2DVQZN8B29YC/fix-tests";
    const short = shortPath(p);
    expect(short.length).toBeLessThanOrEqual(44);
    expect(short).toBe("/var/…/home/worktrees/…/fix-tests");
  });

  it("keeps as much of the tail as fits", () => {
    expect(shortPath("/Users/me/code/clients/acme/apps/storefront/packages/checkout-flow", 40)).toBe("~/…/storefront/packages/checkout-flow");
  });
});

describe("a failed move's reason", () => {
  it("shortens the paths in it as the sheet does, and ends as a sentence", () => {
    const p = "/var/folders/14/224nwfmx72lbz5rd86370k840000gn/T/realm-session-move-live-xl1qhD/home/worktrees/01M6HDE0JV8Y1B2DVQZN8B29YC/fix-tests";
    expect(moveFailureReason(`${p} is not a git repository, so the changes cannot go into it`))
      .toBe("/var/…/home/worktrees/…/fix-tests is not a git repository, so the changes cannot go into it.");
    expect(moveFailureReason("could not write /Users/me/Realm/worktrees/01M1DTDHHCR3B7N1JBZA0DAXE7/polish-session-move."))
      .toBe("Could not write ~/Realm/worktrees/…/polish-session-move.");
  });

  it("leaves words with a slash in them alone", () => {
    expect(moveFailureReason("the changes conflict with the work already there, in src/cart.ts"))
      .toBe("The changes conflict with the work already there, in src/cart.ts.");
  });
});
