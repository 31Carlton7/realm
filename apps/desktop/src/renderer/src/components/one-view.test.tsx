import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { allItems, findLeafOfItem, findSidePane } from "@realm/contracts";
import { Main } from "../App";
import { Sidebar } from "./sidebar/Sidebar";
import { CommandPalette } from "./CommandPalette";
import { useGlobalHotkeys } from "../hotkeys";
import { StoreContext, createAppStore } from "../state/store";
import { fakeApi, item, session, space } from "../state/store.test-fakes";
import { setBrowserBridgesForTests } from "../panes/browser/browser-client";
import { fakeBrowserBridges } from "../panes/browser/browser-bridges.test-fakes";

// A side pane mounts its browser tabs, and a BrowserPane needs its bridges and a ResizeObserver.
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  setBrowserBridgesForTests(fakeBrowserBridges());
});
afterEach(() => { setBrowserBridgesForTests(null); vi.unstubAllGlobals(); });

/**
 * The window's one view, rendered (Plan 27): a pane or a split of two, each with its own side pane,
 * and no strip of named splits above them. The store's rules are `state/store-view.test.ts`; this is
 * what the shell draws from them.
 */

const THREE = {
  s1: [item("i1", "s1", { kind: "artifact", title: "One" }), item("i2", "s1", { kind: "artifact", title: "Two" }),
    item("i3", "s1", { kind: "artifact", title: "Three" })],
};

/** Boot a store with three (unopened) items in s1 and render the whole shell. */
async function mount(render_: "main" | "sidebar" | "both" = "both", over: Parameters<typeof fakeApi>[0] = {}) {
  const api = fakeApi({ items: THREE, ...over });
  const store = createAppStore(api);
  await store.getState().boot();
  const Shell = () => {
    useGlobalHotkeys(store);
    return (
      <StoreContext.Provider value={store}>
        {render_ !== "main" && <Sidebar />}
        {render_ !== "sidebar" && <Main />}
      </StoreContext.Provider>
    );
  };
  const r = render(<Shell />);
  return { store, api, ...r };
}

/** Open i1 and i2 into a split of two. */
async function twoPanes(store: Awaited<ReturnType<typeof mount>>["store"]) {
  await act(async () => { await store.getState().openItem("i1"); });
  await act(async () => { await store.getState().splitFocused("row"); });
  await act(async () => { await store.getState().openItem("i2"); });
}

describe("one view, no named splits", () => {
  it("draws the panes and nothing above them — no bar of splits, at any number of panes", async () => {
    // THE MUTANT: bring back a strip of named splits. The window shows what is open; a second list
    // of arrangements above it is the structure Plan 27 retired.
    const { store, container } = await mount("main");
    await twoPanes(store);
    expect(screen.queryByRole("toolbar", { name: "Splits" })).toBeNull();
    expect(screen.queryByRole("tablist", { name: /split/i })).toBeNull();
    expect(container.querySelector(".group-bar")).toBeNull();
    expect(container.querySelector(".main > .panehost, .panehost")).not.toBeNull();
  });

  it("shows two spaces' sessions side by side, each beside its own side pane", async () => {
    const { store } = await mount("main", {
      spaces: [space("s1", "p1", "Versed"), space("s2", "p1", "Homework")],
      items: { s1: [item("ia", "s1", { kind: "session", refId: "a", title: "Alpha" }), item("wa", "s1", { kind: "browser", refId: "ba", title: "Alpha web" })],
        s2: [item("ib", "s2", { kind: "session", refId: "b", title: "Bravo" }), item("wb", "s2", { kind: "browser", refId: "bb", title: "Bravo web" })] },
      sessions: [session("a", "s1"), session("b", "s2")],
    });
    await act(async () => { await store.getState().openItem("ia"); });
    await act(async () => { await store.getState().openItemBeside("ib"); });
    await act(async () => { await store.getState().openInSidePane("a", "wa"); });
    await act(async () => { await store.getState().openInSidePane("b", "wb"); });
    expect(findSidePane(store.getState().layout!, "ia")?.tabs).toEqual(["wa"]);
    expect(findSidePane(store.getState().layout!, "ib")?.tabs).toEqual(["wb"]);
    await waitFor(() => expect(document.querySelectorAll(".panel[data-tabbed]")).toHaveLength(2));
    expect(document.querySelectorAll(".panel").length).toBe(4);
  });
});

