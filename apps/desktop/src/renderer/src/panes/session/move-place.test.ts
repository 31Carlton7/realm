import { describe, expect, it } from "vitest";
import { movedSentence, placeName, shortPath } from "./move-place";

const place = (cwd: string, branch: string | null) => ({ machine: null, environmentId: "e", cwd, branch });

describe("naming the ends of a move", () => {
  it("names a checkout by its folder and branch", () => {
    expect(placeName(place("/Users/me/shop", "main"))).toBe("shop (main)");
    expect(placeName(place("/Users/me/shop", null))).toBe("shop");
  });

  it("says the moved line without a path in it", () => {
    expect(movedSentence({ from: place("/Users/me/shop", "main"), to: place("/Users/me/Realm/worktrees/01M6HDE0JV8Y1B2DVQZN8B29YC/fix-tests", "realm/fix-tests"), conversation: "native" }))
      .toBe("Moved from shop (main) to fix-tests (realm/fix-tests). The conversation continued.");
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

  it("cuts a temp path down from the left until it fits, never touching the last folder", () => {
    const p = "/var/folders/14/224nwfmx72lbz5rd86370k840000gn/T/realm-session-move-live-xl1qhD/home/worktrees/01M6HDE0JV8Y1B2DVQZN8B29YC/fix-tests";
    const short = shortPath(p);
    expect(short.length).toBeLessThanOrEqual(44);
    expect(short.startsWith("/var/…")).toBe(true);
    expect(short.endsWith("/worktrees/…/fix-tests")).toBe(true);
    expect(short).not.toContain("…/…");
  });
});
