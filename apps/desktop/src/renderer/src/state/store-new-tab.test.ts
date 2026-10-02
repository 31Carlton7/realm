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

/**
 * The new-tab page's tools (W6): each opens where the blank tab stood and the blank tab goes; Files
 * opens the ⌘P palette, and the file picked there takes the tab's place.
 */
describe("a tool picked on a new tab", () => {
  /** The lead's side pane with Job 1 and a fresh blank tab after it, showing. */
  async function withNewTab(over: Parameters<typeof session>[2] = {}) {
    const api = fakeApi({
      items: { s1: [item("i-lead", "s1", { kind: "session", refId: "lead", title: "Lead" }), item("i-br", "s1", { kind: "browser", refId: "br", title: "Job 1" })] },
      sessions: [session("lead", "s1", over)],
    });
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().openItem("i-lead");
    await store.getState().openInSidePane("lead", "i-br");
    await store.getState().newTab(side(store).id);
    return { api, store, blank: newest(store) };
  }
  const kindOf = (store: Store, id: string) => store.getState().items.find((i) => i.id === id)?.kind;

  it("Terminal takes the blank tab's place in the strip, and the blank tab goes", async () => {
    // THE MUTANT: open the terminal and keep the blank tab — "+ › New tab › Terminal" leaves an empty
    // browser behind every time.
    const { api, store, blank } = await withNewTab();
    await store.getState().openFromNewTab(blank, "terminal");
    const tabs = side(store).tabs!;
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toBe("i-br");
    expect(kindOf(store, tabs[1]!)).toBe("terminal");
    expect(side(store).itemId).toBe(tabs[1]);
    expect(api.calls).toContain(`deleteItem:${blank}`);
  });

  it("lands in the tab's own strip even with the keyboard somewhere else", async () => {
    // THE MUTANT: open the tool without naming the blank tab's leaf — it goes to whichever pane has
    // the keyboard, and evicts the lead.
    const { store, blank } = await withNewTab();
    store.getState().focusLeaf(findLeafOfItem(store.getState().layout!, "i-lead")!.id);
    await store.getState().openFromNewTab(blank, "machine");
    expect(kindOf(store, side(store).tabs![1]!)).toBe("machine");
    expect(allItems(store.getState().layout!)).toContain("i-lead");
  });

  it("starts a terminal in the checkout of the session the strip serves", async () => {
    // THE MUTANT: leave the cwd off, and the shell opens in the space's primary checkout while the
    // session it sits beside works in a worktree.
    const { api, store, blank } = await withNewTab({ cwd: "/repo/.worktrees/fix-parser" });
    await store.getState().openFromNewTab(blank, "terminal");
    expect(api.calls).toContain("createTerminal:s1:/repo/.worktrees/fix-parser");
  });

  it("opens documents on that session's own checkout", async () => {
    const { api, store, blank } = await withNewTab({ environmentId: "env-worktree" });
    await store.getState().openFromNewTab(blank, "documents");
    expect(api.calls).toContain("createDocuments:s1:env-worktree");
    expect(kindOf(store, side(store).itemId!)).toBe("documents");
  });

  it("goes to a tool already open rather than pulling it out of the user's own arrangement", async () => {
    // The documents pane is one per checkout, and this one is already a pane of the user's. THE
    // MUTANT: test only the blank tab's own leaf, and the user's pane is moved into the side pane.
    const { api, store, blank } = await withNewTab();
    const { itemId: docs } = await api.createDocuments("s1");
    await store.getState().refreshItems();
    await store.getState().openItemAt(docs, findLeafOfItem(store.getState().layout!, "i-lead")!.id, "bottom");
    const before = findLeafOfItem(store.getState().layout!, docs)!.id;
    await store.getState().openFromNewTab(blank, "documents");
    expect(findLeafOfItem(store.getState().layout!, docs)!.id).toBe(before);
    expect(store.getState().focusedLeafId).toBe(before);
    expect(side(store).tabs).toEqual(["i-br"]);
  });

  it("Files opens the ⌘P palette, and the file picked there takes the blank tab's place", async () => {
    // THE MUTANT: open the picked file the ordinary way — it joins the strip, and the blank tab the
    // person was replacing stays.
    const { api, store, blank } = await withNewTab();
    await store.getState().openFromNewTab(blank, "files");
    expect(store.getState()).toMatchObject({ paletteOpen: true, paletteMode: "files", paletteReplaces: blank });
    await store.getState().openDocumentPath("README.md");
    store.getState().setPaletteOpen(false);
    expect(kindOf(store, side(store).itemId!)).toBe("documents");
    expect(side(store).tabs).toHaveLength(2);
    expect(api.calls).toContain(`deleteItem:${blank}`);
    expect(store.getState().paletteReplaces).toBeNull();
  });

  it("places the picked file even when the server's broadcast of the open beats the call's answer", async () => {
    // It does, on the wire: the server broadcasts `documents.openRequested` while answering, and the
    // palette has closed by then — it closes as the row is picked. THE MUTANT: let that broadcast
    // open the pane quietly beside the focused one, and the pick finds the file already on screen —
    // gone to in a split of its own, and never in the tab's place.
    const { api, store, blank } = await withNewTab();
    await store.getState().openFromNewTab(blank, "files");
    api.delays["openDocumentPath:s1"] = 20;
    const picking = store.getState().openDocumentPath("README.md");
    store.getState().setPaletteOpen(false);
    await new Promise((r) => setTimeout(r, 5));
    const docs = api.data.items.s1!.find((i) => i.kind === "documents")!;
    await store.getState().applyDocumentOpenRequested({ spaceId: "s1", environmentId: "env-s1", documentsId: docs.refId, itemId: docs.id, path: "README.md" });
    await picking;
    const itemId = docs.id;
    expect(side(store).tabs).toEqual(["i-br", itemId]);
    const root = store.getState().layout!;
    expect(root.type === "split" ? root.children : [root]).toHaveLength(2);
  });

  it("forgets the blank tab when the palette is dismissed and opened again", async () => {
    // THE MUTANT: clear the mark only on a pick. Dismiss the palette, press ⌘P later, and the file
    // picked then deletes a tab nobody asked to replace.
    const { api, store, blank } = await withNewTab();
    await store.getState().openFromNewTab(blank, "files");
    store.getState().setPaletteOpen(false);
    store.getState().setPaletteOpen(true, "files");
    expect(store.getState().paletteReplaces).toBeNull();
    await store.getState().openDocumentPath("README.md");
    expect(api.calls).not.toContain(`deleteItem:${blank}`);
  });

  it("forgets it too when something else took the palette down, as a sheet does", async () => {
    // A sheet closes the palette without going through its own close. THE MUTANT: keep the mark on a
    // fresh open, and the next ⌘P's pick takes the old blank tab's place.
    const { store, blank } = await withNewTab();
    await store.getState().openFromNewTab(blank, "files");
    store.getState().openSheet({ kind: "activity" });
    store.getState().closeSheet();
    store.getState().setPaletteOpen(true, "files");
    expect(store.getState().paletteReplaces).toBeNull();
  });

  it("never lets a file opened from elsewhere while the palette is shut take the tab's place", async () => {
    // THE MUTANT: honour the mark whatever is open. The palette went down under a sheet, and a file
    // opened from the session's Files panel deletes the new tab.
    const { api, store, blank } = await withNewTab();
    await store.getState().openFromNewTab(blank, "files");
    store.getState().openSheet({ kind: "activity" });
    await store.getState().openDocumentPath("notes.md");
    expect(api.calls).not.toContain(`deleteItem:${blank}`);
  });

  it("keeps the mark across ⌘⇧P, which is the same palette asked a different question", async () => {
    // THE MUTANT: clear it on every open. Switching from Files to Find in files mid-search, and then
    // picking a line, would leave the blank tab behind the file it opened.
    const { store, blank } = await withNewTab();
    await store.getState().openFromNewTab(blank, "files");
    store.getState().setPaletteOpen(true, "grep");
    expect(store.getState().paletteReplaces).toBe(blank);
  });
});
