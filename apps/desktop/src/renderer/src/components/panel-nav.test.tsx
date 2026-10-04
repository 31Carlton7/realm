import { describe, expect, it } from "vitest";
import { fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { Main } from "../App";
import { useGlobalHotkeys } from "../hotkeys";
import { StoreContext, createAppStore } from "../state/store";
import { fakeApi, item } from "../state/store.test-fakes";

const items = { s1: [
  item("i1", "s1", { kind: "artifact", title: "one", refId: "r1" }),
  item("i2", "s1", { kind: "artifact", title: "two", refId: "r2" }),
] };

async function mount() {
  const api = fakeApi({ items });
  const store = createAppStore(api);
  await store.getState().boot();
  render(<StoreContext.Provider value={store}><Main /></StoreContext.Provider>);
  renderHook(() => useGlobalHotkeys(store)); // the real window-level bindings, as production runs them
  return { api, store };
}

describe("a pane's own trail", () => {
  it("draws no arrows of its own in the pane's bar — the window's one pair is in the sidebar's head row", async () => {
    // THE MUTANT: put the bar's pair back, and the window has two sets of arrows walking two histories.
    const { store } = await mount();
    const leaf = store.getState().focusedLeafId!;
    await store.getState().openItem("i1", leaf);
    await store.getState().openItem("i2", leaf);
    await waitFor(() => expect(screen.getByRole("button", { name: "Rename two" })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /^Back in / })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Forward in / })).toBeNull();
    // The trail is still kept, for the keyboard below.
    expect(store.getState().canPaneNav(leaf, -1)).toBe(true);
  });

  it("is each pane's own — a split's neighbour is untouched", async () => {
    const { store } = await mount();
    const a = store.getState().focusedLeafId!;
    await store.getState().openItem("i1", a);
    await store.getState().splitFocused("row");
    const b = store.getState().focusedLeafId!;
    await store.getState().openItem("i2", b);
    // Pane A never changed its occupant; pane B replaced an empty leaf, so neither can go back yet.
    expect(store.getState().canPaneNav(a, -1)).toBe(false);
    expect(store.getState().canPaneNav(b, -1)).toBe(false);
  });

  it("⌘[ / ⌘] walk the FOCUSED pane's trail", async () => {
    const { store } = await mount();
    const leaf = store.getState().focusedLeafId!;
    await store.getState().openItem("i1", leaf);
    await store.getState().openItem("i2", leaf);
    await waitFor(() => expect(screen.getByRole("button", { name: "Rename two" })).toBeInTheDocument());

    fireEvent.keyDown(window, { key: "[", metaKey: true });
    await waitFor(() => expect(screen.getByRole("button", { name: "Rename one" })).toBeInTheDocument());
    fireEvent.keyDown(window, { key: "]", metaKey: true });
    await waitFor(() => expect(screen.getByRole("button", { name: "Rename two" })).toBeInTheDocument());
  });

  it("⌘⇧[ / ⌘⇧] no longer step anything — the pane's own trail is left exactly as it was", async () => {
    // The chords stepped named splits, which are gone. THE MUTANT: read the shifted bracket as the
    // pane's own trail, and ⌘⇧[ walks Back when nobody asked it to.
    const { store } = await mount();
    const leaf = store.getState().focusedLeafId!;
    await store.getState().openItem("i1", leaf);
    await store.getState().openItem("i2", leaf);
    fireEvent.keyDown(window, { key: "{", metaKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "}", metaKey: true, shiftKey: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(store.getState().paneHistory[leaf]!.entries.map((e) => e.itemId)).toEqual(["i1", "i2"]);
    expect(screen.getByRole("button", { name: "Rename two" })).toBeInTheDocument();
  });
});
