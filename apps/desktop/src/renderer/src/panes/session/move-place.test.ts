import { describe, expect, it } from "vitest";
import { moveFailureReason, shortPath } from "./move-place";

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
    expect(moveFailureReason("the changes conflict with the work already there, in src/lib/cart.ts"))
      .toBe("The changes conflict with the work already there, in src/lib/cart.ts.");
    expect(moveFailureReason("the changes conflict in packages/storefront/src/features/checkout/components/CartSummary.tsx"))
      .toBe("The changes conflict in packages/storefront/src/features/checkout/components/CartSummary.tsx.");
  });
});
