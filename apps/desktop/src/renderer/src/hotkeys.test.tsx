import { describe, expect, it } from "vitest";
import { act, fireEvent, renderHook, waitFor } from "@testing-library/react";
import { allItems, type Layout } from "@realm/contracts";
import { useGlobalHotkeys } from "./hotkeys";
import { createAppStore, neighborLeafId } from "./state/store";
import { fakeApi, item, session } from "./state/store.test-fakes";

/** Real store + the hook, driven by window KeyboardEvents — exactly what production runs. */
async function mount(over: Parameters<typeof fakeApi>[0] = {}) {
  const api = fakeApi(over);
  const store = createAppStore(api);
  await store.getState().boot();
  renderHook(() => useGlobalHotkeys(store));
  return { api, store };
}

const key = (init: KeyboardEventInit & { key: string }, target: Element | Window = window) =>
  fireEvent.keyDown(target, init);
/** Let any promise chain a binding kicked off settle, so "nothing happened" assertions are real. */
const tick = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

//    root (row)
//   ┌─────┬─────┐
//   │ L1  │ col │      L2 above L3 in the right column.
//   │     ├─────┤
//   │     │ L3  │
const grid: Layout = { type: "split", id: "root", dir: "row", sizes: [50, 50], children: [
  { type: "leaf", id: "L1", itemId: "A" },
  { type: "split", id: "c1", dir: "col", sizes: [50, 50], children: [
    { type: "leaf", id: "L2", itemId: "B" },
    { type: "leaf", id: "L3", itemId: null },
  ] },
] };

describe("neighborLeafId (structural approximation)", () => {
  it("moves across a row split, descending to the near edge of the sibling subtree", () => {
    expect(neighborLeafId(grid, "L1", "right")).toBe("L2"); // cross-axis descent takes the first child
    expect(neighborLeafId(grid, "L2", "left")).toBe("L1");
    expect(neighborLeafId(grid, "L3", "left")).toBe("L1");
  });
  it("moves within a col split and no-ops at the edges", () => {
    expect(neighborLeafId(grid, "L2", "down")).toBe("L3");
    expect(neighborLeafId(grid, "L3", "up")).toBe("L2");
    expect(neighborLeafId(grid, "L1", "left")).toBeNull();
    expect(neighborLeafId(grid, "L1", "up")).toBeNull();
    expect(neighborLeafId(grid, "L1", "down")).toBeNull();
    expect(neighborLeafId(grid, "L2", "right")).toBeNull();
  });
  it("moving left into a subtree lands on its far-right leaf (near edge of travel)", () => {
    const l: Layout = { type: "split", id: "r", dir: "row", sizes: [50, 50], children: [
      { type: "split", id: "s", dir: "row", sizes: [50, 50], children: [
        { type: "leaf", id: "a", itemId: null }, { type: "leaf", id: "b", itemId: null },
      ] },
      { type: "leaf", id: "c", itemId: null },
    ] };
    expect(neighborLeafId(l, "c", "left")).toBe("b");
    expect(neighborLeafId(l, "a", "right")).toBe("b");
  });
});

describe("useGlobalHotkeys", () => {

  it("⌘⌥arrows move pane focus directionally; wrong direction stays put", async () => {
    const { store } = await mount();
    act(() => store.setState({ layout: grid, focusedLeafId: "L1" }));
    key({ key: "ArrowRight", metaKey: true, altKey: true });
    expect(store.getState().focusedLeafId).toBe("L2");
    key({ key: "ArrowDown", metaKey: true, altKey: true });
    expect(store.getState().focusedLeafId).toBe("L3");
    key({ key: "ArrowUp", metaKey: true, altKey: true });
    expect(store.getState().focusedLeafId).toBe("L2");
    key({ key: "ArrowLeft", metaKey: true, altKey: true });
    expect(store.getState().focusedLeafId).toBe("L1");
    key({ key: "ArrowLeft", metaKey: true, altKey: true }); // edge: no neighbor
    expect(store.getState().focusedLeafId).toBe("L1");
  });

  it("a focused terminal (xterm helper textarea) does NOT swallow global bindings: ⌘W closes, ⌘\\ splits", async () => {
    const { api, store } = await mount();
    const two: Layout = { type: "split", id: "root", dir: "row", sizes: [50, 50], children: [
      { type: "leaf", id: "L1", itemId: "A" }, { type: "leaf", id: "L2", itemId: "B" }] };
    act(() => store.setState({ layout: two, focusedLeafId: "L1", items: [item("A", "s1"), item("B", "s1")] }));
    // xterm's real focus target: a helper <textarea> nested inside the .xterm root element.
    const host = document.createElement("div"); host.className = "xterm";
    const ta = document.createElement("textarea"); ta.className = "xterm-helper-textarea";
    host.appendChild(ta); document.body.appendChild(host); ta.focus();
    key({ key: "w", metaKey: true }, ta);
    await waitFor(() => expect(store.getState().layout).toEqual({ type: "leaf", id: "L2", itemId: "B" })); // pane closed
    key({ key: "\\", metaKey: true }, ta);
    await waitFor(() => {
      const l = store.getState().layout!;
      expect(l.type === "split" && l.dir === "row" && l.children.length).toBe(2); // split fired
    });
    // …with a new session in the new pane (THE MUTANT: the binding left on splitFocused, an empty pane).
    await waitFor(() => expect(allItems(store.getState().layout!)).toHaveLength(2));
    expect(api.calls).toContain("createSession:claude");
    host.remove();
  });

  describe("⌘⇧↩ — dispatch the focused session's draft (Plan 13 W2)", () => {
    const focusedSession = async () => {
      const it9 = item("i9", "s1", { kind: "session", refId: "se1" });
      const r = await mount({ items: { s1: [it9] }, sessions: [session("se1", "s1")] });
      act(() => r.store.setState({ layout: { type: "leaf", id: "L1", itemId: "i9" }, focusedLeafId: "L1" }));
      act(() => r.store.getState().setDraft("se1", "go fix it"));
      return r;
    };

    it("an empty draft is a no-op — nothing created, nothing sent", async () => {
      const { api, store } = await focusedSession();
      act(() => store.getState().setDraft("se1", "   "));
      key({ key: "Enter", metaKey: true, shiftKey: true });
      await tick();
      expect(api.sent).toHaveLength(0);
      expect(api.data.sessions.some((s) => s.dispatchedBy !== null)).toBe(false);
    });
  });

  describe("⌘B — the sidebar", () => {
    it("toggles collapsed, then back, and persists each flip", async () => {
      const { api, store } = await mount();
      expect(store.getState().sidebarCollapsed).toBe(false);
      key({ key: "b", metaKey: true });
      await waitFor(() => expect(store.getState().sidebarCollapsed).toBe(true));
      expect(api.calls).toContain("setSetting:ui.sidebarCollapsed=true");
      key({ key: "b", metaKey: true });
      await waitFor(() => expect(store.getState().sidebarCollapsed).toBe(false));
      expect(api.calls).toContain("setSetting:ui.sidebarCollapsed=false");
    });

  });

});
