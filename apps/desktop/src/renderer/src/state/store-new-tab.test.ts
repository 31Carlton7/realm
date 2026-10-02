import { describe, expect, it } from "vitest";
import { activeGroup, allItems, findLeafOfItem, findSidePane } from "@realm/contracts";
import { createAppStore } from "./store";
import { fakeApi, item, session } from "./store.test-fakes";

/**
 * A person's new tab in a side pane (W5): a blank browser after the tab showing, with the keyboard,
 * and — in full view — the side pane filling the host. Every test names the one-line change that
 * would make it fail.
 */

type Store = ReturnType<typeof createAppStore>;
const side = (store: Store) => findSidePane(store.getState().layout!, "i-lead")!;
/** The blank browser the fake made last — the new tab. */
const newest = (store: Store) => store.getState().items.filter((i) => i.kind === "browser").at(-1)!.id;

/** The lead focused, with a side pane holding one agent-opened browser. */
async function mount(opts: { sidePane?: boolean } = {}) {
  const api = fakeApi({
    items: { s1: [item("i-lead", "s1", { kind: "session", refId: "lead", title: "Lead" }), item("i-br", "s1", { kind: "browser", refId: "br", title: "Delta careers" })] },
    sessions: [session("lead", "s1")],
  });
  const store = createAppStore(api);
  await store.getState().boot();
  await store.getState().openItem("i-lead");
  if (opts.sidePane !== false) await store.getState().openInSidePane("lead", "i-br");
  return { api, store };
}

describe("a new tab in a side pane", () => {
  it("joins the strip after the tab showing, blank, with the keyboard", async () => {
    // THE MUTANT: open it without naming the strip's leaf — it lands in the focused pane and evicts
    // the session the person was in.
    const { api, store } = await mount();
    await store.getState().newTab(side(store).id);
    const id = newest(store);
    expect(api.calls).toContain("createBrowser:s1");
    expect(side(store)).toMatchObject({ itemId: id, tabs: ["i-br", id] });
    expect(store.getState().focusedLeafId).toBe(side(store).id);
    expect(allItems(store.getState().layout!)).toContain("i-lead");
  });

  it("in full view, fills the host with the side pane — pane focus, under a tab strip's name", async () => {
    // THE MUTANT: drop the zoom, and "full view" is the same tab in the same half of the window.
    const { store } = await mount();
    await store.getState().newTab(side(store).id, { full: true });
    expect(activeGroup(store.getState().groups!).zoomedLeafId).toBe(side(store).id);
    expect(side(store).itemId).toBe(newest(store));
  });

  it("from the focused session's own pane, goes to its side pane rather than a split of its own", async () => {
    // ⌘⇧B with the keyboard in the lead. THE MUTANT: read only the focused leaf's strip, and a session
    // with a side pane beside it gets another browser column next to that.
    const { store } = await mount();
    await store.getState().openItem("i-lead");
    await store.getState().newTab();
    expect(side(store).tabs).toEqual(["i-br", newest(store)]);
    const root = store.getState().layout!;
    expect(root.type === "split" ? root.children : [root]).toHaveLength(2);
  });

  it("makes the side pane beside a session that has none yet", async () => {
    // THE MUTANT: fall straight through to the plain split — a browser in a leaf with no strip, and
    // the next thing an agent opens starts a side pane of its own beside it.
    const { store } = await mount({ sidePane: false });
    await store.getState().newTab();
    const id = newest(store);
    expect(side(store)).toMatchObject({ itemId: id, tabs: [id] });
    expect(store.getState().focusedLeafId).toBe(side(store).id);
  });

  it("from a tab of the strip, joins that strip", async () => {
    // The keyboard is in the side pane's browser. THE MUTANT: ignore the focused leaf's strip, and a
    // browser — which has no side pane of its own — splits the pane it is in.
    const { store } = await mount();
    store.getState().focusLeaf(side(store).id);
    await store.getState().newTab();
    expect(side(store).tabs).toHaveLength(2);
    expect(findLeafOfItem(store.getState().layout!, newest(store))!.id).toBe(side(store).id);
  });
});