describe("focusing a pane", () => {
  it("renders only the focused pane — the others UNMOUNT rather than hide behind it", async () => {
    const { store } = await mount("main");
    await twoPanes(store);
    expect(screen.getByRole("button", { name: "Rename One" })).toBeInTheDocument();
    const leafId = findLeafOfItem(store.getState().layout!, "i2")!.id;
    await act(async () => { await store.getState().focusPaneFull(leafId); });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Rename One" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Rename Two" })).toBeInTheDocument();
  });

  /* The toolbar glyph is gone: it sat next to a ⋯ that already offered the same action one row
     down, and two controls for one action is one too many in a bar this narrow. THE mutant: put it
     back, and every pane bar spends a slot restating in a glyph what the menu says in words.

     The browser bar is the exception — W2.3 forbids it a dropdown, so there is no row there for a
     glyph to be a duplicate of, and it keeps the inline toggle. */
  it("the pane bar carries no focus glyph — the ⋯ row is the whole control", async () => {
    const { store } = await mount("main");
    await twoPanes(store);
    expect(screen.queryByRole("button", { name: "Focus Two" })).toBeNull();
    const leafId = findLeafOfItem(store.getState().layout!, "i2")!.id;
    await act(async () => { await store.getState().focusPaneFull(leafId); });
    await waitFor(() => expect(store.getState().zoomedLeafId()).not.toBeNull());
    // ...and still none once it IS focused, which is when a leftover glyph would flip to Unfocus.
    expect(screen.queryByRole("button", { name: "Unfocus Two" })).toBeNull();
  });

  /* One row, both directions, and it says which way it is pointing by its NAME — the accessible
     signal the lit glyph used to carry, now the only one. THE mutant: leave the row reading "Focus
     pane" while the pane is focused, and the single route back out of a focus stops describing
     itself. The ⌘⇧F beside it is asserted here because the row is now the only place it is printed. */
  it("the ⋯ row is ONE toggle: Focus, then Unfocus, with ⌘⇧F beside it", async () => {
    const { store } = await mount("main");
    await twoPanes(store);
    fireEvent.click(screen.getByRole("button", { name: "Pane menu for Two" }));
    const focus = await screen.findByRole("menuitem", { name: /Focus pane/ });
    expect(focus.querySelector(".menu-kbd")?.textContent).toBe("⌘⇧F");
    fireEvent.click(focus);
    await waitFor(() => expect(store.getState().zoomedLeafId()).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Pane menu for Two" }));
    const unfocus = await screen.findByRole("menuitem", { name: /Unfocus pane/ });
    // The same row flipped, not a second one that appeared beside it.
    expect(screen.queryByRole("menuitem", { name: /^Focus pane/ })).toBeNull();
    fireEvent.click(unfocus);
    await waitFor(() => expect(store.getState().zoomedLeafId()).toBeNull());
  });

  /* THE mutant: drop the `icon` from the layout rows. Everything still works and the menu goes back
     to a column of bare words, where Split right and Split down are told apart only by reading them
     — which is what a pane menu opened mid-gesture is trying to avoid. Asserted across ALL the shared
     rows, because a glyph on some of them and not the others is the ragged left edge `anyIcon`
     reserves its slot to prevent. */
  it("every shared row wears the glyph its action wears elsewhere in the app", async () => {
    const { store } = await mount("main");
    // One pane: the split rows are offered (a second pane is still possible), focus is not.
    await act(async () => { await store.getState().openItem("i1"); });
    fireEvent.click(await screen.findByRole("button", { name: "Pane menu for One" }));
    for (const name of [/Rename/, /Split right/, /Split down/, /^Close/, /^Delete/]) {
      const row = await screen.findByRole("menuitem", { name });
      expect(row.querySelector(".menu-icon > svg"), String(name)).not.toBeNull();
    }
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    // Two panes: focus is offered, and the split rows are not.
    await act(async () => { await store.getState().splitFocused("row"); });
    await act(async () => { await store.getState().openItem("i2"); });
    fireEvent.click(screen.getByRole("button", { name: "Pane menu for Two" }));
    const focus = await screen.findByRole("menuitem", { name: /Focus pane/ });
    expect(focus.querySelector(".menu-icon > svg")).not.toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Split right/ })).toBeNull();
  });

  /* A view with one leaf renders the same focused or not, so the toggle would be a lit button with
     no visible effect — the dead chrome the pane bar bans. THE mutant: drop the `canFocus` gate in
     PaneHost and the app's most common shape, one pane full width, grows a control that does nothing
     a user can see. */
  it("a solo pane gets no focus ROW at all — there is nothing for it to hide", async () => {
    const { store } = await mount("main");
    await act(async () => { await store.getState().openItem("i1"); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Rename One" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Pane menu for One" }));
    expect(screen.queryByRole("menuitem", { name: /Focus pane/ })).toBeNull();
  });

  it("leaves the pane in the view — the split comes back exactly as it was", async () => {
    const { store } = await mount("main");
    await twoPanes(store);
    const before = store.getState().layout;
    fireEvent.click(screen.getByRole("button", { name: "Pane menu for Two" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Focus pane/ }));
    await waitFor(() => expect(store.getState().zoomedLeafId()).not.toBeNull());
    expect(store.getState().layout).toBe(before);
    await act(async () => { await store.getState().unfocusPane(); });
    expect(store.getState().layout).toBe(before);
    await waitFor(() => expect(screen.getByRole("button", { name: "Rename One" })).toBeInTheDocument());
  });

  it("⌘⇧F toggles focus on the focused pane", async () => {
    const { store } = await mount("main");
    await twoPanes(store);
    const leafId = store.getState().focusedLeafId;
    await act(async () => { fireEvent.keyDown(window, { key: "F", metaKey: true, shiftKey: true }); });
    await waitFor(() => expect(store.getState().zoomedLeafId()).toBe(leafId));
    await act(async () => { fireEvent.keyDown(window, { key: "F", metaKey: true, shiftKey: true }); });
    await waitFor(() => expect(store.getState().zoomedLeafId()).toBeNull());
  });

});

