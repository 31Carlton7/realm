import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within, renderHook, act } from "@testing-library/react";
import type { Item, Layout } from "@realm/contracts";
import { PaneHost, type PaneHostProps } from "./PaneHost";
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
    onFocus: vi.fn(), onClose: vi.fn(), onSplit: vi.fn(),
    ...over,
  };
  return { ...render(<PaneHost {...props} />), props };
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
