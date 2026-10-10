import { describe, expect, it } from "vitest";
import type { Item, Layout } from "@realm/contracts";
import { closeIntent } from "./close-intent";
import { item } from "./store.test-fakes";

/**
 * What ⌘W means in a pane, as data — every surface that offers it reads this one answer.
 */
const ITEMS: Item[] = [
  item("A", "s1", { kind: "session", refId: "sa", title: "Alpha" }),
  item("B", "s1", { kind: "session", refId: "sb", title: "Bravo" }),
  item("T", "s1", { kind: "terminal", refId: "t", title: "zsh" }),
  item("W", "s1", { kind: "browser", refId: "w", title: "Page" }),
];
const of = (id: string) => ITEMS.find((i) => i.id === id);
const leaf = (id: string, itemId: string | null) => ({ type: "leaf" as const, id, itemId });
const row = (...children: Layout[]): Layout => ({ type: "split", id: "root", dir: "row", sizes: children.map(() => 100 / children.length), children });
/** Alpha with its side pane, the browser showing. */
const withSide = row(leaf("LA", "A"), { type: "leaf", id: "LS", itemId: "W", tabs: ["W", "T"], owner: "A" });

describe("closeIntent", () => {
  it("closes nothing on a session alone — the keyboard goes to its prompter", () => {
    // THE MUTANT: answer `pane` here, which is the × the owner asked to be rid of on ⌘W instead.
    expect(closeIntent(leaf("LA", "A"), "LA", of)).toEqual({ kind: "prompter", sessionId: "sa" });
    // …and a side pane beside it is not a split: the session is still alone in the view.
    expect(closeIntent(withSide, "LA", of)).toEqual({ kind: "prompter", sessionId: "sa" });
  });

  it("closes a pane holding anything else, alone or not, as its bar says", () => {
    expect(closeIntent(leaf("LT", "T"), "LT", of)).toEqual({ kind: "pane", itemId: "T" });
    expect(closeIntent(row(leaf("LT", "T"), leaf("LE", null)), "LT", of)).toEqual({ kind: "pane", itemId: "T" });
  });

  it("has nothing to say for a lone empty pane or a leaf that is not there", () => {
    expect(closeIntent(leaf("LE", null), "LE", of)).toBeNull();
    expect(closeIntent(withSide, "nope", of)).toBeNull();
    expect(closeIntent(null, "LA", of)).toBeNull();
  });
});