// The pane host must never be handed a zoom it cannot render — but a stale id (a leaf pruned by a
// concurrent edit) must degrade to the ordinary split rather than to a blank screen.
describe("a stale focus", () => {
  it("falls back to the full split rather than rendering nothing", async () => {
    const { store } = await mount("main");
    await twoPanes(store);
    await act(async () => {
      const view = store.getState().view!;
      store.setState({ view: { ...view, zoomedLeafId: "L-gone" } });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Rename One" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Rename Two" })).toBeInTheDocument();
  });
});

describe("the sidebar while it still lists a space's rows", () => {
  it("lists what of the space is on screen under one Open heading, and offers no New split", async () => {
    const { store } = await mount("sidebar");
    await twoPanes(store);
    await waitFor(() => expect(screen.getByText("Open")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /New split/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show Main" })).toBeNull();
  });
});

describe("command palette", () => {
  const open = async () => {
    const api = fakeApi({ items: THREE });
    const store = createAppStore(api);
    await store.getState().boot();
    const r = render(
      <StoreContext.Provider value={store}><Main /><CommandPalette /></StoreContext.Provider>,
    );
    return { store, ...r };
  };
  const show = async (store: Awaited<ReturnType<typeof open>>["store"]) => {
    await act(async () => { store.getState().setPaletteOpen(true); });
  };

  it("offers no splits to switch to, no New split and no grid layouts", async () => {
    const { store } = await open();
    await twoPanes(store);
    await show(store);
    expect(screen.queryByText(/^Split: /)).toBeNull();
    expect(screen.queryByText("New split")).toBeNull();
    expect(screen.queryByText(/^Layout: /)).toBeNull();
    // Split right stays: it is how a second pane is made from the keyboard.
    expect(screen.getByText("Split right")).toBeInTheDocument();
  });

  it("offers Focus for the focused pane, then Unfocus, and the pick toggles it", async () => {
    const { store } = await open();
    await twoPanes(store);
    await show(store);
    fireEvent.click(screen.getByText("Focus “Two”"));
    await waitFor(() => expect(store.getState().zoomedLeafId()).not.toBeNull());
    await show(store);
    fireEvent.click(screen.getByText("Unfocus pane"));
    await waitFor(() => expect(store.getState().zoomedLeafId()).toBeNull());
  });

  it("opens an item of another space in the main view, without a switch that opens anything else", async () => {
    const api = fakeApi({ items: { ...THREE, s2: [item("j1", "s2", { kind: "artifact", title: "Elsewhere" })] } });
    const store = createAppStore(api);
    await store.getState().boot();
    render(<StoreContext.Provider value={store}><Main /><CommandPalette /></StoreContext.Provider>);
    await act(async () => { await store.getState().openItem("i1"); });
    await show(store);
    fireEvent.click(await screen.findByText("Elsewhere"));
    await waitFor(() => expect(allItems(store.getState().layout!)).toEqual(["j1"]));
    expect(store.getState().activeSpaceId).toBe("s2");
    expect(findLeafOfItem(store.getState().layout!, "j1")).not.toBeNull();
  });
});
