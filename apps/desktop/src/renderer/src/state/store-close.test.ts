import { describe, expect, it } from "vitest";
import { allItems, findLeafOfItem, findSidePane, primaryLeaves } from "@realm/contracts";
import { createAppStore } from "./store";
import { fakeApi, item, session } from "./store.test-fakes";

/**
 * ⌘W as the store runs it (`closeInPane`): a tab leaves its strip, a pane leaves its split, and a
 * session alone is never closed — the keyboard goes to its prompter instead. Layout-only throughout:
 * nothing here deletes. Every test names the one-line change that would make it fail.
 */

type Store = ReturnType<typeof createAppStore>;
const mains = (store: Store) => primaryLeaves(store.getState().layout!).map((l) => l.itemId);
const leafOf = (store: Store, itemId: string) => findLeafOfItem(store.getState().layout!, itemId)!.id;

/** Alpha on screen alone, Bravo and a terminal in the space. */
async function mount() {
  const api = fakeApi({
    items: { s1: [
      item("i-a", "s1", { kind: "session", refId: "sa", title: "Alpha" }),
      item("i-b", "s1", { kind: "session", refId: "sb", title: "Bravo" }),
      item("i-term", "s1", { kind: "terminal", refId: "term", title: "Shell" }),
    ] },
    sessions: [session("sa", "s1"), session("sb", "s1")],
  });
  const store = createAppStore(api);
  await store.getState().boot();
  await store.getState().openItem("i-a");
  return { api, store };
}

describe("⌘W (closeInPane)", () => {
  it("closes nothing on a session alone, and hands the keyboard to its prompter", async () => {
    // THE MUTANT: the old close — Alpha leaves the view and a fresh session is made to fill it.
    const { api, store } = await mount();
    const before = store.getState().layout;
    const sessionsMade = api.calls.filter((c) => c.startsWith("createSession")).length;
    await store.getState().closeInPane();
    expect(store.getState().layout).toBe(before);
    expect(store.getState().keyboardFor?.sessionId).toBe("sa");
    expect(api.calls.filter((c) => c.startsWith("createSession"))).toHaveLength(sessionsMade);
  });

  it("closes the tab the keyboard is in, keeping the item in its space", async () => {
    const { api, store } = await mount();
    await store.getState().openInSidePane("sa", "i-term", { focus: true });
    expect(store.getState().focusedLeafId).toBe(findSidePane(store.getState().layout!, "i-a")!.id);
    await store.getState().closeInPane();
    expect(findSidePane(store.getState().layout!, "i-a")).toBeNull();
    expect(allItems(store.getState().layout!)).toEqual(["i-a"]);
    expect(store.getState().items.some((i) => i.id === "i-term")).toBe(true);
    expect(api.calls.some((c) => c.startsWith("deleteItem"))).toBe(false);
  });

  it("takes the focused session out of a split, and the other takes the window", async () => {
    const { api, store } = await mount();
    await store.getState().openItemAt("i-b", leafOf(store, "i-a"), "right");
    expect(mains(store)).toEqual(["i-a", "i-b"]);
    expect(store.getState().focusedLeafId).toBe(leafOf(store, "i-b"));
    await store.getState().closeInPane();
    expect(mains(store)).toEqual(["i-a"]);
    // Out of the view, never out of the space.
    expect(store.getState().items.some((i) => i.id === "i-b")).toBe(true);
    expect(api.calls.some((c) => c.startsWith("deleteItem"))).toBe(false);
  });

  it("drops an empty pane beside a session, and keeps the session and the keyboard where they were", async () => {
    // THE MUTANT: take the session out instead. One empty box is left, and the fresh-prompter rescue
    // makes a session nobody asked for to fill it.
    const { api, store } = await mount();
    await store.getState().splitFocused("row");
    expect(mains(store)).toEqual(["i-a", null]);
    store.getState().focusLeaf(leafOf(store, "i-a"));
    const sessionsMade = api.calls.filter((c) => c.startsWith("createSession")).length;
    await store.getState().closeInPane();
    expect(mains(store)).toEqual(["i-a"]);
    expect(store.getState().focusedLeafId).toBe(leafOf(store, "i-a"));
    expect(api.calls.filter((c) => c.startsWith("createSession"))).toHaveLength(sessionsMade);
  });

  it("drops the empty pane the keyboard is in, as its trash says ⌘W does", async () => {
    const { store } = await mount();
    await store.getState().splitFocused("row");
    await store.getState().closeInPane();
    expect(mains(store)).toEqual(["i-a"]);
  });

  it("acts on the pane it is given, not the focused one — the ⋯ row of another pane", async () => {
    const { store } = await mount();
    await store.getState().openItemAt("i-b", leafOf(store, "i-a"), "right");
    await store.getState().closeInPane(leafOf(store, "i-a"));
    expect(mains(store)).toEqual(["i-b"]);
  });

  it("closes a pane that holds anything else, as its bar says, and a fresh prompter follows the last", async () => {
    const { api, store } = await mount();
    await store.getState().openItem("i-term", leafOf(store, "i-a"));
    expect(mains(store)).toEqual(["i-term"]);
    await store.getState().closeInPane();
    expect(allItems(store.getState().layout!)).not.toContain("i-term");
    expect(api.calls.some((c) => c.startsWith("createSession"))).toBe(true);
  });

  it("does nothing while a page covers the panes", async () => {
    // THE MUTANT: no guard. ⌘W over the Library would close a tab nobody can see.
    const { store } = await mount();
    await store.getState().openInSidePane("sa", "i-term", { focus: true });
    store.getState().openDestinationPage("library-page");
    await store.getState().closeInPane();
    expect(findSidePane(store.getState().layout!, "i-a")?.tabs).toEqual(["i-term"]);
  });
});
