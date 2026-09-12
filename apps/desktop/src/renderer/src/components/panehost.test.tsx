import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within, renderHook, act } from "@testing-library/react";
import { sessionEvent, type Item, type Layout } from "@realm/contracts";
import { PaneHost, zoneAt, type PaneHostProps } from "./PaneHost";
import { PanelBar } from "./PanelBar";
import { Main } from "../App";
import { useGlobalHotkeys } from "../hotkeys";
import { StoreContext, createAppStore, findEmptySiblingOf } from "../state/store";
import { fakeApi, item, session } from "../state/store.test-fakes";
import { setBrowserBridgesForTests } from "../panes/browser/browser-client";
import { fakeBrowserBridges } from "../panes/browser/browser-bridges.test-fakes";
import { reduceAll } from "../panes/session/transcript-model";
import { exited } from "./popover-exit.test-fakes";

// Item "A" below is a browser item, and BrowserPane (registered since Plan 11 W1) needs its bridges
// and a ResizeObserver on mount. These tests are about the HOST — inert fakes are enough.
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  setBrowserBridgesForTests(fakeBrowserBridges());
});
afterEach(() => { setBrowserBridgesForTests(null); vi.unstubAllGlobals(); });

const items: Item[] = [
  item("A", "s1", { kind: "browser", title: "Tab A", refId: "A" }),
  item("B", "s1", { kind: "artifact", title: "Tab B", refId: "B" }),
];

const split2: Layout = { type: "split", id: "root", dir: "row", sizes: [50, 50], children: [
  { type: "leaf", id: "L1", itemId: "A" },
  { type: "leaf", id: "L2", itemId: "B" },
] };

function renderHost(over: Partial<PaneHostProps> = {}) {
  const props: PaneHostProps = {
    layout: split2, items, focusedLeafId: "L1",
    onFocus: vi.fn(), onClose: vi.fn(), onSplit: vi.fn(), onDropItem: vi.fn(), onEqualize: vi.fn(),
    onCloseEmpty: vi.fn(),
    ...over,
  };
  // PanelBar reads the store (rename/delete, per-kind meta), so every host render needs a provider.
  const api = fakeApi({ items: { s1: [...items] } });
  const store = createAppStore(api);
  return { ...render(<StoreContext.Provider value={store}><PaneHost {...props} /></StoreContext.Provider>), props, api, store };
}

const REALM_TYPE = "application/x-realm-item";
const NEW_SESSION_TYPE = "application/x-realm-new-session";
/** DataTransfer stub — jsdom's DataTransfer isn't constructable, so tests build the plain object the
 *  handlers actually touch: `types` (for the custom-type filter) and `getData` (keyed, so a handler
 *  reading the wrong key gets an obviously-wrong sentinel instead of silently working). */
function dt(itemId: string, types: string[] = [REALM_TYPE]) {
  return {
    types,
    getData: (key: string) => (key === REALM_TYPE ? itemId : `wrong-key:${key}`),
    setData: () => {},
    effectAllowed: "",
    dropEffect: "",
  };
}

function newSessionDt() {
  return {
    types: [NEW_SESSION_TYPE],
    getData: (key: string) => (key === NEW_SESSION_TYPE ? "new-session" : ""),
    setData: () => {}, effectAllowed: "copy", dropEffect: "copy",
  };
}

/** jsdom's layout engine always reports zero-size rects; stub it so zoneAt has real numbers to chew on. */
function stubRect(el: Element, rect: { width: number; height: number; left?: number; top?: number }) {
  const left = rect.left ?? 0, top = rect.top ?? 0;
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    width: rect.width, height: rect.height, left, top,
    right: left + rect.width, bottom: top + rect.height,
    x: left, y: top, toJSON: () => {},
  } as DOMRect);
}

/** This jsdom build has no DragEvent constructor, so fireEvent.dragOver(el, {dataTransfer, clientX, ...})
 *  silently drops clientX/clientY (they fall back to a plain Event, which ignores unknown init keys — only
 *  `dataTransfer`/`clipboardData` get special-cased by testing-library). Build the event by hand instead:
 *  a plain bubbling Event with dataTransfer/clientX/clientY assigned as real own properties, which both
 *  native listeners and React's synthetic event layer read directly off the underlying event. */
function fireDrag(target: Element | Window, type: string, dataTransfer: unknown, coords: { clientX?: number; clientY?: number } = {}) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, "dataTransfer", { value: dataTransfer, configurable: true });
  Object.defineProperty(e, "clientX", { value: coords.clientX ?? 0, configurable: true });
  Object.defineProperty(e, "clientY", { value: coords.clientY ?? 0, configurable: true });
  fireEvent(target, e);
  return e;
}

const panel = (leafId: string) => {
  const el = document.querySelector<HTMLElement>(`.panel[data-leaf-id="${leafId}"]`);
  if (!el) throw new Error(`no panel for leaf ${leafId}`);
  return el;
};

