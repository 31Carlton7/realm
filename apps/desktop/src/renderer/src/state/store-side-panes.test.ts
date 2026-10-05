import { describe, expect, it } from "vitest";
import { allItems, findLeafOfItem, findSidePane } from "@realm/contracts";
import { createAppStore } from "./store";
import { fakeApi, item, session } from "./store.test-fakes";

/**
 * The side panes put away and brought back (the toggle at the window's top right): every tab stays
 * open and where it was, and a person's open brings them back while an agent's does not. Every test
 * names the one-line change that would make it fail.
 */

type Store = ReturnType<typeof createAppStore>;
const side = (store: Store) => findSidePane(store.getState().layout!, "i-lead");

/** The lead on screen with a side pane holding a browser and a terminal. */
async function mount(opts: { sidePane?: boolean; settings?: Record<string, unknown> } = {}) {
  const api = fakeApi({
    items: { s1: [
      item("i-lead", "s1", { kind: "session", refId: "lead", title: "Lead" }),
      item("i-br", "s1", { kind: "browser", refId: "br", title: "Delta careers" }),
      item("i-term", "s1", { kind: "terminal", refId: "term", title: "Shell" }),
      item("i-docs", "s1", { kind: "documents", refId: "docs", title: "Documents" }),
    ] },
    sessions: [session("lead", "s1")],
    settings: opts.settings ?? {},
  });
  const store = createAppStore(api);
  await store.getState().boot();
  await store.getState().openItem("i-lead");
  if (opts.sidePane !== false) {
    await store.getState().openInSidePane("lead", "i-br");
    await store.getState().openInSidePane("lead", "i-term");
  }
  return { api, store };
}

describe("putting the side panes away", () => {
  it("keeps every tab open where it was, and brings the pane back as it was", async () => {
    // THE MUTANT: hiding by closing — the tabs leave the layout, and showing again has nothing to show.
    const { api, store } = await mount();
    const before = side(store)!;
    await store.getState().toggleSidePanes();
    expect(store.getState().sidePanesHidden).toBe(true);
    expect(api.calls).toContain("setSetting:ui.sidePanesHidden=true");
    expect(side(store)).toEqual(before);
    expect(allItems(store.getState().layout!)).toEqual(["i-lead", "i-br", "i-term"]);
    await store.getState().toggleSidePanes();
    expect(store.getState().sidePanesHidden).toBe(false);
    expect(side(store)).toEqual(before);
  });

  it("takes the keyboard out of a side pane as it goes, to the session it served", async () => {
    const { store } = await mount();
    store.getState().focusLeaf(side(store)!.id);
    await store.getState().toggleSidePanes();
    expect(store.getState().focusedLeafId).toBe(findLeafOfItem(store.getState().layout!, "i-lead")!.id);
  });

  it("comes back for a tool a person opens from the session, and stays away for an agent's open", async () => {
    // THE MUTANTS: a person's open landing in a pane they cannot see, or an agent's quiet open
    // undoing what the person just put away.
    const { store } = await mount();
    await store.getState().toggleSidePanes();
    await store.getState().openInSidePane("lead", "i-docs");
    expect(store.getState().sidePanesHidden).toBe(true);
    expect(side(store)!.tabs).toContain("i-docs");
    await store.getState().openInSidePane("lead", "i-docs", { focus: true });
    expect(store.getState().sidePanesHidden).toBe(false);
    expect(store.getState().focusedLeafId).toBe(side(store)!.id);
  });

  it("comes back when a person goes to one of its tabs", async () => {
    // A sidebar row, the palette, a link: "go there" for an item that is a tab behind the toggle.
    const { store } = await mount();
    await store.getState().toggleSidePanes();
    await store.getState().openItem("i-br");
    expect(store.getState().sidePanesHidden).toBe(false);
    expect(side(store)!.itemId).toBe("i-br");
  });

  it("never moves the keyboard into a side pane that is put away", async () => {
    const { store } = await mount();
    await store.getState().openItem("i-lead");
    await store.getState().toggleSidePanes();
    store.getState().focusNeighbor("right");
    expect(store.getState().focusedLeafId).toBe(findLeafOfItem(store.getState().layout!, "i-lead")!.id);
  });

  it("with no side pane, opens one on a new tab beside the session — not a split of its own", async () => {
    // THE MUTANT: a toggle that does nothing until something has opened a side pane, or one that
    // falls through to a plain split.
    const { api, store } = await mount({ sidePane: false });
    await store.getState().toggleSidePanes();
    expect(api.calls).toContain("createBrowser:s1");
    const strip = side(store)!;
    expect(strip.tabs).toHaveLength(1);
    expect(store.getState().focusedLeafId).toBe(strip.id);
    const root = store.getState().layout!;
    expect(root.type === "split" ? root.children : [root]).toHaveLength(2);
  });

  it("comes back put away after a relaunch", async () => {
    const { store } = await mount({ settings: { "ui.sidePanesHidden": true } });
    expect(store.getState().sidePanesHidden).toBe(true);
    const fresh = createAppStore(fakeApi({ settings: { "ui.sidePanesHidden": "yes" } }));
    await fresh.getState().boot();
    expect(fresh.getState().sidePanesHidden).toBe(false);
  });
});
