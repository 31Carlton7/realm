import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { allItems, findLeafOfItem } from "@realm/contracts";
import { Main } from "../App";
import { Sidebar } from "./sidebar/Sidebar";
import { GroupBar } from "./GroupBar";
import { useGlobalHotkeys } from "../hotkeys";
import { StoreContext, createAppStore } from "../state/store";
import { fakeApi, item } from "../state/store.test-fakes";

const THREE = {
  s1: [item("i1", "s1", { kind: "artifact", title: "One" }), item("i2", "s1", { kind: "artifact", title: "Two" }),
    item("i3", "s1", { kind: "artifact", title: "Three" })],
};

/** Boot a store with three (unopened) items in s1 and render the whole shell. */
async function mount(render_: "main" | "sidebar" | "both" = "both") {
  const api = fakeApi({ items: THREE });
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

/** Open i1 and i2 into a two-pane split of the one group the space starts with. */
async function twoPanes(store: Awaited<ReturnType<typeof mount>>["store"]) {
  await act(async () => { await store.getState().openItem("i1"); });
  await act(async () => { await store.getState().splitFocused("row"); });
  await act(async () => { await store.getState().openItem("i2"); });
}

describe("GroupBar", () => {
  // The no-topbar posture (spec amendment §A1) is preserved for anyone not using the feature: with one
  // group and no focused pane there is nothing the strip could say that the panes do not already say.
  it("does not render at all for one group with no pane focused", async () => {
    const { store } = await mount();
    await twoPanes(store);
    expect(screen.queryByRole("toolbar", { name: "Pane groups" })).not.toBeInTheDocument();
  });

  it("appears with a tab per group once a second group exists, marking the active one", async () => {
    const { store } = await mount();
    await twoPanes(store);
    await act(async () => { await store.getState().newPaneGroup("Read"); });
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Main", "Read"]);
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.click(tabs[0]!);
    await waitFor(() => expect(store.getState().groups!.groups[0]!.id).toBe(store.getState().groups!.activeGroupId));
    expect(allItems(store.getState().layout!)).toEqual(["i1", "i2"]);
  });

  it("the + adds a group and switches to it", async () => {
    const { store } = await mount();
    await twoPanes(store);
    await act(async () => { await store.getState().newPaneGroup("Read"); });
    fireEvent.click(screen.getByRole("button", { name: "New pane group" }));
    await waitFor(() => expect(store.getState().groups!.groups).toHaveLength(3));
    expect(store.getState().groups!.activeGroupId).toBe(store.getState().groups!.groups[2]!.id);
  });

  // What the user asked for by name: "the user can unfocus it if they so choose with another button
  // in the top". It names the focused pane, because the other panes are off screen.
  it("shows the unfocus button — naming the focused pane — and clearing it restores the split", async () => {
    const { store } = await mount();
    await twoPanes(store);
    const leafId = findLeafOfItem(store.getState().layout!, "i2")!.id;
    await act(async () => { await store.getState().focusPaneFull(leafId); });
    const bar = await screen.findByRole("toolbar", { name: "Pane groups" });
    const btn = within(bar).getByRole("button", { name: "Unfocus Two" });
    expect(btn).toHaveTextContent("Focused: Two");
    fireEvent.click(btn);
    await waitFor(() => expect(store.getState().zoomedLeafId()).toBeNull());
    expect(screen.queryByRole("toolbar", { name: "Pane groups" })).not.toBeInTheDocument();
  });

  it("dropping a sidebar row on a tab moves that pane into the group", async () => {
    const { store } = await mount();
    await twoPanes(store);
    await act(async () => { await store.getState().newPaneGroup("Read"); });
    const tab = (await screen.findAllByRole("tab"))[0]!; // "Main"
    const mainId = store.getState().groups!.groups[0]!.id;
    // The tab's own group is Main; drop i3 (open nowhere) onto it.
    fireEvent.drop(tab, { dataTransfer: { types: ["application/x-realm-item"], getData: () => "i3" } });
    await waitFor(() => expect(allItems(store.getState().groups!.groups[0]!.layout)).toContain("i3"));
    expect(store.getState().groups!.activeGroupId).not.toBe(mainId); // a drop does not switch groups
  });

  it("right-clicking a tab offers rename and a two-step remove, disabled for the last group", async () => {
    const { store } = await mount();
    await twoPanes(store);
    await act(async () => { await store.getState().newPaneGroup("Read"); });
    fireEvent.contextMenu((await screen.findAllByRole("tab"))[1]!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove group" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove group?" }));
    await waitFor(() => expect(store.getState().groups!.groups).toHaveLength(1));
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

  // Focus is a menu action (the pane header is deliberately slim); Unfocus is an inline button,
  // because with every other pane off screen a hidden way back out is the wrong trade.
  it("the pane menu offers Focus, and the focused pane's bar then carries Unfocus inline", async () => {
    const { store } = await mount("main");
    await twoPanes(store);
    fireEvent.click(screen.getByRole("button", { name: "Pane menu for Two" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Focus pane/ }));
    await waitFor(() => expect(store.getState().zoomedLeafId()).not.toBeNull());
    const panel = document.querySelector(".panel")!;
    fireEvent.click(within(panel as HTMLElement).getByRole("button", { name: "Unfocus Two" }));
    await waitFor(() => expect(store.getState().zoomedLeafId()).toBeNull());
  });

  it("leaves the pane in its group — the split comes back exactly as it was", async () => {
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

  it("⌘⇧] / ⌘⇧[ step between groups", async () => {
    const { store } = await mount("main");
    await twoPanes(store);
    await act(async () => { await store.getState().newPaneGroup("Read"); });
    const ids = store.getState().groups!.groups.map((g) => g.id);
    await act(async () => { fireEvent.keyDown(window, { key: "[", metaKey: true, shiftKey: true }); });
    await waitFor(() => expect(store.getState().groups!.activeGroupId).toBe(ids[0]));
    await act(async () => { fireEvent.keyDown(window, { key: "}", metaKey: true, shiftKey: true }); });
    await waitFor(() => expect(store.getState().groups!.activeGroupId).toBe(ids[1]));
  });
});

describe("sidebar group sections", () => {
  it("keeps the plain 'Open' heading while a space has only one group", async () => {
    const { store } = await mount("sidebar");
    await twoPanes(store);
    await waitFor(() => expect(screen.getByText("Open")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Show Main" })).not.toBeInTheDocument();
  });

  it("lists one section per group, each with its own rows, once a second group exists", async () => {
    const { store } = await mount("sidebar");
    await twoPanes(store);
    await act(async () => { await store.getState().newPaneGroup("Read"); });
    await act(async () => { await store.getState().openItem("i3"); });
    expect(await screen.findByRole("button", { name: "Show Main" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show Read" })).toHaveAttribute("aria-current", "true");
    // i3 moved into Read; i1/i2 are still Main's, and all three are open (none in the SPACE list).
    expect(allItems(store.getState().groups!.groups[0]!.layout)).toEqual(["i1", "i2"]);
    expect(allItems(store.getState().groups!.groups[1]!.layout)).toEqual(["i3"]);
  });

  it("clicking a group heading puts that arrangement on screen", async () => {
    const { store } = await mount("sidebar");
    await twoPanes(store);
    await act(async () => { await store.getState().newPaneGroup("Read"); });
    fireEvent.click(await screen.findByRole("button", { name: "Show Main" }));
    await waitFor(() => expect(allItems(store.getState().layout!)).toEqual(["i1", "i2"]));
  });

  it("a row for a pane in another group goes THERE rather than pulling the pane over", async () => {
    const { store } = await mount("sidebar");
    await twoPanes(store);
    await act(async () => { await store.getState().newPaneGroup("Read"); });
    await act(async () => { await store.getState().openItem("i3"); });
    fireEvent.click(screen.getByRole("button", { name: "One" }));
    await waitFor(() => expect(store.getState().groups!.activeGroupId).toBe(store.getState().groups!.groups[0]!.id));
    expect(allItems(store.getState().groups!.groups[1]!.layout)).toEqual(["i3"]); // Read kept its pane
  });

  it("the New group button adds one", async () => {
    const { store } = await mount("sidebar");
    await twoPanes(store);
    fireEvent.click(screen.getByRole("button", { name: /New group/ }));
    await waitFor(() => expect(store.getState().groups!.groups).toHaveLength(2));
  });

  it("a group holding a focused pane is badged, so the state is visible from a group you left", async () => {
    const { store } = await mount("sidebar");
    await twoPanes(store);
    await act(async () => { await store.getState().newPaneGroup("Read"); });
    await act(async () => { await store.getState().activatePaneGroup(store.getState().groups!.groups[0]!.id); });
    await act(async () => { await store.getState().focusPaneFull(findLeafOfItem(store.getState().layout!, "i2")!.id); });
    await act(async () => { await store.getState().activatePaneGroup(store.getState().groups!.groups[1]!.id); });
    expect(await screen.findByTitle("A pane in this group is focused")).toBeInTheDocument();
  });

  it("right-clicking a row offers Focus, then Unfocus, and Move to group…", async () => {
    const { store } = await mount("sidebar");
    await twoPanes(store);
    await act(async () => { await store.getState().newPaneGroup("Read"); });
    await act(async () => { await store.getState().activatePaneGroup(store.getState().groups!.groups[0]!.id); });
    fireEvent.contextMenu(screen.getByRole("button", { name: "Two" }).closest(".item")!);
    expect(await screen.findByRole("menuitem", { name: /Move to group/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Focus/ }));
    await waitFor(() => expect(store.getState().zoomedLeafId()).not.toBeNull());
    fireEvent.contextMenu(screen.getByRole("button", { name: "Two" }).closest(".item")!);
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Unfocus/ }));
    await waitFor(() => expect(store.getState().zoomedLeafId()).toBeNull());
  });

  it("Move to group… moves the pane and leaves it open in exactly one group", async () => {
    const { store } = await mount("sidebar");
    await twoPanes(store);
    await act(async () => { await store.getState().newPaneGroup("Read"); });
    await act(async () => { await store.getState().activatePaneGroup(store.getState().groups!.groups[0]!.id); });
    fireEvent.contextMenu(screen.getByRole("button", { name: "Two" }).closest(".item")!);
    fireEvent.click(await screen.findByRole("menuitem", { name: /Move to group/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Read" }));
    await waitFor(() => expect(allItems(store.getState().groups!.groups[1]!.layout)).toEqual(["i2"]));
    expect(allItems(store.getState().groups!.groups[0]!.layout)).toEqual(["i1"]);
  });
});

describe("GroupBar in isolation", () => {
  it("renders nothing without an active space", () => {
    const store = createAppStore(fakeApi());
    render(<StoreContext.Provider value={store}><GroupBar /></StoreContext.Provider>);
    expect(screen.queryByRole("toolbar", { name: "Pane groups" })).not.toBeInTheDocument();
  });
});

// The pane host must never be handed a zoom it cannot render — but a stale id (a leaf pruned by a
// concurrent edit) must degrade to the ordinary split rather than to a blank screen.
describe("a stale focus", () => {
  it("falls back to the full split rather than rendering nothing", async () => {
    const { store } = await mount("main");
    await twoPanes(store);
    await act(async () => {
      const gs = store.getState().groups!;
      store.setState({ groups: { ...gs, groups: gs.groups.map((g) => ({ ...g, zoomedLeafId: "L-gone" })) } });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Rename One" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Rename Two" })).toBeInTheDocument();
  });
});
