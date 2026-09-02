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

const back = () => screen.getByRole("button", { name: /^Back in / });
const forward = () => screen.getByRole("button", { name: /^Forward in / });

describe("the PanelBar's back/forward arrows", () => {
  it("are present but disabled on a pane with nowhere to go, and arm as the pane accumulates a trail", async () => {
    const { store } = await mount();
    await store.getState().openItem("i1", store.getState().focusedLeafId);
    // Disabled, not hidden: an arrow that comes and goes would shift the title under the pointer.
    await waitFor(() => expect(back()).toBeDisabled());
    expect(forward()).toBeDisabled();

    await store.getState().openItem("i2", store.getState().focusedLeafId);
    await waitFor(() => expect(back()).toBeEnabled());
    expect(forward()).toBeDisabled(); // nothing ahead until you have gone back
  });

  it("walk the pane back and forward, and re-render the arrows as the ends move", async () => {
    const { store } = await mount();
    const leaf = store.getState().focusedLeafId!;
    await store.getState().openItem("i1", leaf);
    await store.getState().openItem("i2", leaf);
    await waitFor(() => expect(screen.getByRole("button", { name: "Rename two" })).toBeInTheDocument());

    back().click();
    await waitFor(() => expect(screen.getByRole("button", { name: "Rename one" })).toBeInTheDocument());
    expect(back()).toBeDisabled();      // at the start of the trail
    expect(forward()).toBeEnabled();    // …with somewhere to go

    forward().click();
    await waitFor(() => expect(screen.getByRole("button", { name: "Rename two" })).toBeInTheDocument());
    expect(forward()).toBeDisabled();
  });

  it("each pane's arrows are its own — a split's neighbour is untouched", async () => {
    const { store } = await mount();
    const a = store.getState().focusedLeafId!;
    await store.getState().openItem("i1", a);
    await store.getState().splitFocused("row");
    const b = store.getState().focusedLeafId!;
    await store.getState().openItem("i2", b);
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Back in / })).toHaveLength(2));

    // Pane A never changed its occupant; pane B replaced an empty leaf, so neither can go back yet.
    const [backA, backB] = screen.getAllByRole("button", { name: /^Back in / });
    expect(backA).toBeDisabled();
    expect(backB).toBeDisabled();
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

  it("⌘⇧[ / ⌘⇧] still mean pane GROUPS, not the pane's own trail", async () => {
    const { store } = await mount();
    const leaf = store.getState().focusedLeafId!;
    await store.getState().openItem("i1", leaf);
    await store.getState().openItem("i2", leaf);
    await store.getState().newPaneGroup("Second");
    const groupCount = store.getState().groups!.groups.length;
    expect(groupCount).toBe(2);

    fireEvent.keyDown(window, { key: "{", metaKey: true, shiftKey: true });
    // The group moved; the trail of the pane in the group we left did NOT.
    await waitFor(() => expect(store.getState().groups!.activeGroupId).toBe(store.getState().groups!.groups[0]!.id));
    expect(store.getState().paneHistory[leaf]!.entries.map((e) => e.itemId)).toEqual(["i1", "i2"]);
  });
});
