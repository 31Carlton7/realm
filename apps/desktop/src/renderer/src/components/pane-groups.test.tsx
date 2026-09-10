import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, createEvent, waitFor, act, within } from "@testing-library/react";
import { allItems, findLeafOfItem } from "@realm/contracts";
import { Main } from "../App";
import { Sidebar } from "./sidebar/Sidebar";
import { GroupBar } from "./GroupBar";
import { CommandPalette } from "./CommandPalette";
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

  /* The strip no longer appears for a focus. It used to grow a "Focused: <title> | Unfocus" card,
     which meant one group with a pane focused put a whole row of chrome across the window to report
     one bit — a bit the pane bar's own focus toggle now carries by being lit. THE mutant: restore
     `|| zoomed` to the gate and a space with one group grows a bar again for a state that is already
     on screen. */
  it("does NOT appear for a focused pane in a space with one group — the pane bar says that now", async () => {
    const { store } = await mount();
    await twoPanes(store);
    await act(async () => { await store.getState().focusPaneFull(findLeafOfItem(store.getState().layout!, "i2")!.id); });
    expect(store.getState().zoomedLeafId()).not.toBeNull();
    expect(screen.queryByRole("toolbar", { name: "Pane groups" })).not.toBeInTheDocument();
    // …and nothing anywhere still draws the banner's copy.
    expect(screen.queryByText(/^Focused/)).not.toBeInTheDocument();
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

  it("renaming a group from its tab actually renames it", async () => {
    /* The bug this pins: the sidebar rendered a rename editor for the same group as the tab strip,
       both autoFocus. The second to mount took focus, the first fired blur, and blur commits — with
       an unchanged value, so it renamed nothing and cleared the request. `renamingGroupId` went
       id → null inside the one click, both fields unmounted, and the name was never editable. */
    const { store } = await mount();
    await twoPanes(store);
    await act(async () => { await store.getState().newPaneGroup("Read"); });
    fireEvent.contextMenu((await screen.findAllByRole("tab"))[1]!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename group" }));

    const field = await screen.findByRole("textbox", { name: "Rename Read" });
    fireEvent.change(field, { target: { value: "Ship" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(store.getState().groups!.groups.map((g) => g.name)).toContain("Ship"));
  });

  it("arms exactly ONE editor — the tab's, not a twin in the sidebar", async () => {
    // THE MUTANT: render a second GroupRenameInput for `renamingGroupId` anywhere else in the tree.
    // Both take autoFocus, and whichever loses the fight commits an unchanged name and closes both.
    const { store } = await mount("both");
    await twoPanes(store);
    await act(async () => { await store.getState().newPaneGroup("Read"); });
    fireEvent.contextMenu((await screen.findAllByRole("tab"))[1]!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename group" }));
    expect(screen.getAllByRole("textbox", { name: "Rename Read" })).toHaveLength(1);
    // And the request survives the mount, which is the thing the twin destroyed.
    expect(store.getState().renamingGroupId).not.toBeNull();
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

  /* One control, both directions, and it says which way it is pointing by being lit — the treatment
     the summary button already wears. THE mutant: drop `data-on` and the only thing left saying a
     pane is focused is the absence of its siblings, which is exactly the gap the removed banner was
     invented to fill. */
  it("the pane bar's focus control is ONE toggle: it fills while focused, and its name flips", async () => {
    const { store } = await mount("main");
    await twoPanes(store);
    const off = screen.getByRole("button", { name: "Focus Two" });
    expect(off.closest(".panel-bar")).not.toBeNull();
    expect(off).not.toHaveAttribute("data-on");
    fireEvent.click(off);
    await waitFor(() => expect(store.getState().zoomedLeafId()).not.toBeNull());
    const on = screen.getByRole("button", { name: "Unfocus Two" });
    expect(on).toHaveAttribute("data-on");
    // The same control flipped, not a second one that appeared beside it.
    expect(screen.queryByRole("button", { name: "Focus Two" })).toBeNull();
    fireEvent.click(on);
    await waitFor(() => expect(store.getState().zoomedLeafId()).toBeNull());
    expect(screen.getByRole("button", { name: "Focus Two" })).not.toHaveAttribute("data-on");
  });

  it("the ⋯ menu still offers Focus, for the shortcut it prints beside it", async () => {
    const { store } = await mount("main");
    await twoPanes(store);
    fireEvent.click(screen.getByRole("button", { name: "Pane menu for Two" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Focus pane/ }));
    await waitFor(() => expect(store.getState().zoomedLeafId()).not.toBeNull());
  });

  /* A group with one leaf renders the same focused or not, so the toggle would be a lit button with
     no visible effect — the dead chrome the pane bar bans. THE mutant: drop the `canFocus` gate in
     PaneHost and the app's most common shape, one pane full width, grows a control that does nothing
     a user can see. */
  it("a solo pane gets no focus toggle at all — there is nothing for it to hide", async () => {
    const { store } = await mount("main");
    await act(async () => { await store.getState().openItem("i1"); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Rename One" })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Focus One" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Pane menu for One" }));
    expect(screen.queryByRole("menuitem", { name: /Focus pane/ })).toBeNull();
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

describe("reordering the tab strip", () => {
  /** A drag payload that behaves like the real one: keyed, and reporting its own types. */
  const transfer = (type: string, value: string) => {
    const store = new Map([[type, value]]);
    return { types: [...store.keys()], getData: (k: string) => store.get(k) ?? "", setData: (k: string, v: string) => { store.set(k, v); }, effectAllowed: "", dropEffect: "" };
  };
  /** jsdom lays nothing out, so which HALF of a tab the pointer is over has to be stated. */
  const withRect = (el: HTMLElement, left: number, width: number) => {
    el.getBoundingClientRect = () => ({ left, width, right: left + width, top: 0, bottom: 24, height: 24, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;
  };
  /** jsdom's DragEvent drops the mouse coordinates, so `fireEvent.dragOver(el, { clientX })` arrives
   *  with `clientX: undefined` and every comparison against the tab's midpoint reads false — both
   *  halves would test the same branch. Building the event and defining the property is what makes
   *  the near/far distinction actually exercisable. */
  const dragAt = (kind: "dragOver" | "drop", el: HTMLElement, dataTransfer: unknown, clientX: number) => {
    const ev = createEvent[kind](el, { dataTransfer } as never);
    Object.defineProperty(ev, "clientX", { value: clientX });
    fireEvent(el, ev);
  };
  /** Three tabs: Main, Read, Notes. */
  const three = async () => {
    const { store } = await mount();
    await twoPanes(store);
    await act(async () => { await store.getState().newPaneGroup("Read"); });
    await act(async () => { await store.getState().newPaneGroup("Notes"); });
    return store;
  };
  const names = (store: ReturnType<typeof createAppStore>) => store.getState().groups!.groups.map((g) => g.name);

  it("drops a tab onto the far half of another and lands PAST it, not one short", async () => {
    // The classic reorder bug: the gap under the pointer is an index in the strip as it stands, and
    // the dragged tab has not left its slot yet. Dragging Main onto the right half of Read must end
    // Main after Read.
    const store = await three();
    const tabs = await screen.findAllByRole("tab");
    const dt = transfer("application/x-realm-group", store.getState().groups!.groups[0]!.id);
    fireEvent.dragStart(tabs[0]!, { dataTransfer: dt });
    // Right half of the middle tab. jsdom gives every element a zero rect, so `clientX` past 0 is
    // the far half — which is exactly the branch under test.
    withRect(tabs[1]!, 100, 60);
    dragAt("dragOver", tabs[1]!, dt, 145); // far half
    dragAt("drop", tabs[1]!, dt, 145);
    await waitFor(() => expect(names(store)).toEqual(["Read", "Main", "Notes"]));
  });

  it("drops onto the near half and lands before it", async () => {
    const store = await three();
    const tabs = await screen.findAllByRole("tab");
    const dt = transfer("application/x-realm-group", store.getState().groups!.groups[2]!.id);
    fireEvent.dragStart(tabs[2]!, { dataTransfer: dt });
    withRect(tabs[1]!, 100, 60);
    dragAt("dragOver", tabs[1]!, dt, 115); // near half
    dragAt("drop", tabs[1]!, dt, 115);
    await waitFor(() => expect(names(store)).toEqual(["Main", "Notes", "Read"]));
  });

  it("keeps which arrangement is on screen — a reorder is not a switch", async () => {
    const store = await three();
    const active = store.getState().groups!.activeGroupId;
    const tabs = await screen.findAllByRole("tab");
    const dt = transfer("application/x-realm-group", store.getState().groups!.groups[0]!.id);
    fireEvent.dragStart(tabs[0]!, { dataTransfer: dt });
    withRect(tabs[2]!, 200, 60);
    dragAt("dragOver", tabs[2]!, dt, 245);
    dragAt("drop", tabs[2]!, dt, 245);
    await waitFor(() => expect(names(store)).toEqual(["Read", "Notes", "Main"]));
    expect(store.getState().groups!.activeGroupId).toBe(active);
  });

  it("still moves a PANE when a sidebar row is the thing being dragged", async () => {
    // The two gestures share these tabs. A tab drop must not swallow the pane drop, and the payload
    // is what tells them apart — the mutant is keying off "a drag is in flight" instead.
    const store = await three();
    const tabs = await screen.findAllByRole("tab");
    const before = names(store);
    const dt = transfer("application/x-realm-item", "i1");
    fireEvent.dragOver(tabs[1]!, { dataTransfer: dt });
    fireEvent.drop(tabs[1]!, { dataTransfer: dt });
    await waitFor(() => expect(allItems(store.getState().groups!.groups[1]!.layout)).toEqual(["i1"]));
    expect(names(store)).toEqual(before); // and the strip did not reorder
  });

  it("moves a tab from the keyboard, so the gesture is not pointer-only", async () => {
    const store = await three();
    const tabs = await screen.findAllByRole("tab");
    fireEvent.keyDown(tabs[0]!, { key: "ArrowRight", altKey: true });
    await waitFor(() => expect(names(store)).toEqual(["Read", "Main", "Notes"]));
    const moved = (await screen.findAllByRole("tab"))[1]!;
    fireEvent.keyDown(moved, { key: "ArrowLeft", altKey: true });
    await waitFor(() => expect(names(store)).toEqual(["Main", "Read", "Notes"]));
  });

  it("leaves the arrow keys alone without the modifier", async () => {
    // ← / → belong to the tablist's own roving focus; only ⌥ makes them a move.
    const store = await three();
    const tabs = await screen.findAllByRole("tab");
    fireEvent.keyDown(tabs[0]!, { key: "ArrowRight" });
    await new Promise((r) => setTimeout(r, 20));
    expect(names(store)).toEqual(["Main", "Read", "Notes"]);
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

  it("offers no group switches while a space has only one group", async () => {
    const { store } = await open();
    await twoPanes(store);
    await show(store);
    expect(screen.queryByText(/^Group: /)).not.toBeInTheDocument();
    expect(screen.getByText("New pane group")).toBeInTheDocument();
  });

  it("lists every group once there is more than one, marking the current, and switches on pick", async () => {
    const { store } = await open();
    await twoPanes(store);
    await act(async () => { await store.getState().newPaneGroup("Read"); });
    await show(store);
    expect(screen.getByText("Group: Main")).toBeInTheDocument();
    expect(screen.getByText("Group: Read")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Group: Main"));
    await waitFor(() => expect(allItems(store.getState().layout!)).toEqual(["i1", "i2"]));
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
});
