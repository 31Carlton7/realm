import { describe, expect, it } from "vitest";
import { act, fireEvent, renderHook, waitFor } from "@testing-library/react";
import type { Layout } from "@realm/contracts";
import { useGlobalHotkeys } from "./hotkeys";
import { createAppStore, neighborLeafId } from "./state/store";
import { fakeApi, item, session, space } from "./state/store.test-fakes";

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
  it("⌘1…⌘9 select the nth space; out-of-range is a no-op", async () => {
    const { store } = await mount();
    key({ key: "2", metaKey: true });
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s2"));
    key({ key: "9", metaKey: true }); // only two spaces exist
    expect(store.getState().activeSpaceId).toBe("s2");
    key({ key: "1", metaKey: true });
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s1"));
  });

  it("⌃Tab / ⌃⇧Tab cycle spaces forward and back", async () => {
    const { store } = await mount();
    key({ key: "Tab", ctrlKey: true });
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s2"));
    key({ key: "Tab", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s1"));
  });

  it("⌘\\ splits right, ⌘⇧\\ (reported as |) splits down", async () => {
    const { store } = await mount();
    act(() => store.setState({ layout: { type: "leaf", id: "L1", itemId: "i1" }, focusedLeafId: "L1" }));
    key({ key: "\\", metaKey: true });
    await waitFor(() => { const l = store.getState().layout!; expect(l.type === "split" && l.dir).toBe("row"); });
    act(() => store.setState({ layout: { type: "leaf", id: "L1", itemId: "i1" }, focusedLeafId: "L1" }));
    key({ key: "|", metaKey: true, shiftKey: true });
    await waitFor(() => { const l = store.getState().layout!; expect(l.type === "split" && l.dir).toBe("col"); });
  });

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

  it("⌘W closes the focused non-empty leaf's item from the layout (item survives) and always preventDefaults", async () => {
    const { store } = await mount();
    act(() => store.setState({ layout: grid, focusedLeafId: "L1", items: [item("A", "s1"), item("B", "s1")] }));
    const e = key({ key: "w", metaKey: true });
    expect(e).toBe(false); // fireEvent returns false when defaultPrevented — the window never closes
    await waitFor(() => {
      const l = store.getState().layout!;
      expect(l.type === "split" && l.children[0]).toEqual({ type: "leaf", id: "L2", itemId: "B" });
    });
    expect(store.getState().items.map((i) => i.id)).toEqual(["A", "B"]); // layout-only, never deleted
  });

  it("⌘W on an empty focused leaf is a no-op (but still consumed)", async () => {
    const { store } = await mount();
    act(() => store.setState({ layout: grid, focusedLeafId: "L3", items: [item("A", "s1"), item("B", "s1")] }));
    const e = key({ key: "w", metaKey: true });
    expect(e).toBe(false);
    expect(store.getState().layout).toEqual(grid);
  });

  it("⌘T opens a terminal; ⌘N opens the new-session sheet", async () => {
    const { store } = await mount();
    key({ key: "t", metaKey: true });
    await waitFor(() => expect(store.getState().items.some((i) => i.kind === "terminal" && i.id !== "i1")).toBe(true));
    key({ key: "n", metaKey: true });
    expect(store.getState().sheet).toEqual({ kind: "new-session" });
  });

  it("Esc interrupts the focused pane's session only while it is running", async () => {
    const it9 = item("i9", "s1", { kind: "session", refId: "se1" });
    const { api, store } = await mount({ items: { s1: [it9] }, sessions: [session("se1", "s1")] });
    act(() => store.setState({ layout: { type: "leaf", id: "L1", itemId: "i9" }, focusedLeafId: "L1", sessionStatus: { se1: "idle" } }));
    key({ key: "Escape" });
    expect(api.calls).not.toContain("interrupt:se1"); // idle: no interrupt
    act(() => store.setState({ sessionStatus: { se1: "running" } }));
    key({ key: "Escape" });
    await waitFor(() => expect(api.calls).toContain("interrupt:se1"));
  });

  it("Esc works from an editable target (the composer) too", async () => {
    const it9 = item("i9", "s1", { kind: "session", refId: "se1" });
    const { api, store } = await mount({ items: { s1: [it9] }, sessions: [session("se1", "s1")] });
    act(() => store.setState({ layout: { type: "leaf", id: "L1", itemId: "i9" }, focusedLeafId: "L1", sessionStatus: { se1: "running" } }));
    const ta = document.createElement("textarea"); document.body.appendChild(ta); ta.focus();
    key({ key: "Escape" }, ta);
    await waitFor(() => expect(api.calls).toContain("interrupt:se1"));
    ta.remove();
  });

  it("guard: bindings do nothing from an editable target (⌘W) or while a sheet or the palette is open (⌘1)", async () => {
    const { store } = await mount();
    act(() => store.setState({ layout: grid, focusedLeafId: "L1", items: [item("A", "s1"), item("B", "s1")] }));
    const input = document.createElement("input"); document.body.appendChild(input); input.focus();
    const e = key({ key: "w", metaKey: true }, input);
    expect(e).toBe(false); // belt-and-braces: still consumed so Electron never sees it
    expect(store.getState().layout).toEqual(grid); // …but nothing closed
    input.remove();

    act(() => store.getState().openSheet({ kind: "new-space" }));
    key({ key: "2", metaKey: true });
    expect(store.getState().activeSpaceId).toBe("s1"); // sheet owns the keyboard
    act(() => store.setState({ sheet: null, paletteOpen: true }));
    key({ key: "2", metaKey: true });
    expect(store.getState().activeSpaceId).toBe("s1"); // palette owns the keyboard
  });

  it("an event a closer handler already consumed (defaultPrevented) is never re-handled", async () => {
    const { store } = await mount();
    act(() => store.setState({ layout: grid, focusedLeafId: "L1", items: [item("A", "s1"), item("B", "s1")] }));
    const e = new KeyboardEvent("keydown", { key: "w", metaKey: true, cancelable: true, bubbles: true });
    e.preventDefault();
    window.dispatchEvent(e);
    expect(store.getState().layout).toEqual(grid);
  });

  it("⌘3 with three spaces reaches the third (index mapping, not offset)", async () => {
    const { store } = await mount({ spaces: [space("s1", "p1", "One"), space("s2", "p1", "Two"), space("s3", "p1", "Three")], items: {} });
    key({ key: "3", metaKey: true });
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s3"));
  });
});
