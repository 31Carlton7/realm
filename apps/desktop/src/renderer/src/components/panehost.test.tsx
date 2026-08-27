import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within, renderHook, act } from "@testing-library/react";
import type { Item, Layout } from "@realm/contracts";
import { PaneHost, zoneAt, type PaneHostProps } from "./PaneHost";
import { Main, useSplitHotkey } from "../App";
import { StoreContext, createAppStore, findEmptySiblingOf } from "../state/store";
import { fakeApi, item, session } from "../state/store.test-fakes";

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
    onFocus: vi.fn(), onClose: vi.fn(), onSplit: vi.fn(), onDropItem: vi.fn(),
    ...over,
  };
  return { ...render(<PaneHost {...props} />), props };
}

const REALM_TYPE = "application/x-realm-item";
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

  it("renders the placeholder and no PanelBar for an empty leaf", () => {
    renderHost({ layout: { type: "leaf", id: "L", itemId: null }, items: [], focusedLeafId: "L" });
    expect(screen.getByText("Open something from the sidebar.")).toBeInTheDocument();
    expect(document.querySelector(".panel")).toBeInTheDocument();
    expect(document.querySelector(".panel-bar")).toBeNull();
  });

  it("marks only the focused leaf with data-focused; pointer-down on another panel calls onFocus(leafId)", () => {
    const { props } = renderHost({ focusedLeafId: "L1" });
    expect(panel("L1")).toHaveAttribute("data-focused");
    expect(panel("L2")).not.toHaveAttribute("data-focused");
    fireEvent.pointerDown(within(panel("L2")).getByText("Tab B"));
    expect(props.onFocus).toHaveBeenCalledWith("L2");
    expect(props.onFocus).not.toHaveBeenCalledWith("L1");
  });

  it("close button calls onClose(itemId); split button calls onSplit(leafId, 'row')", () => {
    const { props } = renderHost();
    fireEvent.click(within(panel("L1")).getByRole("button", { name: "Close Tab A" }));
    expect(props.onClose).toHaveBeenCalledExactlyOnceWith("A");
    fireEvent.click(within(panel("L2")).getByRole("button", { name: "Split right" }));
    expect(props.onSplit).toHaveBeenCalledExactlyOnceWith("L2", "row");
  });

  it("a session item's PanelBar renders the paneMeta content (model + status dot)", () => {
    const sessionItem = item("S", "s1", { kind: "session", title: "Agent", refId: "se1" });
    const api = fakeApi({ sessions: [session("se1", "s1", { model: "fake-xl", status: "running" })], items: { s1: [sessionItem] } });
    const store = createAppStore(api);
    store.setState({ sessions: { se1: session("se1", "s1", { model: "fake-xl" }) }, sessionStatus: { se1: "running" } });
    render(
      <StoreContext.Provider value={store}>
        <PaneHost layout={{ type: "leaf", id: "L", itemId: "S" }} items={[sessionItem]} focusedLeafId="L"
          onFocus={() => {}} onClose={() => {}} onSplit={() => {}} />
      </StoreContext.Provider>,
    );
    const meta = document.querySelector<HTMLElement>(".panel-bar .panel-meta");
    expect(meta).not.toBeNull();
    expect(within(meta!).getByText("fake-xl")).toBeInTheDocument();
    expect(meta!.querySelector('.status-dot[data-status="running"]')).toBeInTheDocument();
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

/** App-shell wiring: Main renders topbar + PaneHost against the real store. */
async function mountMain(focusedLeafId: string) {
  const api = fakeApi({ items: { s1: [...items] } });
  const store = createAppStore(api);
  await store.getState().boot();
  act(() => store.setState({ layout: split2, focusedLeafId }));
  const r = render(<StoreContext.Provider value={store}><Main /></StoreContext.Provider>);
  return { store, api, ...r };
}

describe("App shell", () => {
  it("PanelBar split targets its own leaf: focusLeaf runs before splitFocused", async () => {
    const { store } = await mountMain("L1");
    // L1 is focused; splitting from L2's PanelBar must split L2, not the previously focused leaf.
    fireEvent.click(within(panel("L2")).getByRole("button", { name: "Split right" }));
    await waitFor(() => expect(findEmptySiblingOf(store.getState().layout!, "L2")).toBeTruthy());
    expect(findEmptySiblingOf(store.getState().layout!, "L1")).toBeNull();
    expect(store.getState().focusedLeafId).toBe(findEmptySiblingOf(store.getState().layout!, "L2"));
  });

  it("Breadcrumb shows the focused leaf's item, not the first leaf's", async () => {
    await mountMain("L2");
    const crumb = document.querySelector<HTMLElement>(".breadcrumb");
    expect(crumb).not.toBeNull();
    expect(crumb!.textContent).toContain("Tab B");
    expect(crumb!.textContent).not.toContain("Tab A");
  });

  it("⌘\\ splits the focused leaf; ignored while a sheet is open", async () => {
    const api = fakeApi({ items: { s1: [...items] } });
    const store = createAppStore(api);
    await store.getState().boot();
    act(() => store.setState({ layout: { type: "leaf", id: "L1", itemId: "A" }, focusedLeafId: "L1" }));
    renderHook(() => useSplitHotkey(store));
    fireEvent.keyDown(window, { key: "\\", metaKey: true });
    await waitFor(() => expect(store.getState().layout!.type).toBe("split"));
    act(() => store.getState().openSheet({ kind: "new-space" }));
    fireEvent.keyDown(window, { key: "\\", metaKey: true });
    const l = store.getState().layout!;
    expect(l.type === "split" && l.children.length).toBe(2); // unchanged while the sheet is open
  });

  it("⌘\\ is ignored while the command palette is open", async () => {
    const api = fakeApi({ items: { s1: [...items] } });
    const store = createAppStore(api);
    await store.getState().boot();
    act(() => store.setState({ layout: { type: "leaf", id: "L1", itemId: "A" }, focusedLeafId: "L1", paletteOpen: true }));
    renderHook(() => useSplitHotkey(store));
    fireEvent.keyDown(window, { key: "\\", metaKey: true });
    const l = store.getState().layout!;
    expect(l.type).toBe("leaf"); // unchanged while the palette is open
  });
});
