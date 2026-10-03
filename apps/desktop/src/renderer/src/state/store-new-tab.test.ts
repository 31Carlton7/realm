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

/**
 * The session's terminal, from its pane bar's button, ⌘J or View ▸ Show Terminal — all three run
 * `showSessionTerminal`. In its default place it is a tab of the session's side pane, started in the
 * session's checkout the way the new-tab page's Terminal starts one, and a press goes to the one it
 * has rather than making another. Docked to the pane's foot by Settings, it is the dock it always was.
 */
describe("the session's terminal, as a tab of its side pane", () => {
  const WORKTREE = "/repo/.worktrees/fix-parser";
  /** The lead working in a worktree, focused, with or without a side pane holding one browser. */
  async function lead(opts: { sidePane?: boolean } = {}) {
    const api = fakeApi({
      items: { s1: [item("i-lead", "s1", { kind: "session", refId: "lead", title: "Lead" }), item("i-br", "s1", { kind: "browser", refId: "br", title: "Job 1" })] },
      sessions: [session("lead", "s1", { cwd: WORKTREE })],
    });
    const store = createAppStore(api);
    await store.getState().boot();
    await store.getState().openItem("i-lead");
    if (opts.sidePane !== false) await store.getState().openInSidePane("lead", "i-br");
    return { api, store };
  }
  const terminals = (store: Store) => store.getState().items.filter((i) => i.kind === "terminal");
  const made = (api: ReturnType<typeof fakeApi>) => api.calls.filter((c) => c.startsWith("createTerminal")).length;
  const leafOf = (store: Store, itemId: string) => findLeafOfItem(store.getState().layout!, itemId)!.id;

  it("opens a shell in the session's checkout as a tab of its side pane, with the keyboard", async () => {
    // THE MUTANTS: leave the cwd off, and the shell opens in the space's primary checkout while the
    // session works in a worktree; drop the focus, and the keyboard stays in the prompter.
    const { api, store } = await lead({ sidePane: false });
    await store.getState().showSessionTerminal("lead");
    expect(api.calls).toContain(`createTerminal:s1:${WORKTREE}`);
    const term = terminals(store)[0]!.id;
    expect(side(store)).toMatchObject({ itemId: term, tabs: [term] });
    expect(store.getState().focusedLeafId).toBe(side(store).id);
    // Never the dock, and never the session's hidden shell: the tab IS the terminal now.
    expect(store.getState().sessionDock.lead).toBeUndefined();
    expect(api.calls.some((c) => c.startsWith("openSessionTerminal"))).toBe(false);
  });

  it("joins the side pane the session already has, after the tab showing", async () => {
    // THE MUTANT: open it beside the session like a pane of its own — a second column next to the
    // side pane, which is the column-per-thing layout the side pane exists to end.
    const { store } = await lead();
    await store.getState().showSessionTerminal("lead");
    expect(side(store).tabs).toEqual(["i-br", terminals(store)[0]!.id]);
    const root = store.getState().layout!;
    expect(root.type === "split" ? root.children : [root]).toHaveLength(2);
  });

  it("goes to the tab it has on a second press, bringing it to the front, rather than starting another shell", async () => {
    // THE MUTANT: skip the lookup, and every press is a new shell — a strip filling with terminals.
    const { api, store } = await lead();
    await store.getState().showSessionTerminal("lead");
    const term = terminals(store)[0]!.id;
    await store.getState().openItem("i-br");
    store.getState().focusLeaf(leafOf(store, "i-lead"));
    await store.getState().showSessionTerminal("lead");
    expect(made(api)).toBe(1);
    expect(side(store).itemId).toBe(term);
    expect(store.getState().focusedLeafId).toBe(side(store).id);
  });

  it("brings back the same shell after its tab was put away with ⌘W", async () => {
    // THE MUTANT: forget which terminal the button made. The press after ⌘W starts a second shell, and
    // the first one — scrollback and all — is left in the sidebar.
    const { api, store } = await lead();
    await store.getState().showSessionTerminal("lead");
    const term = terminals(store)[0]!.id;
    await store.getState().closeFromLayout(term);
    expect(side(store).tabs).toEqual(["i-br"]);
    await store.getState().showSessionTerminal("lead");
    expect(made(api)).toBe(1);
    expect(side(store)).toMatchObject({ itemId: term, tabs: ["i-br", term] });
  });

  it("goes to a terminal already among the side pane's tabs — one the new-tab page made, or one back after a relaunch", async () => {
    // THE MUTANT: look only at what this run's button made, and after a relaunch the press starts a
    // second shell beside the one already in the strip.
    const { api, store } = await lead();
    const { itemId } = await api.createTerminal("s1", WORKTREE);
    await store.getState().refreshItems();
    await store.getState().openInSidePane("lead", itemId);
    await store.getState().openItem("i-br");
    const before = made(api);
    await store.getState().showSessionTerminal("lead");
    expect(made(api)).toBe(before);
    expect(side(store).itemId).toBe(itemId);
  });

  it("goes to a terminal showing in the strip before bringing back one that was put away", async () => {
    // The button's own shell was closed with ⌘W and the new-tab page made another. THE MUTANT: ask the
    // button's memory first, and a press puts a second terminal in the strip beside the one already
    // there.
    const { api, store } = await lead();
    await store.getState().showSessionTerminal("lead");
    await store.getState().closeFromLayout(terminals(store)[0]!.id);
    const { itemId: other } = await api.createTerminal("s1", WORKTREE);
    await store.getState().refreshItems();
    await store.getState().openInSidePane("lead", other);
    store.getState().focusLeaf(leafOf(store, "i-lead"));
    await store.getState().showSessionTerminal("lead");
    expect(side(store)).toMatchObject({ itemId: other, tabs: ["i-br", other] });
  });

  it("goes to it where the user put it, without pulling it back into the side pane", async () => {
    // A tab dragged to an edge is part of the user's own layout. THE MUTANT: always open it in the side
    // pane, and the press yanks it back into the strip.
    const { store } = await lead();
    await store.getState().showSessionTerminal("lead");
    const term = terminals(store)[0]!.id;
    await store.getState().openItemAt(term, leafOf(store, "i-lead"), "bottom");
    const where = leafOf(store, term);
    store.getState().focusLeaf(leafOf(store, "i-lead"));
    await store.getState().showSessionTerminal("lead");
    expect(leafOf(store, term)).toBe(where);
    expect(store.getState().focusedLeafId).toBe(where);
    expect(side(store).tabs).toEqual(["i-br"]);
  });

  it("starts one shell for two presses in flight", async () => {
    // THE MUTANT: no join, and a double click opens two terminals.
    const { api, store } = await lead();
    api.delays["createTerminal"] = 10;
    await Promise.all([store.getState().showSessionTerminal("lead"), store.getState().showSessionTerminal("lead")]);
    expect(made(api)).toBe(1);
    expect(terminals(store)).toHaveLength(1);
  });

  it("types an offered command into that tab's shell, with no newline", async () => {
    // The install card's "Open in terminal". THE MUTANT: write it into the session's hidden shell, which
    // nothing on screen shows any more — the button would appear to do nothing.
    const { api, store } = await lead();
    await store.getState().prefillTerminal("lead", "codex login");
    const term = terminals(store)[0]!;
    expect(api.calls).toContain(`prefillTerminal:${term.refId}=codex login`);
    expect(side(store).itemId).toBe(term.id);
    expect(api.calls.some((c) => c.startsWith("openSessionTerminal"))).toBe(false);
  });

  it("docked to the pane's foot by Settings, toggles the dock and makes no tab", async () => {
    // THE MUTANT: ignore the setting, and Bottom opens a tab beside the session as Right does.
    const { api, store } = await lead({ sidePane: false });
    store.setState({ terminalDock: "bottom" });
    await store.getState().showSessionTerminal("lead");
    expect(store.getState().sessionDock.lead).toEqual({ kind: "terminal" });
    await store.getState().showSessionTerminal("lead");
    expect(store.getState().sessionDock.lead).toBeUndefined();
    expect(made(api)).toBe(0);
    expect(findSidePane(store.getState().layout!, "i-lead")).toBeNull();
  });
});