describe("PaneHost", () => {
  it("renders a .panel per leaf whose PanelBar shows the item's title", () => {
    renderHost();
    expect(document.querySelectorAll(".panel")).toHaveLength(2);
    expect(within(panel("L1")).getByText("Tab A")).toHaveClass("panel-title");
    expect(within(panel("L2")).getByText("Tab B")).toHaveClass("panel-title");
    expect(panel("L1").querySelector(".panel-bar")).toBeInTheDocument();
  });

  /* An empty leaf gets the placeholder and a bar of its own — a title-less strip whose only control
     is the trash. It used to have no bar at all, which left ⌘W as the one way to be rid of the pane
     and nothing on screen to say so. It is NOT a full PanelBar: there is no item to name, rename,
     split from or navigate. */
  it("renders the placeholder and a trash-only bar for an empty leaf", () => {
    renderHost({ layout: { type: "leaf", id: "L", itemId: null }, items: [], focusedLeafId: "L" });
    expect(screen.getByText("Open something from the sidebar.")).toBeInTheDocument();
    const bar = document.querySelector(".panel-bar");
    expect(bar).toHaveClass("panel-bar-empty");
    expect(within(bar as HTMLElement).getByRole("button", { name: "Close this empty pane" })).toBeInTheDocument();
    // Nothing an empty pane cannot answer for: no title, no split, no pane menu.
    expect(bar!.querySelector(".panel-title")).toBeNull();
    expect(within(bar as HTMLElement).queryByRole("button", { name: /Split/ })).toBeNull();
    expect(within(bar as HTMLElement).queryByRole("button", { name: /Pane menu/ })).toBeNull();
  });

  it("the trash drops THIS leaf, by id", () => {
    const withEmpty: Layout = { type: "split", id: "root", dir: "row", sizes: [50, 50], children: [
      { type: "leaf", id: "L1", itemId: "A" },
      { type: "leaf", id: "L9", itemId: null },
    ] };
    const { props } = renderHost({ layout: withEmpty, focusedLeafId: "L1" });
    fireEvent.click(screen.getByRole("button", { name: "Close this empty pane" }));
    expect(props.onCloseEmpty).toHaveBeenCalledWith("L9");
    // And it is not the item-keyed close: an empty pane has no item to pass to it.
    expect(props.onClose).not.toHaveBeenCalled();
  });

  /* It takes no confirm, unlike the trash on a page or a terminal. Nothing is being deleted — there
     is nothing under an empty box — so a second click would guard a consequence that does not exist. */
  it("drops the pane on the first click — there is nothing under it to confirm", () => {
    const { props } = renderHost({ layout: { type: "leaf", id: "L", itemId: null }, items: [], focusedLeafId: "L" });
    fireEvent.click(screen.getByRole("button", { name: "Close this empty pane" }));
    expect(props.onCloseEmpty).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Really delete/)).toBeNull();
  });

  it("marks empty leaves with data-empty so a focused empty leaf (which has no header to accent-underline) still gets a visual focus mark (W5 carry-item)", () => {
    const withEmpty: Layout = { type: "split", id: "root", dir: "row", sizes: [50, 50], children: [
      { type: "leaf", id: "L1", itemId: "A" },
      { type: "leaf", id: "L2", itemId: null },
    ] };
    renderHost({ layout: withEmpty, focusedLeafId: "L2" });
    // The CSS contract: .panel[data-focused][data-empty] draws the accent top rule.
    expect(panel("L2")).toHaveAttribute("data-empty");
    expect(panel("L2")).toHaveAttribute("data-focused");
    expect(panel("L1")).not.toHaveAttribute("data-empty");
  });

  it("marks only the focused leaf with data-focused; pointer-down on another panel calls onFocus(leafId)", () => {
    const { props } = renderHost({ focusedLeafId: "L1" });
    expect(panel("L1")).toHaveAttribute("data-focused");
    expect(panel("L2")).not.toHaveAttribute("data-focused");
    fireEvent.pointerDown(within(panel("L2")).getByText("Tab B"));
    expect(props.onFocus).toHaveBeenCalledWith("L2");
    expect(props.onFocus).not.toHaveBeenCalledWith("L1");
  });

  it("close button calls onClose(itemId); the bar carries only ⋯ + close (no split icon button)", () => {
    const { props } = renderHost();
    fireEvent.click(within(panel("L2")).getByRole("button", { name: "Close Tab B" }));
    expect(props.onClose).toHaveBeenCalledExactlyOnceWith("B");
    expect(within(panel("L2")).queryByRole("button", { name: "Split right" })).toBeNull();
    expect(panel("L2").querySelectorAll(".panel-actions .icon-btn")).toHaveLength(2); // ⋯ menu + ×
  });

  /**
   * A pane whose ONLY closing control lifts it out of the layout leaves its row behind in the
   * space, which is what a page, terminal, browser or documents pane must not do — you closed it
   * because you were done with it. Those bars end in the trash instead of the ×; a session or a
   * diff, whose object outlives every pane that shows it, still ends in the ×.
   */
  describe("closing by delete", () => {
    const kinds = [
      ["settings-page", "Settings"], ["library-page", "Library"], ["connections-page", "Connections"],
      ["notifications-page", "Notifications"], ["schedules-page", "Scheduled tasks"], ["agents-page", "Agents"],
      ["profile-page", "Profile"], ["space-page", "Overview"], ["terminal", "Shell"], ["documents", "Files"],
      ["browser", "Tab"],
    ] as const;

    /** The BAR alone — a terminal or documents body would go looking for a live RPC socket, and
     *  none of these assertions is about what the pane renders under it. */
    function renderBar(kind: Item["kind"], title: string, over: Partial<Parameters<typeof PanelBar>[0]> = {}) {
      const only = item("P", "s1", { kind, title, refId: "P" });
      const api = fakeApi({ items: { s1: [only] } });
      const store = createAppStore(api);
      const props = { item: only, leafId: "L1", onSplit: vi.fn(), onClose: vi.fn(), onZoom: vi.fn(), onUnzoom: vi.fn(), ...over };
      const r = render(<StoreContext.Provider value={store}><PanelBar {...props} /></StoreContext.Provider>);
      return { ...r, api, store, props };
    }

    it.each(kinds)("a %s pane's bar ends in a trash, never an ×", (kind, title) => {
      renderBar(kind, title);
      expect(screen.getByRole("button", { name: `Delete ${title}` })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: `Close ${title}` })).toBeNull();
    });

    it("a session pane keeps the × — its transcript outlives the pane", () => {
      renderBar("session", "Chat");
      expect(screen.getByRole("button", { name: "Close Chat" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Delete Chat" })).toBeNull();
    });

    it("a page deletes on ONE click: there is no row behind it for a confirm to protect", async () => {
      const { api } = renderBar("settings-page", "Settings");
      fireEvent.click(screen.getByRole("button", { name: "Delete Settings" }));
      await waitFor(() => expect(api.calls).toContain("deleteItem:P"));
    });

    it("a terminal is two-step: the click would take a running pty with it", async () => {
      const { api } = renderBar("terminal", "Shell");
      fireEvent.click(screen.getByRole("button", { name: "Delete Shell" }));
      expect(api.calls).not.toContain("deleteItem:P"); // armed, not deleted
      fireEvent.click(screen.getByRole("button", { name: "Really delete Shell?" }));
      await waitFor(() => expect(api.calls).toContain("deleteItem:P"));
    });

    it("the ⋯ menu keeps the layout-only close, names it, and no longer repeats Delete", async () => {
      const { props, unmount } = renderBar("library-page", "Library");
      fireEvent.click(screen.getByRole("button", { name: "Pane menu for Library" }));
      expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
      fireEvent.click(screen.getByRole("menuitem", { name: /Close pane \(keep in space\)/ }));
      expect(props.onClose).toHaveBeenCalledOnce();
      await exited();
      unmount();
    });
  });

  /** W2.3 (Plan 11): NOTHING may ever open "over" a browser pane from its own header — the native
   *  view paints over any dropdown. The ⋯ menu is gone for browser panes; its actions are inline. */
  it("browser pane header has NO dropdown: no ⋯, no aria-haspopup — inline split buttons instead", () => {
    const { props } = renderHost();
    expect(within(panel("L1")).queryByRole("button", { name: "Pane menu for Tab A" })).toBeNull();
    expect(panel("L1").querySelector(".panel-bar [aria-haspopup]")).toBeNull();
    fireEvent.click(within(panel("L1")).getByRole("button", { name: "Split Tab A right" }));
    expect(props.onSplit).toHaveBeenCalledExactlyOnceWith("L1", "row");
    fireEvent.click(within(panel("L1")).getByRole("button", { name: "Split Tab A down" }));
    expect(props.onSplit).toHaveBeenLastCalledWith("L1", "col");
    // The non-browser pane keeps its ⋯ menu — the rework is scoped to browser panes.
    expect(within(panel("L2")).getByRole("button", { name: "Pane menu for Tab B" })).toBeInTheDocument();
  });

  /* The focus glyph came OFF every other pane bar — the ⋯ row one click away said the same thing in
     words, with its shortcut printed beside it. The browser bar has no ⋯ to say it, so the glyph
     stays there and only there. THE mutant: drop it here too, and the one pane kind that cannot open
     a menu loses every route to focus except a shortcut nothing on screen mentions. */
  it("browser pane KEEPS the inline focus toggle — it is the one bar with no ⋯ row to replace it", () => {
    const onZoom = vi.fn();
    renderHost({ onZoom });
    fireEvent.click(within(panel("L1")).getByRole("button", { name: "Focus Tab A" }));
    expect(onZoom).toHaveBeenCalledExactlyOnceWith("L1");
    // ...and the pane that DOES have a menu carries no such button in its bar.
    expect(within(panel("L2")).queryByRole("button", { name: "Focus Tab B" })).toBeNull();
  });

  it("browser pane delete is two-step INLINE (U-H2), deleting through the store on the confirm", async () => {
    const { api } = renderHost();
    fireEvent.click(within(panel("L1")).getByRole("button", { name: "Delete Tab A" }));
    expect(api.calls).not.toContain("deleteItem:A"); // armed, not deleted
    const confirm = within(panel("L1")).getByRole("button", { name: "Really delete Tab A?" });
    fireEvent.click(confirm);
    await waitFor(() => expect(api.calls).toContain("deleteItem:A"));
  });

  it("the inline delete confirm disarms on blur instead of staying armed forever", () => {
    renderHost();
    fireEvent.click(within(panel("L1")).getByRole("button", { name: "Delete Tab A" }));
    fireEvent.blur(within(panel("L1")).getByRole("button", { name: "Really delete Tab A?" }));
    expect(within(panel("L1")).queryByRole("button", { name: "Really delete Tab A?" })).toBeNull();
    expect(within(panel("L1")).getByRole("button", { name: "Delete Tab A" })).toBeInTheDocument();
  });

  it("⋯ menu closes when the ⋯ button is pressed a second time", async () => {
    // Menu's outside-pointerdown handler fires on the trigger too (it lives outside the portal), so
    // without both halves of the fix — Menu ignoring its anchor, and the trigger toggling — the second
    // press closes and instantly reopens: flicker, and no way to dismiss from the control you opened.
    const { unmount } = renderHost();
    const dots = within(panel("L2")).getByRole("button", { name: "Pane menu for Tab B" });
    fireEvent.pointerDown(dots); fireEvent.click(dots);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); // arm the outside-pointerdown listener
    fireEvent.pointerDown(dots); fireEvent.click(dots);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(dots).toHaveAttribute("aria-expanded", "false");
    unmount();
  });

  it("⋯ menu Delete is two-step and deletes through the store on confirm", async () => {
    const { api, unmount } = renderHost({ layout: { type: "leaf", id: "L1", itemId: "B" } });
    fireEvent.click(within(panel("L1")).getByRole("button", { name: "Pane menu for Tab B" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(api.calls).not.toContain("deleteItem:B"); // armed, not deleted
    expect(screen.getByRole("menu")).toBeInTheDocument(); // menu stayed open for the confirm
    fireEvent.click(screen.getByRole("menuitem", { name: "Really delete?" }));
    await waitFor(() => expect(api.calls).toContain("deleteItem:B"));
    unmount();
  });

  it("title is click-to-rename inline for any item kind: Enter commits via updateItem, Escape cancels", async () => {
    const { store, unmount } = renderHost({ layout: { type: "leaf", id: "L1", itemId: "A" } });
    await store.getState().boot(); // items must be loaded for updateItem to merge
    fireEvent.click(within(panel("L1")).getByRole("button", { name: "Rename Tab A" }));
    const input = screen.getByRole("textbox", { name: "Rename Tab A" });
    fireEvent.change(input, { target: { value: "Renamed A" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(store.getState().items.find((i) => i.id === "A")?.title).toBe("Renamed A"));
    // Escape cancels: no store write, title button returns.
    fireEvent.click(within(panel("L1")).getByRole("button", { name: /Rename/ }));
    const input2 = screen.getByRole("textbox", { name: /Rename/ });
    fireEvent.change(input2, { target: { value: "never" } });
    fireEvent.keyDown(input2, { key: "Escape" });
    expect(store.getState().items.find((i) => i.id === "A")?.title).toBe("Renamed A");
    expect(screen.queryByRole("textbox", { name: /Rename/ })).toBeNull();
    unmount();
  });

  it("a session item's PanelBar renders the paneMeta content (the status dot)", () => {
    const sessionItem = item("S", "s1", { kind: "session", title: "Agent", refId: "se1" });
    const api = fakeApi({ sessions: [session("se1", "s1", { model: "fake-xl", status: "running" })], items: { s1: [sessionItem] } });
    const store = createAppStore(api);
    store.setState({
      sessions: { se1: session("se1", "s1", { model: "fake-xl" }) }, sessionStatus: { se1: "running" },
      // The meta carries no text at all now: the model moved to the prompter's chip and the cost to
      // the summary button. What is left is the dot, which is the one thing a header can say at a glance.
      transcripts: { se1: { lastSeq: 1, t: reduceAll([sessionEvent("usage", { costUsd: 0.5, inputTokens: 1, outputTokens: 1, numTurns: 3 })]) } },
    });
    render(
      <StoreContext.Provider value={store}>
        <PaneHost layout={{ type: "leaf", id: "L", itemId: "S" }} items={[sessionItem]} focusedLeafId="L"
          onFocus={() => {}} onClose={() => {}} onSplit={() => {}} />
      </StoreContext.Provider>,
    );
    const meta = document.querySelector<HTMLElement>(".panel-bar .panel-meta");
    expect(meta).not.toBeNull();
    expect(within(meta!).queryByText("$0.50")).toBeNull();
    expect(meta!.querySelector('.status-dot[data-status="running"]')).toBeInTheDocument();
    // …and it is not on the summary button either. That control is a glyph in a four-button strip;
    // the cost lives INSIDE the panel, where a number has room to be labelled.
    expect(document.querySelector(".summary-btn-cost")).toBeNull();
  });

  it("remounts a leaf's pane when openItem swaps its itemId in place, so component-local state (composer draft) does not leak between sessions", () => {
    // The Arc-true nav model's primary gesture is openItem replacing a leaf's itemId in place (not opening
    // a new tab), so the same leaf keeps rendering the same React position across totally different sessions.
    // Two distinct Items (distinct item ids), each backing a different session — exactly what openItem
    // swaps between when it replaces a leaf's itemId in place.
    const itemSe1 = item("S1", "s1", { kind: "session", title: "Agent 1", refId: "se1" });
    const itemSe2 = item("S2", "s1", { kind: "session", title: "Agent 2", refId: "se2" });
    const api = fakeApi({ sessions: [session("se1", "s1"), session("se2", "s1")], items: { s1: [itemSe1, itemSe2] } });
    const store = createAppStore(api);
    store.setState({
      sessions: { se1: session("se1", "s1"), se2: session("se2", "s1") },
      sessionStatus: { se1: "idle", se2: "idle" },
      // No transcripts entries needed: SessionPane falls back to emptyTranscript() when one is missing.
    });
    const layout: Layout = { type: "leaf", id: "L", itemId: "S1" };
    const { rerender } = render(
      <StoreContext.Provider value={store}>
        <PaneHost layout={layout} items={[itemSe1, itemSe2]} focusedLeafId="L" onFocus={() => {}} onClose={() => {}} onSplit={() => {}} />
      </StoreContext.Provider>,
    );
    const box = screen.getByRole("textbox", { name: /message/i });
    fireEvent.change(box, { target: { value: "leftover draft for se1" } });
    expect((box as HTMLTextAreaElement).value).toBe("leftover draft for se1");

    // Same leaf id "L", but itemId now points at itemSe2 — exactly what openItem does in place.
    const layoutAfter: Layout = { type: "leaf", id: "L", itemId: "S2" };
    rerender(
      <StoreContext.Provider value={store}>
        <PaneHost layout={layoutAfter} items={[itemSe1, itemSe2]} focusedLeafId="L" onFocus={() => {}} onClose={() => {}} onSplit={() => {}} />
      </StoreContext.Provider>,
    );
    const box2 = screen.getByRole("textbox", { name: /message/i });
    expect((box2 as HTMLTextAreaElement).value).toBe(""); // fresh component instance, not the se1 instance carrying its draft over
  });
});

describe("PaneHost divider double-click", () => {
  const threeCol: Layout = { type: "split", id: "root", dir: "row", sizes: [60, 25, 15], children: [
    { type: "leaf", id: "L1", itemId: "A" },
    { type: "leaf", id: "L2", itemId: "B" },
    { type: "leaf", id: "L3", itemId: null },
  ] };

  it("a split renders one divider between each adjacent pair", () => {
    renderHost({ layout: threeCol });
    expect(document.querySelectorAll(".resize-handle")).toHaveLength(2);
  });

  it("double-clicking any divider asks the owning split — not the pair — to equalize", () => {
    const { props } = renderHost({ layout: threeCol });
    const handles = document.querySelectorAll(".resize-handle");
    fireEvent.doubleClick(handles[1]!); // the divider between L2 and L3
    expect(props.onEqualize).toHaveBeenCalledExactlyOnceWith("root");
  });

  it("each divider names its OWN split, so a nested group equalizes independently", () => {
    const nested: Layout = { type: "split", id: "outer", dir: "row", sizes: [50, 50], children: [
      { type: "leaf", id: "L1", itemId: "A" },
      { type: "split", id: "inner", dir: "col", sizes: [70, 30], children: [
        { type: "leaf", id: "L2", itemId: "B" },
        { type: "leaf", id: "L3", itemId: null },
      ] },
    ] };
    const { props } = renderHost({ layout: nested });
    const handles = [...document.querySelectorAll(".resize-handle")];
    expect(handles).toHaveLength(2);
    const innerHandle = handles.find((h) => h.closest("[data-panel-group-id='inner']"))!;
    fireEvent.doubleClick(innerHandle);
    expect(props.onEqualize).toHaveBeenCalledExactlyOnceWith("inner");
  });

  it("a single ordinary click is not the gesture — dragging a divider must not reset it", () => {
    const { props } = renderHost({ layout: threeCol });
    fireEvent.click(document.querySelector(".resize-handle")!);
    expect(props.onEqualize).not.toHaveBeenCalled();
  });
});

describe("PaneHost drag-to-split overlay", () => {
  it("renders no drop-overlay when no drag is in progress", () => {
    renderHost();
    expect(document.querySelector(".drop-overlay")).toBeNull();
  });

  it("a realm-item drag shows a .drop-overlay with five .drop-zones in every panel", () => {
    renderHost();
    fireDrag(window, "dragstart", dt("A"));
    const overlays = document.querySelectorAll(".drop-overlay");
    expect(overlays).toHaveLength(2);
    overlays.forEach((ov) => {
      const edges = Array.from(ov.querySelectorAll(".drop-zone")).map((z) => z.getAttribute("data-edge")).sort();
      expect(edges).toEqual(["bottom", "center", "left", "right", "top"]);
    });
  });

  it("a new-session drag shows the same pane drop overlays", () => {
    renderHost();
    fireDrag(window, "dragstart", newSessionDt());
    expect(document.querySelectorAll(".drop-overlay")).toHaveLength(2);
  });

  it("ignores an OS file drag — no application/x-realm-item type means no overlay", () => {
    renderHost();
    fireDrag(window, "dragstart", dt("ignored", ["Files"]));
    expect(document.querySelector(".drop-overlay")).toBeNull();
  });

  it("dragend clears the drag state and removes the overlay", () => {
    renderHost();
    fireDrag(window, "dragstart", dt("A"));
    expect(document.querySelector(".drop-overlay")).not.toBeNull();
    fireDrag(window, "dragend", dt("A"));
    expect(document.querySelector(".drop-overlay")).toBeNull();
  });

  it("dragover lights up data-hot on the zone under the pointer, per leaf (not shared across panels)", () => {
    renderHost();
    fireDrag(window, "dragstart", dt("A"));
    const ov1 = panel("L1").querySelector(".drop-overlay")!;
    const ov2 = panel("L2").querySelector(".drop-overlay")!;
    stubRect(ov1, { width: 400, height: 300 });
    fireDrag(ov1, "dragover", dt("A"), { clientX: 390, clientY: 150 }); // near right edge
    expect(ov1.querySelector('.drop-zone[data-edge="right"]')).toHaveAttribute("data-hot");
    expect(ov1.querySelector('.drop-zone[data-edge="left"]')).not.toHaveAttribute("data-hot");
    expect(ov2.querySelector("[data-hot]")).toBeNull(); // the other panel never lights up
  });

  it("dragover on a non-realm drag over an already-open overlay does not set data-hot and does not preventDefault", () => {
    renderHost();
    fireDrag(window, "dragstart", dt("A")); // a real realm drag is in progress
    const ov1 = panel("L1").querySelector(".drop-overlay")!;
    stubRect(ov1, { width: 400, height: 300 });
    const e = fireDrag(ov1, "dragover", dt("ignored", ["Files"]), { clientX: 390, clientY: 150 });
    expect(ov1.querySelector("[data-hot]")).toBeNull();
    // Undone preventDefault here is what tells the browser "not a valid drop target" — an OS file drag
    // must be free to fall through to whatever else wants it (e.g. the OS itself).
    expect(e.defaultPrevented).toBe(false);
  });

  it("a realm dragover calls preventDefault — the one line that makes the drop legal at all", () => {
    renderHost();
    fireDrag(window, "dragstart", dt("A"));
    const overlay = panel("L1").querySelector(".drop-overlay")!;
    stubRect(overlay, { width: 400, height: 300 });
    const e = fireDrag(overlay, "dragover", dt("A"), { clientX: 200, clientY: 150 });
    expect(e.defaultPrevented).toBe(true);
  });

  it("drop on [data-edge=right] calls onDropItem(itemId, leafId, 'right')", () => {
    const { props } = renderHost();
    fireDrag(window, "dragstart", dt("A"));
    const overlay = panel("L2").querySelector(".drop-overlay")!;
    stubRect(overlay, { width: 400, height: 300 });
    const zone = overlay.querySelector('.drop-zone[data-edge="right"]')!;
    fireDrag(zone, "drop", dt("A"), { clientX: 390, clientY: 150 });
    expect(props.onDropItem).toHaveBeenCalledExactlyOnceWith("A", "L2", "right");
  });

  it("a new-session drop calls onDropNewSession without calling the item callback", () => {
    const onDropNewSession = vi.fn();
    const { props } = renderHost({ onDropNewSession });
    fireDrag(window, "dragstart", newSessionDt());
    const overlay = panel("L2").querySelector(".drop-overlay")!;
    stubRect(overlay, { width: 400, height: 300 });
    fireDrag(overlay, "drop", newSessionDt(), { clientX: 390, clientY: 150 });
    expect(onDropNewSession).toHaveBeenCalledExactlyOnceWith("L2", "right");
    expect(props.onDropItem).not.toHaveBeenCalled();
  });

  it("a completed drop also clears the drag state (overlay disappears)", () => {
    const { props } = renderHost();
    fireDrag(window, "dragstart", dt("A"));
    const overlay = panel("L1").querySelector(".drop-overlay")!;
    stubRect(overlay, { width: 400, height: 300 });
    fireDrag(overlay, "drop", dt("A"), { clientX: 200, clientY: 150 }); // center
    expect(props.onDropItem).toHaveBeenCalledExactlyOnceWith("A", "L1", "center");
    expect(document.querySelector(".drop-overlay")).toBeNull();
  });

  it("drop computes the edge fresh at drop time, not from the last dragover's hot state", () => {
    const { props } = renderHost();
    fireDrag(window, "dragstart", dt("A"));
    const overlay = panel("L1").querySelector(".drop-overlay")!;
    stubRect(overlay, { width: 400, height: 300 });
    fireDrag(overlay, "dragover", dt("A"), { clientX: 390, clientY: 150 }); // hot = "right"
    expect(overlay.querySelector('[data-edge="right"]')).toHaveAttribute("data-hot");
    fireDrag(overlay, "drop", dt("A"), { clientX: 200, clientY: 150 }); // pointer now at center
    expect(props.onDropItem).toHaveBeenCalledExactlyOnceWith("A", "L1", "center");
  });

  it("drop with no realm-item id (bad key or empty) does not call onDropItem", () => {
    const { props } = renderHost();
    fireDrag(window, "dragstart", dt("A"));
    const overlay = panel("L1").querySelector(".drop-overlay")!;
    stubRect(overlay, { width: 400, height: 300 });
    fireDrag(overlay, "drop", dt(""), { clientX: 200, clientY: 150 });
    expect(props.onDropItem).not.toHaveBeenCalled();
  });
});

describe("zoneAt (pure pointer -> edge mapping)", () => {
  const rect = { width: 400, height: 200 };

  it("returns center for a pointer in the middle", () => {
    expect(zoneAt(200, 100, rect)).toBe("center");
  });

  it("returns left/right within 32% of the respective edge, else center (threshold boundary)", () => {
    expect(zoneAt(10, 100, rect)).toBe("left");
    expect(zoneAt(127, 100, rect)).toBe("left"); // 127/400 = 31.75% <= 32%
    expect(zoneAt(129, 100, rect)).toBe("center"); // 129/400 = 32.25% > 32%
    expect(zoneAt(390, 100, rect)).toBe("right");
  });

  it("the 32% boundary itself is inclusive (exactly at the threshold still counts as the edge)", () => {
    expect(zoneAt(0.32 * rect.width, 100, rect)).toBe("left"); // frac === 0.32 exactly
  });

  it("does not clamp an overshot pointer outside the rect — the overshot edge just keeps winning", () => {
    expect(zoneAt(-10, 100, rect)).toBe("left");
  });

  it("returns top/bottom within 32% of the respective edge", () => {
    expect(zoneAt(200, 10, rect)).toBe("top");
    expect(zoneAt(200, 190, rect)).toBe("bottom");
    expect(zoneAt(200, 65, rect)).toBe("center"); // 65/200 = 32.5% > 32%
  });

  it("at a corner, the axis with deeper penetration (smaller fraction) wins", () => {
    expect(zoneAt(5, 60, rect)).toBe("left"); // left 1.25% vs top 30%
    expect(zoneAt(100, 5, rect)).toBe("top"); // left 25% vs top 2.5%
  });

  it("on an exact tie between axes, horizontal wins over vertical (documented, arbitrary tie-break)", () => {
    const sq = { width: 200, height: 200 };
    expect(zoneAt(20, 20, sq)).toBe("left"); // left frac 10% == top frac 10%
  });

  it("degenerates to center for a zero-size rect", () => {
    expect(zoneAt(10, 10, { width: 0, height: 0 })).toBe("center");
  });
});

/** App-shell wiring: Main renders the full-bleed PaneHost against the real store. */
async function mountMain(focusedLeafId: string) {
  const api = fakeApi({ items: { s1: [...items] } });
  const store = createAppStore(api);
  await store.getState().boot();
  act(() => store.setState({ layout: split2, focusedLeafId }));
  const r = render(<StoreContext.Provider value={store}><Main /></StoreContext.Provider>);
  return { store, api, ...r };
}

describe("App shell", () => {
  it("dropping New session on a pane edge creates it in a new split", async () => {
    const { store, api } = await mountMain("L1");
    fireDrag(window, "dragstart", newSessionDt());
    const overlay = panel("L2").querySelector(".drop-overlay")!;
    stubRect(overlay, { width: 400, height: 300 });
    fireDrag(overlay, "drop", newSessionDt(), { clientX: 390, clientY: 150 });

    await waitFor(() => expect(api.calls).toContain("createSession:claude"));
    await waitFor(() => {
      const current = store.getState().layout;
      expect(current?.type).toBe("split");
      if (current?.type !== "split") throw new Error();
      expect(current.children).toHaveLength(3);
    });
    const layout = store.getState().layout!;
    expect(layout.type).toBe("split"); if (layout.type !== "split") throw new Error();
    const created = store.getState().items.find((i) => i.kind === "session")!;
    expect(layout.children.map((c) => c.type === "leaf" ? c.itemId : null)).toEqual(["A", "B", created.id]);
    expect(store.getState().focusedLeafId).toBe(layout.children[2]!.id);
  });

  it("PanelBar split targets its own leaf: focusLeaf runs before splitFocused", async () => {
    const { store } = await mountMain("L1");
    // L1 is focused; splitting from L2's PanelBar menu must split L2, not the previously focused leaf.
    fireEvent.click(within(panel("L2")).getByRole("button", { name: "Pane menu for Tab B" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Split right/ }));
    await waitFor(() => expect(findEmptySiblingOf(store.getState().layout!, "L2")).toBeTruthy());
    const l = store.getState().layout!; if (l.type !== "split") throw new Error();
    // The row GREW rather than nesting, so "which leaf was split" is now a question of position: the
    // fresh empty leaf sits right after L2, with L1 and L2 still the untouched first two columns.
    expect(l.children).toHaveLength(3);
    expect(l.children.map((c) => c.id).slice(0, 2)).toEqual(["L1", "L2"]);
    expect(l.children[2]).toMatchObject({ type: "leaf", itemId: null });
    expect(store.getState().focusedLeafId).toBe(l.children[2]!.id);
    expect(findEmptySiblingOf(l, "L2")).toBe(l.children[2]!.id);
  });

  it("the global topbar is retired: no breadcrumb or topbar chrome, panes render full-bleed (layout presets live in the command palette)", async () => {
    await mountMain("L2");
    expect(document.querySelector(".topbar")).toBeNull();
    expect(document.querySelector(".breadcrumb")).toBeNull();
    expect(document.querySelector(".layout-menu")).toBeNull();
    expect(document.querySelectorAll(".panel")).toHaveLength(2); // PaneHost is the whole stage now
  });

  it("⌘\\ splits the focused leaf; ignored while a sheet is open", async () => {
    const api = fakeApi({ items: { s1: [...items] } });
    const store = createAppStore(api);
    await store.getState().boot();
    act(() => store.setState({ layout: { type: "leaf", id: "L1", itemId: "A" }, focusedLeafId: "L1" }));
    renderHook(() => useGlobalHotkeys(store));
    fireEvent.keyDown(window, { key: "\\", metaKey: true });
    await waitFor(() => expect(store.getState().layout!.type).toBe("split"));
    act(() => store.getState().openSheet({ kind: "new-space" }));
    fireEvent.keyDown(window, { key: "\\", metaKey: true });
    const l = store.getState().layout!;
    expect(l.type === "split" && l.children.length).toBe(2); // unchanged while the sheet is open
  });

  it("the error bar steps below the connection banner only while the socket is down", async () => {
    const { store } = await mountMain("L1");
    act(() => store.setState({ error: "boom" }));
    expect(document.querySelector(".error-bar")).not.toHaveAttribute("data-under-banner");
    act(() => store.setState({ connectionState: "reconnecting" }));
    expect(document.querySelector(".error-bar")).toHaveAttribute("data-under-banner");
    act(() => store.setState({ connectionState: "connected" }));
    expect(document.querySelector(".error-bar")).not.toHaveAttribute("data-under-banner");
  });

  it("⌘\\ is ignored while the command palette is open", async () => {
    const api = fakeApi({ items: { s1: [...items] } });
    const store = createAppStore(api);
    await store.getState().boot();
    act(() => store.setState({ layout: { type: "leaf", id: "L1", itemId: "A" }, focusedLeafId: "L1", paletteOpen: true }));
    renderHook(() => useGlobalHotkeys(store));
    fireEvent.keyDown(window, { key: "\\", metaKey: true });
    const l = store.getState().layout!;
    expect(l.type).toBe("leaf"); // unchanged while the palette is open
  });
});
