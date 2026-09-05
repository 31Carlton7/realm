import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { allItems, findLeafOfItem, type Layout } from "@realm/contracts";
import { Sidebar } from "./Sidebar";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, iconAsset, item, session, space } from "../../state/store.test-fakes";
import { paneSlotOf } from "./ItemList";
import { exited } from "../popover-exit.test-fakes";

async function mount(api = fakeApi()) {
  const store = createAppStore(api); await store.getState().boot();
  const r = render(<StoreContext.Provider value={store}><Sidebar /></StoreContext.Provider>);
  return { store, api, ...r };
}

describe("Arc sidebar", () => {
  it("hydrates saved custom space icons before the strip renders", async () => {
    const asset = iconAsset("ia-saved", "p1");
    const api = fakeApi({
      spaces: [space("s1", "p1", "Versed", { icon: `asset:${asset.id}` })],
      iconAssets: { p1: [asset] },
    });
    await mount(api);
    const button = screen.getByRole("button", { name: "Switch to space Versed" });
    expect(api.calls).toContain("listIconAssets:p1");
    expect(button.querySelector("circle")).not.toBeNull();
  });

  it("shows only the active space's items, the space strip with all spaces, and switches on strip click", async () => {
    const { store } = await mount();
    expect(screen.getByRole("heading", { name: /Versed/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Homework/ })).not.toBeInTheDocument(); // other pages are aria-hidden
    expect(screen.getByRole("button", { name: "Terminal" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /switch to space/i })).toHaveLength(2);
    expect(screen.getByRole("button", { name: /switch to space Versed/i })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: /switch to space Homework/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /Homework/ })).toBeInTheDocument());
    expect(store.getState().activeSpaceId).toBe("s2");
    expect(screen.queryByRole("button", { name: "Terminal" })).not.toBeInTheDocument();
  });

  it("session items show a status dot that follows sessionStatus, and the row's accessible name carries the status (A-L4)", async () => {
    const { store } = await mount(fakeApi({ items: { s1: [item("i1", "s1", { title: "Terminal" }), item("i2", "s1", { kind: "session", refId: "se1", title: "Fix the build" })] } }));
    const row = () => screen.getByRole("button", { name: /^Fix the build/ });
    expect(row().querySelector(".status-dot")).toBeNull(); // no status known yet
    expect(row()).toHaveAccessibleName("Fix the build");
    act(() => store.getState().applySessionStatus("se1", "waiting_permission"));
    expect(row().querySelector(".status-dot")).toHaveAttribute("data-status", "waiting_permission");
    expect(row()).toHaveAccessibleName("Fix the build — needs permission");
    act(() => store.getState().applySessionStatus("se1", "idle"));
    expect(row().querySelector(".status-dot")).toHaveAttribute("data-status", "idle");
    expect(row()).toHaveAccessibleName("Fix the build — idle");
    expect(screen.getByRole("button", { name: "Terminal" }).querySelector(".status-dot")).toBeNull();
  });

  it("an empty space shows one faint hint line pointing at New session (A-L6)", async () => {
    await mount(fakeApi({ items: { s1: [] } }));
    expect(screen.getByText(/Nothing here yet/)).toBeInTheDocument();
  });

  it("pinned items render as tiles, unpinned in the list", async () => {
    await mount(fakeApi({ items: { s1: [item("i1", "s1", { pinned: true, title: "GitHub" }), item("i2", "s1", { title: "Terminal" })] } }));
    expect(screen.getByRole("button", { name: /GitHub/ })).toHaveAttribute("data-tile", "true");
    expect(screen.getByRole("button", { name: "Terminal" })).not.toHaveAttribute("data-tile");
  });

  it("two-finger horizontal wheel on the sidebar switches spaces; vertical wheel does not", async () => {
    const { store, container } = await mount();
    const swiper = container.querySelector("[data-swiper]")!;
    fireEvent.wheel(swiper, { deltaX: 0, deltaY: 120 });
    fireEvent.wheel(swiper, { deltaX: 50, deltaY: 0 }); fireEvent.wheel(swiper, { deltaX: 50, deltaY: 0 });
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s2"));
  });

  // §6's do-NOT-animate list names "sidebar space swipes triggered by keyboard": the page slide is
  // the tail of a gesture the fingers began, so it belongs to gestures alone.
  describe("space switches only slide when a gesture asked for it (§6)", () => {
    const track = (c: HTMLElement) => c.querySelector<HTMLElement>(".swiper-track")!;

    it("a keyboard/programmatic switch lands on the new page instantly", async () => {
      const { store, container } = await mount();
      expect(track(container).style.transform).toBe("translateX(0%)");
      await act(async () => { await store.getState().nextSpace(); });
      expect(track(container).style.transform).toBe("translateX(-100%)");
      expect(track(container).style.transition).toBe("none");
    });

    it("a click on the space strip lands instantly too", async () => {
      const { container } = await mount();
      fireEvent.click(screen.getByRole("button", { name: /switch to space Homework/i }));
      await waitFor(() => expect(track(container).style.transform).toBe("translateX(-100%)"));
      expect(track(container).style.transition).toBe("none");
    });

    it("a committed two-finger swipe still eases to the page it threw", async () => {
      const { container } = await mount();
      const swiper = container.querySelector("[data-swiper]")!;
      fireEvent.wheel(swiper, { deltaX: 50, deltaY: 0 }); fireEvent.wheel(swiper, { deltaX: 50, deltaY: 0 });
      await waitFor(() => expect(track(container).style.transform).toBe("translateX(-100%)"));
      expect(track(container).style.transition).toContain("transform 300ms");
    });

    // The page being left empties the instant activeSpaceId flips (selectSpace clears `items` and
    // refetches), so without a snapshot a commit slides a blank page out and a blank page in.
    it("a committed swipe keeps the page it is leaving filled in while it slides out", async () => {
      const { container } = await mount();
      const page = () => container.querySelector('[data-space-page="s1"]')!.textContent ?? "";
      const swiper = container.querySelector("[data-swiper]")!;
      fireEvent.wheel(swiper, { deltaX: 50, deltaY: 0 }); fireEvent.wheel(swiper, { deltaX: 50, deltaY: 0 });
      await waitFor(() => expect(track(container).style.transform).toBe("translateX(-100%)"));
      expect(page()).toContain("Terminal");
      await waitFor(() => expect(page()).not.toContain("Terminal")); // dropped once the slide is over
    });

    // A 120Hz trackpad delivers several deltas per frame; writing the transform on each one is
    // recalc work the compositor throws away, and it is what made the drag stutter.
    it("drag frames are written on the next animation frame, not inline on every wheel event", async () => {
      const { container } = await mount();
      fireEvent.wheel(container.querySelector("[data-swiper]")!, { deltaX: 20, deltaY: 0 });
      expect(track(container).style.transform).toBe("translateX(0%)"); // nothing written yet
      await act(async () => { await new Promise(requestAnimationFrame); });
      expect(track(container).style.transform).toContain("20px");
    });

    it("a swipe that never reaches the threshold eases back to the page it started on", async () => {
      const { container } = await mount();
      fireEvent.wheel(container.querySelector("[data-swiper]")!, { deltaX: 20, deltaY: 0 });
      await waitFor(() => expect(track(container).style.transition).toContain("transform 220ms"));
      expect(track(container).style.transform).toBe("translateX(0%)"); // settle is shorter than a commit
    });

    it("an instant switch has nothing to slide, so the page it left empties at once", async () => {
      const { container } = await mount();
      fireEvent.click(screen.getByRole("button", { name: /switch to space Homework/i }));
      await waitFor(() => expect(track(container).style.transform).toBe("translateX(-100%)"));
      expect(container.querySelector('[data-space-page="s1"]')!.textContent).not.toContain("Terminal");
    });
  });

  it("right-click on an item offers Pin, which moves it to the pinned grid; Delete removes it permanently", async () => {
    const { store, api } = await mount();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Terminal" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Terminal/ })).toHaveAttribute("data-tile", "true"));
    expect(store.getState().items[0]?.pinned).toBe(true);
    // i1 is unopened (default layout is null), so Close should not even be offered here.
    await exited();
    fireEvent.contextMenu(screen.getByRole("button", { name: /Terminal/ }));
    expect(screen.queryByRole("menuitem", { name: "Close" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Really delete?" }));
    await waitFor(() => expect(store.getState().items.map((i) => i.id)).not.toContain("i1"));
    expect(api.calls).toContain("deleteItem:i1");
  });

  it("Delete is two-step: the first click arms 'Really delete?' without deleting; reopening the menu disarms; the second click deletes", async () => {
    const { store, api } = await mount();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Terminal" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    // Armed in place: the menu stays open, the row relabels, and NOTHING was deleted.
    expect(api.calls).not.toContain("deleteItem:i1");
    expect(store.getState().items).toHaveLength(1);
    expect(screen.queryByRole("menuitem", { name: "Delete" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Really delete?" })).toBeInTheDocument();
    // Reopening the menu resets the confirmation.
    fireEvent.contextMenu(screen.getByRole("button", { name: "Terminal" }));
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Really delete?" })).not.toBeInTheDocument();
    expect(api.calls).not.toContain("deleteItem:i1");
    // Two clicks within one open menu delete for real.
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Really delete?" }));
    await waitFor(() => expect(store.getState().items.map((i) => i.id)).not.toContain("i1"));
    expect(api.calls).toContain("deleteItem:i1");
  });

  it("rename via the context menu commits on Enter", async () => {
    const { store } = await mount();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Terminal" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: /Rename Terminal/ });
    fireEvent.change(input, { target: { value: "Build" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(store.getState().items[0]?.title).toBe("Build"));
    expect(screen.getByRole("button", { name: "Build" })).toBeInTheDocument();
  });

  it("the sidebar's + creates a session on the first click — no menu, no sheet, nothing to answer (W3)", async () => {
    const { store, api } = await mount();
    const plus = screen.getByRole("button", { name: "New session" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(plus);
    await waitFor(() => expect(Object.keys(store.getState().sessions)).toHaveLength(1));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(store.getState().sheet).toBeNull();
    expect(api.calls).toContain("createSession:claude");
    const created = Object.values(store.getState().sessions)[0]!;
    expect(store.getState().items.some((i) => i.kind === "session" && i.refId === created.id)).toBe(true);
    // The tooltip names the agent you'll actually get, and follows the last-used memory.
    expect(plus).toHaveAttribute("title", "New Claude session (⌘N)");
    await waitFor(() => expect(screen.getByRole("button", { name: "New session" })).toHaveAttribute("title", "New Claude session (⌘N)"));
    await act(() => store.getState().newSession({ agentKind: "codex" }));
    expect(screen.getByRole("button", { name: "New session" })).toHaveAttribute("title", "New Codex session (⌘N)");
  });

  it("the New session row is draggable without creating until it is dropped", async () => {
    const { store, api } = await mount();
    const button = screen.getByRole("button", { name: "New session" });
    const row = button.closest(".new-item")!;
    expect(row).toHaveAttribute("draggable", "true");
    const setData = vi.fn();
    fireEvent.dragStart(row, { dataTransfer: { setData, effectAllowed: "", types: [], getData: () => "" } });
    expect(setData).toHaveBeenCalledWith("application/x-realm-new-session", "new-session");
    expect(row).toHaveAttribute("data-dragging");
    expect(api.calls.filter((c) => c.startsWith("createSession"))).toEqual([]);
    expect(Object.keys(store.getState().sessions)).toHaveLength(0);
    fireEvent.dragEnd(row);
    expect(row).not.toHaveAttribute("data-dragging");
  });

  it("the space menu opens a session in a fresh worktree, leaving \"+\" as the no-questions path (W2)", async () => {
    const { store, api } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Space menu" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "Space menu" })).getByText("New session in a worktree"));
    await waitFor(() => expect(api.calls).toContain("createWorktree:s1"));
    await waitFor(() => expect(Object.keys(store.getState().sessions)).toHaveLength(1));
    const env = api.data.environments.s1![0]!;
    const created = Object.values(store.getState().sessions)[0]!;
    // Pinned to the worktree, and its cwd follows the environment rather than the space folder (W1).
    expect(created.environmentId).toBe(env.id);
    expect(created.cwd).toBe(env.path);
    expect(store.getState().environments[env.id]).toMatchObject({ kind: "worktree" });
  });

  it("menus render in a portal with fixed positioning so ancestor overflow can't clip them (regression: the swiper's overflow:clip was hiding menus)", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Space menu" }));
    const menu = screen.getByRole("menu", { name: "Space menu" });
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.position).toBe("fixed");
  });

  it("dragging a strip icon onto another reorders spaces", async () => {
    const { store, api } = await mount();
    const versed = screen.getByRole("button", { name: /switch to space Versed/i });
    const homework = screen.getByRole("button", { name: /switch to space Homework/i });
    const dt = { effectAllowed: "", setData: () => {}, getData: () => "s2" };
    fireEvent.dragStart(homework, { dataTransfer: dt });
    fireEvent.dragOver(versed, { dataTransfer: dt });
    fireEvent.drop(versed, { dataTransfer: dt });
    await waitFor(() => expect(store.getState().spaces.map((s) => s.id)).toEqual(["s2", "s1"]));
    expect(api.calls).toContain("reorderSpaces:s2,s1");
  });

  it("dragging the first strip icon onto the last moves it to the end ([A,B,C] → [B,C,A])", async () => {
    const api = fakeApi({ spaces: [space("a", "p1", "A"), space("b", "p1", "B"), space("c", "p1", "C")], items: {} });
    const { store } = await mount(api);
    const dt = { effectAllowed: "", setData: () => {}, getData: () => "a" };
    fireEvent.dragStart(screen.getByRole("button", { name: /switch to space A$/i }), { dataTransfer: dt });
    fireEvent.drop(screen.getByRole("button", { name: /switch to space C$/i }), { dataTransfer: dt });
    await waitFor(() => expect(store.getState().spaces.map((s) => s.id)).toEqual(["b", "c", "a"]));
    // and back to the front (leftward drag lands before the target)
    fireEvent.dragStart(screen.getByRole("button", { name: /switch to space A$/i }), { dataTransfer: dt });
    fireEvent.drop(screen.getByRole("button", { name: /switch to space B$/i }), { dataTransfer: dt });
    await waitFor(() => expect(store.getState().spaces.map((s) => s.id)).toEqual(["a", "b", "c"]));
  });

  it("inactive swiper pages are inert (their controls are not reachable)", async () => {
    const { container } = await mount();
    const pages = container.querySelectorAll<HTMLElement>(".space-page");
    expect(pages).toHaveLength(2);
    expect(pages[0]!.hasAttribute("inert")).toBe(false);
    expect(pages[1]!.hasAttribute("inert")).toBe(true);
    expect(pages[1]!.getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /switch to space Homework/i }));
    await waitFor(() => expect(pages[1]!.hasAttribute("inert")).toBe(false));
    expect(pages[0]!.hasAttribute("inert")).toBe(true);
  });

  it("the profile pill opens the PROFILE page (Plan 14 W2) and + opens the new-space sheet", async () => {
    const { store } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Work" }));
    // The pill names the profile, so it opens the profile page — the space page keeps its own two
    // doors (the title row and the menu's Open space, tested below).
    await waitFor(() => expect(store.getState().items.some((i) => i.kind === "profile-page")).toBe(true));
    expect(store.getState().items.some((i) => i.kind === "space-page")).toBe(false);
    expect(store.getState().sheet).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New space" }));
    expect(store.getState().sheet).toEqual({ kind: "new-space" });
  });

  it("the header title row itself opens the space PAGE (the transcription's front door)", async () => {
    const { store } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Versed" }));
    await waitFor(() => expect(store.getState().items.some((i) => i.kind === "space-page" && i.refId === "s1")).toBe(true));
    const page = store.getState().items.find((i) => i.kind === "space-page")!;
    expect(JSON.stringify(store.getState().layout)).toContain(page.id);
  });

  it("the space menu's Open space opens the page — the sheet's ⋯ entry point did not go dead", async () => {
    const { store } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Space menu" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open space" }));
    await waitFor(() => expect(store.getState().items.some((i) => i.kind === "space-page" && i.refId === "s1")).toBe(true));
  });

  it("OPEN label is absent when nothing is open; unopened items render under SPACE", async () => {
    await mount(); // default: layout is null, i1 "Terminal" is unopened
    expect(screen.queryByText("Open")).not.toBeInTheDocument();
    expect(screen.getByText("Space")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Terminal" })).toBeInTheDocument();
  });

  it("OPEN group follows layout order (not items order); SPACE holds the rest, pinned tiles first, and a pinned-and-open item appears only in OPEN", async () => {
    // Layout order is i2 then i1 — the reverse of the items array below, so an implementation that
    // (wrongly) used items order instead of allItems(layout) order would render them the other way.
    const layout: Layout = { type: "split", id: "root", dir: "row", sizes: [50, 50], children: [
      { type: "leaf", id: "L1", itemId: "i2" },
      { type: "leaf", id: "L2", itemId: "i1" },
    ] };
    const api = fakeApi({
      spaces: [space("s1", "p1", "Versed", { layout })],
      items: { s1: [
        item("i1", "s1", { title: "Alpha", pinned: true }), // pinned AND open — belongs only to OPEN
        item("i2", "s1", { title: "Beta" }),
        item("i3", "s1", { title: "Gamma", pinned: true }), // pinned, unopened — the grid
        item("i4", "s1", { title: "Delta" }), // unpinned, unopened — the space list
      ] },
    });
    await mount(api);
    expect(screen.getByText("Open")).toBeInTheDocument();
    const lists = document.querySelectorAll(".item-list");
    const openTitles = Array.from(lists[0]!.querySelectorAll(".item-title")).map((n) => n.textContent);
    expect(openTitles).toEqual(["Beta", "Alpha"]); // layout order, not items-array order
    const pinnedGrid = document.querySelector(".pinned-grid")!;
    expect(pinnedGrid.textContent).toContain("Gamma");
    expect(pinnedGrid.textContent).not.toContain("Alpha"); // open-and-pinned lives in OPEN, not the grid
    const spaceList = lists[1]!;
    expect(spaceList.textContent).toContain("Delta");
    expect(spaceList.textContent).not.toContain("Gamma"); // pinned items don't also get a SPACE row
    expect(spaceList.textContent).not.toContain("Alpha");
  });

  it("clicking a SPACE row opens it; clicking an OPEN row keeps/re-opens it (both call openItem)", async () => {
    const layout: Layout = { type: "leaf", id: "L1", itemId: "i1" };
    const api = fakeApi({
      spaces: [space("s1", "p1", "Versed", { layout })],
      items: { s1: [item("i1", "s1", { title: "Alpha" }), item("i2", "s1", { title: "Beta" })] },
    });
    const { store } = await mount(api);
    fireEvent.click(screen.getByRole("button", { name: "Beta" })); // SPACE row -> opens it
    await waitFor(() => { const l = store.getState().layout!; expect(l.type === "leaf" && l.itemId).toBe("i2"); });
    fireEvent.click(screen.getByRole("button", { name: "Alpha" })); // now unopened -> click re-opens it
    await waitFor(() => { const l = store.getState().layout!; expect(l.type === "leaf" && l.itemId).toBe("i1"); });
  });

  it("the x on an OPEN row closes it from the layout without deleting it; SPACE rows render no x", async () => {
    const layout: Layout = { type: "leaf", id: "L1", itemId: "i1" };
    const api = fakeApi({
      spaces: [space("s1", "p1", "Versed", { layout })],
      items: { s1: [item("i1", "s1", { title: "Alpha" }), item("i2", "s1", { title: "Beta" })] },
    });
    const { store } = await mount(api);
    expect(screen.getByRole("button", { name: "Beta" }).closest(".item")!.querySelector(".item-close")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close Alpha" }));
    await waitFor(() => { const l = store.getState().layout!; expect(l.type === "leaf" && l.itemId).not.toBe("i1"); });
    expect(api.calls).not.toContain("deleteItem:i1");
    expect(store.getState().items.map((i) => i.id)).toContain("i1"); // still exists, just unopened
  });

  it("context menu: Close only for open items (closes from layout); Delete always (destructive)", async () => {
    const layout: Layout = { type: "leaf", id: "L1", itemId: "i1" };
    const api = fakeApi({
      spaces: [space("s1", "p1", "Versed", { layout })],
      items: { s1: [item("i1", "s1", { title: "Alpha" }), item("i2", "s1", { title: "Beta" })] },
    });
    const { store } = await mount(api);

    fireEvent.contextMenu(screen.getByRole("button", { name: "Alpha" })); // open
    expect(screen.getByRole("menuitem", { name: "Close" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Close" }));
    await waitFor(() => { const l = store.getState().layout!; expect(l.type === "leaf" && l.itemId).not.toBe("i1"); });
    expect(api.calls).not.toContain("deleteItem:i1");
    expect(store.getState().items.map((i) => i.id)).toContain("i1"); // still exists

    fireEvent.contextMenu(screen.getByRole("button", { name: "Beta" })); // unopened
    expect(screen.queryByRole("menuitem", { name: "Close" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Really delete?" }));
    await waitFor(() => expect(store.getState().items.map((i) => i.id)).not.toContain("i2"));
    expect(api.calls).toContain("deleteItem:i2");
  });

  it("THE homing mutant: the row menu's Open here brings the pane INTO the focused leaf", async () => {
    const layout: Layout = { type: "leaf", id: "L1", itemId: "i1" };
    const api = fakeApi({
      spaces: [space("s1", "p1", "Versed", { layout })],
      items: { s1: [item("i1", "s1", { title: "Alpha" })] },
    });
    const { store } = await mount(api);
    await act(async () => { await store.getState().splitFocused("row"); });
    const other = store.getState().focusedLeafId!;
    expect(other).not.toBe("L1");
    fireEvent.contextMenu(screen.getByRole("button", { name: "Alpha" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open here" }));
    await waitFor(() => expect(findLeafOfItem(store.getState().layout!, "i1")!.id).toBe(other));
  });

  it("…and it is absent wherever a plain click would land in the same place anyway", async () => {
    const layout: Layout = { type: "leaf", id: "L1", itemId: "i1" };
    const api = fakeApi({
      spaces: [space("s1", "p1", "Versed", { layout })],
      items: { s1: [item("i1", "s1", { title: "Alpha" }), item("i2", "s1", { title: "Beta" })] },
    });
    await mount(api);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Alpha" })); // open, and its leaf is the focused one
    expect(screen.queryByRole("menuitem", { name: "Open here" })).not.toBeInTheDocument();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Beta" })); // not open at all: a click opens it here
    expect(screen.queryByRole("menuitem", { name: "Open here" })).not.toBeInTheDocument();
  });

  it("Delete on an OPEN item removes it from both the layout and the item list", async () => {
    const layout: Layout = { type: "leaf", id: "L1", itemId: "i1" };
    const api = fakeApi({
      spaces: [space("s1", "p1", "Versed", { layout })],
      items: { s1: [item("i1", "s1", { title: "Alpha" }), item("i2", "s1", { title: "Beta" })] },
    });
    const { store } = await mount(api);

    fireEvent.contextMenu(screen.getByRole("button", { name: "Alpha" })); // i1 is open in L1
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Really delete?" }));
    await waitFor(() => expect(store.getState().items.map((i) => i.id)).not.toContain("i1"));
    expect(api.calls).toContain("deleteItem:i1");
    const l = store.getState().layout!;
    // The leaf no longer points at i1. It isn't empty either: deleting the last open pane lands in a
    // fresh session rather than an empty-state placeholder.
    expect(l.type === "leaf" && l.itemId).not.toBe("i1");
  });

  it("during a row split, OPEN rows draw one bar per slot along the split's axis, lighting their own", async () => {
    const layout: Layout = { type: "split", id: "root", dir: "row", sizes: [50, 50], children: [
      { type: "leaf", id: "L1", itemId: "i1" },
      { type: "leaf", id: "L2", itemId: "i2" },
    ] };
    const api = fakeApi({
      spaces: [space("s1", "p1", "Versed", { layout })],
      items: { s1: [item("i1", "s1", { title: "Alpha" }), item("i2", "s1", { title: "Beta" })] },
    });
    await mount(api);
    // Two slots, two bars — not four cells with a column lit. The glyph draws the split it is
    // describing, so the bar count is the pane count and `data-dir` is the axis CSS lays them along.
    expect(glyphOf("Alpha")).toHaveAttribute("data-dir", "row");
    expect(glyphOf("Alpha").querySelectorAll("span")).toHaveLength(2);
    expect(onCells(glyphOf("Alpha"))).toEqual([0]);
    expect(onCells(glyphOf("Beta"))).toEqual([1]);
  });

  it("during a col split, the same bars run down instead of across", async () => {
    const layout: Layout = { type: "split", id: "root", dir: "col", sizes: [50, 50], children: [
      { type: "leaf", id: "L1", itemId: "i1" },
      { type: "leaf", id: "L2", itemId: "i2" },
    ] };
    const api = fakeApi({
      spaces: [space("s1", "p1", "Versed", { layout })],
      items: { s1: [item("i1", "s1", { title: "Alpha" }), item("i2", "s1", { title: "Beta" })] },
    });
    await mount(api);
    expect(glyphOf("Alpha")).toHaveAttribute("data-dir", "col");
    expect(onCells(glyphOf("Alpha"))).toEqual([0]);
    expect(onCells(glyphOf("Beta"))).toEqual([1]);
  });

  it("a three-column layout gets three bars — the case the old 2x2 could only answer wrongly", async () => {
    // gridPreset("three-col") builds exactly this, and the command palette offers it. The old glyph
    // had no third column to light, so it lit the bottom-left quadrant of a grid with no bottom row.
    const layout: Layout = { type: "split", id: "root", dir: "row", sizes: [34, 33, 33], children: [
      { type: "leaf", id: "L1", itemId: "i1" },
      { type: "leaf", id: "L2", itemId: "i2" },
      { type: "leaf", id: "L3", itemId: "i3" },
    ] };
    const api = fakeApi({
      spaces: [space("s1", "p1", "Versed", { layout })],
      items: { s1: [item("i1", "s1", { title: "Alpha" }), item("i2", "s1", { title: "Beta" }), item("i3", "s1", { title: "Gamma" })] },
    });
    await mount(api);
    expect(glyphOf("Gamma").querySelectorAll("span")).toHaveLength(3);
    expect(onCells(glyphOf("Gamma"))).toEqual([2]);
  });

  it("in a split, data-active marks only the focused leaf's row, not every open row; clicking the other OPEN row moves the highlight", async () => {
    const layout: Layout = { type: "split", id: "root", dir: "row", sizes: [50, 50], children: [
      { type: "leaf", id: "L1", itemId: "i1" },
      { type: "leaf", id: "L2", itemId: "i2" },
    ] };
    const api = fakeApi({
      spaces: [space("s1", "p1", "Versed", { layout })],
      items: { s1: [item("i1", "s1", { title: "Alpha" }), item("i2", "s1", { title: "Beta" })] },
    });
    const { store } = await mount(api);
    // boot() focuses the first leaf (L1 -> Alpha) by default.
    expect(store.getState().focusedLeafId).toBe("L1");
    const rows = () => screen.getAllByRole("button", { name: /^(Alpha|Beta)$/ }).map((b) => b.closest(".item")!);
    expect(rows().filter((r) => r.hasAttribute("data-active"))).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Alpha" }).closest(".item")).toHaveAttribute("data-active");
    expect(screen.getByRole("button", { name: "Beta" }).closest(".item")).not.toHaveAttribute("data-active");
    fireEvent.click(screen.getByRole("button", { name: "Beta" })); // already open -> focuses its pane, no layout move
    await waitFor(() => expect(store.getState().focusedLeafId).toBe("L2"));
    expect(rows().filter((r) => r.hasAttribute("data-active"))).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Beta" }).closest(".item")).toHaveAttribute("data-active");
    expect(screen.getByRole("button", { name: "Alpha" }).closest(".item")).not.toHaveAttribute("data-active");
  });

  it("both OPEN and SPACE rows are draggable, carry the item id via application/x-realm-item on dragstart, and set/clear data-dragging", async () => {
    const layout: Layout = { type: "leaf", id: "L1", itemId: "i1" };
    const api = fakeApi({
      spaces: [space("s1", "p1", "Versed", { layout })],
      items: { s1: [item("i1", "s1", { title: "Alpha" }), item("i2", "s1", { title: "Beta" })] },
    });
    await mount(api);
    const openRow = screen.getByRole("button", { name: "Alpha" }).closest(".item")!; // OPEN row
    const spaceRow = screen.getByRole("button", { name: "Beta" }).closest(".item")!; // SPACE row

    for (const [row, id] of [[openRow, "i1"], [spaceRow, "i2"]] as const) {
      expect(row).toHaveAttribute("draggable", "true");
      const setData = vi.fn();
      fireEvent.dragStart(row, { dataTransfer: { setData, effectAllowed: "", getData: () => "" } });
      expect(setData).toHaveBeenCalledWith("application/x-realm-item", id);
      expect(row).toHaveAttribute("data-dragging");
      fireEvent.dragEnd(row, { dataTransfer: { getData: () => "" } });
      expect(row).not.toHaveAttribute("data-dragging");
    }
  });

  it("dragging one row does not mark a sibling row as dragging", async () => {
    const layout: Layout = { type: "leaf", id: "L1", itemId: "i1" };
    const api = fakeApi({
      spaces: [space("s1", "p1", "Versed", { layout })],
      items: { s1: [item("i1", "s1", { title: "Alpha" }), item("i2", "s1", { title: "Beta" })] },
    });
    await mount(api);
    const openRow = screen.getByRole("button", { name: "Alpha" }).closest(".item")!;
    const spaceRow = screen.getByRole("button", { name: "Beta" }).closest(".item")!;
    fireEvent.dragStart(spaceRow, { dataTransfer: { setData: () => {}, effectAllowed: "", getData: () => "" } });
    expect(spaceRow).toHaveAttribute("data-dragging");
    expect(openRow).not.toHaveAttribute("data-dragging");
  });

  it("a single-leaf layout hides the glyph entirely, even though the item is open", async () => {
    const layout: Layout = { type: "leaf", id: "L1", itemId: "i1" };
    const api = fakeApi({
      spaces: [space("s1", "p1", "Versed", { layout })],
      items: { s1: [item("i1", "s1", { title: "Alpha" })] },
    });
    await mount(api);
    expect(screen.getByRole("button", { name: "Alpha" }).querySelector(".item-glyph")).toBeNull();
  });
});

describe("the list's bottom fade", () => {
  it("is a SIBLING of the scroller, not a child of it", async () => {
    // The one structural fact the stylesheet cannot state: a backdrop-filter nested inside the
    // scrolling box scrolls with the content it is supposed to be blurring, which looks correct at
    // scrollTop 0 and wrong everywhere else. Its height and the padding that clears it are pinned in
    // styles.test.ts; how much it actually blurs, in sidebar-fade-live.mjs.
    await mount();
    const fade = document.querySelector(".space-fade")!;
    expect(fade).not.toBeNull();
    expect(fade.closest(".space-body")).toBeNull();
    expect(fade.previousElementSibling).toHaveClass("space-body");
  });
});

function glyphOf(title: string): Element {
  return screen.getByRole("button", { name: title }).querySelector(".item-glyph")!;
}
function onCells(glyph: Element): number[] {
  return Array.from(glyph.querySelectorAll("span"))
    .map((s, i) => (s.hasAttribute("data-on") ? i : null))
    .filter((x): x is number => x !== null);
}

describe("paneSlotOf", () => {
  const leaf = (id: string, itemId: string | null): Layout => ({ type: "leaf", id, itemId });
  const split = (dir: "row" | "col", children: Layout[]): Layout =>
    ({ type: "split", id: "root", dir, sizes: children.map(() => 100 / children.length), children });

  it("returns null for a single-leaf layout — there is no split to describe", () => {
    expect(paneSlotOf(leaf("L1", "i1"), "i1")).toBeNull();
  });

  it("returns null when the item isn't open anywhere in the tree", () => {
    expect(paneSlotOf(split("row", [leaf("L1", "i1"), leaf("L2", "i2")]), "i3")).toBeNull();
  });

  it("reports the slot, the slot count and the axis of the top-level split", () => {
    const l = split("row", [leaf("L1", "i1"), leaf("L2", "i2")]);
    expect(paneSlotOf(l, "i1")).toEqual({ index: 0, count: 2, dir: "row" });
    expect(paneSlotOf(l, "i2")).toEqual({ index: 1, count: 2, dir: "row" });
  });

  it("counts every slot of a three-way root, so the third pane is the third bar", () => {
    // The behaviour this replaces: depth-first index modulo 4, which answered 2 here and drew that as
    // the bottom-left of a 2x2 — a quadrant of a layout that has one row. The count travels with the
    // index now, so the mark cannot claim a shape the layout does not have.
    const l = split("row", [leaf("L1", "i1"), leaf("L2", "i2"), leaf("L3", "i3")]);
    expect(paneSlotOf(l, "i3")).toEqual({ index: 2, count: 3, dir: "row" });
  });

  it("says nothing at all once the root has more slots than the glyph can draw", () => {
    // Five 2px bars inside 12px is a smudge, and a smudge that looks like a reading is worse than a
    // row with no mark on it. Nothing gridPreset builds reaches this, but a future preset could.
    const l = split("row", Array.from({ length: 5 }, (_, i) => leaf(`L${i}`, `i${i}`)));
    expect(paneSlotOf(l, "i0")).toBeNull();
  });

  it("resolves by which top-level child's SUBTREE holds the item, not by leaf order", () => {
    // "b" lives three levels down the first child, and is still in the first half. A depth-first
    // implementation would see leaves [a, b, d] and answer 1 for "b" — the wrong half.
    const inner = split("col", [leaf("L1", "a"), leaf("L2", "b")]);
    const l = split("row", [inner, leaf("L3", "d")]);
    expect(paneSlotOf(l, "b")).toEqual({ index: 0, count: 2, dir: "row" });
  });
});

describe("item context menu: \"Move to space…\"", () => {
  it("lists every OTHER space as a destination, and moving calls the store action", async () => {
    const { store, api } = await mount(fakeApi({
      items: { s1: [item("i2", "s1", { kind: "session", refId: "se1", title: "Fix the build" })] },
      sessions: [session("se1", "s1")],
    }));
    fireEvent.contextMenu(screen.getByRole("button", { name: /^Fix the build/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to space…" }));
    // The space it's already in never appears as a destination.
    expect(screen.queryByRole("menuitem", { name: "Versed" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Homework" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Homework" }));
    await waitFor(() => expect(api.calls).toContain("moveSessionToSpace:se1=s2"));
    expect(store.getState().sessions.se1?.spaceId).toBe("s2");
  });

  it("is offered for a session that has RUN too — the server carries its checkout across", async () => {
    const { store, api } = await mount(fakeApi({
      items: { s1: [item("i2", "s1", { kind: "session", refId: "se1", title: "Fix the build" })] },
      sessions: [session("se1", "s1", { lastEventSeq: 3 })],
    }));
    fireEvent.contextMenu(screen.getByRole("button", { name: /^Fix the build/ }));
    const entry = screen.getByRole("menuitem", { name: "Move to space…" });
    // The wording is what `lastEventSeq` decides now, not whether the entry exists at all.
    expect(entry).toHaveAttribute("title", expect.stringContaining("checkout along"));
    fireEvent.click(entry);
    fireEvent.click(screen.getByRole("menuitem", { name: "Homework" }));
    await waitFor(() => expect(api.calls).toContain("moveSessionToSpace:se1=s2"));
    expect(store.getState().sessions.se1?.spaceId).toBe("s2");
  });

  it("is absent for non-session items", async () => {
    await mount(fakeApi({ items: { s1: [item("i1", "s1", { title: "Terminal" })] } }));
    fireEvent.contextMenu(screen.getByRole("button", { name: "Terminal" }));
    expect(screen.queryByRole("menuitem", { name: "Move to space…" })).not.toBeInTheDocument();
  });
});

describe("browser driving dot (Plan 11 W4)", () => {
  it("a browser row wears the driving dot ONLY while an act is in flight, and the accessible name says so", async () => {
    const { store } = await mount(fakeApi({ items: { s1: [item("i1", "s1", { kind: "browser", refId: "b1", title: "Stripe docs" })] } }));
    const row = () => screen.getByRole("button", { name: /^Stripe docs/ });
    expect(row().querySelector(".status-dot")).toBeNull();
    act(() => store.getState().applyBrowserDriving({ browserId: "b1", driving: true }));
    expect(row().querySelector(".status-dot")).toHaveAttribute("data-status", "driving");
    expect(row()).toHaveAccessibleName("Stripe docs — agent is driving");
    // Settle clears it — a stuck dot is the named mutant, and the row must shed it entirely.
    act(() => store.getState().applyBrowserDriving({ browserId: "b1", driving: false }));
    expect(row().querySelector(".status-dot")).toBeNull();
    expect(row()).toHaveAccessibleName("Stripe docs");
  });
});

describe("sidebar destinations (Plan 12 W4)", () => {
  it("Library, Connections, Notifications and Settings sit between the New-session block and the space section (W5 filled the seam)", async () => {
    await mount();
    const nav = screen.getByRole("navigation", { name: "Destinations" });
    expect(within(nav).getByRole("button", { name: "Library" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Connections" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: /Notifications/ })).toBeInTheDocument();
    // Settings joined the nav when the space strip's left slot became the profile chip: it is an
    // app-level page like its three neighbours, and it was the one thing in a spaces rail that
    // wasn't a space.
    expect(within(nav).getByRole("button", { name: "Settings" })).toBeInTheDocument();
    expect(within(nav).getAllByRole("button")).toHaveLength(4);
    // No unread pill at zero — a permanent 0 would be the dead chrome this nav bans.
    expect(within(nav).queryByLabelText(/unread/)).toBeNull();
    // Placement: the nav follows the sb-top block (search + New session) and precedes the swiper.
    expect(nav.previousElementSibling).toHaveClass("sb-top");
  });

  it("clicking Library opens ONE library-page item in the active space; a second click focuses it (named mutant: two Library panes)", async () => {
    const { store, api } = await mount();
    // Scoped to the nav: once the page exists, its ITEM row is also titled "Library".
    const nav = screen.getByRole("navigation", { name: "Destinations" });
    fireEvent.click(within(nav).getByRole("button", { name: "Library" }));
    await waitFor(() => expect(store.getState().items.some((i) => i.kind === "library-page")).toBe(true));
    fireEvent.click(within(nav).getByRole("button", { name: "Library" }));
    await waitFor(() => expect(store.getState().items.filter((i) => i.kind === "library-page")).toHaveLength(1));
    expect(api.calls.filter((c) => c.startsWith("createItem:") && c.includes("library-page"))).toHaveLength(1);
  });

  it("THE modifier-ignored mutant: ⌥-clicking a destination row brings its page to the focused pane", async () => {
    const { store } = await mount();
    const nav = screen.getByRole("navigation", { name: "Destinations" });
    const row = () => within(nav).getByRole("button", { name: "Library" });
    // Nothing to choose between yet: the page does not exist, so a plain click already lands here.
    expect(row()).not.toHaveAttribute("title");
    fireEvent.click(row());
    await waitFor(() => expect(store.getState().items.some((i) => i.kind === "library-page")).toBe(true));
    const page = store.getState().items.find((i) => i.kind === "library-page")!;
    const home = store.getState().focusedLeafId!;
    await act(async () => { await store.getState().splitFocused("row"); });
    const other = store.getState().focusedLeafId!;
    expect(other).not.toBe(home);
    // Now the two placements differ, and the row says so before it is used.
    await waitFor(() => expect(row()).toHaveAttribute("title", expect.stringContaining("⌥")));
    fireEvent.click(row(), { altKey: true });
    await waitFor(() => expect(findLeafOfItem(store.getState().layout!, page.id)!.id).toBe(other));
  });

  // Moved off the space strip's left slot, which is the profile chip now. Same contract it had there:
  // the SETTINGS page, not the space page, in the ACTIVE space's layout, as a pane and never a sheet.
  it("clicking Settings opens the settings-page item in the ACTIVE space's layout — not the space page, never a sheet", async () => {
    const { store, api } = await mount();
    await act(async () => { await store.getState().selectSpace("s2"); });
    const nav = screen.getByRole("navigation", { name: "Destinations" });
    fireEvent.click(within(nav).getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(store.getState().items.some((i) => i.kind === "settings-page")).toBe(true));
    const page = store.getState().items.find((i) => i.kind === "settings-page")!;
    expect(JSON.stringify(store.getState().layout)).toContain(page.id);
    expect(store.getState().sheet).toBeNull();
    expect(store.getState().items.find((i) => i.kind === "space-page")).toBeUndefined();
    // The row landed in s2 — the space that was active under the click.
    expect((api.data.items.s2 ?? []).some((i) => i.kind === "settings-page")).toBe(true);
    expect((api.data.items.s1 ?? []).some((i) => i.kind === "settings-page")).toBe(false);
  });

  it("clicking Connections opens the connections-page item", async () => {
    const { store } = await mount();
    const nav = screen.getByRole("navigation", { name: "Destinations" });
    fireEvent.click(within(nav).getByRole("button", { name: "Connections" }));
    await waitFor(() => expect(store.getState().items.some((i) => i.kind === "connections-page")).toBe(true));
  });
});

/** Plan: archiving. The shelf is the sidebar's own gesture — a session row put away without being
 *  deleted — so everything it promises is asserted here: who gets the button, where the row goes,
 *  what happens to its pane, and both ways back. */
describe("archiving a session", () => {
  const sessionAndTerminal = (archived = false) => fakeApi({
    items: { s1: [item("i1", "s1", { title: "Terminal" }),
                  item("i2", "s1", { kind: "session", refId: "se1", title: "Fix the build", archived })] },
    sessions: [session("se1", "s1")],
  });
  const expand = () => fireEvent.click(screen.getByRole("button", { name: "Archived 1" }));
  const openIds = (store: { getState: () => { layout: Layout | null } }) => {
    const l = store.getState().layout;
    return l ? allItems(l) : [];
  };

  it("the hover button rides session rows and no others", async () => {
    await mount(sessionAndTerminal());
    expect(screen.getByRole("button", { name: "Archive Fix the build" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Terminal" }).closest(".item")!.querySelector(".item-shelf")).toBeNull();
  });

  it("archiving moves the row from Space onto a collapsed shelf, deleting nothing", async () => {
    const api = sessionAndTerminal();
    const { store } = await mount(api);
    fireEvent.click(screen.getByRole("button", { name: "Archive Fix the build" }));
    await waitFor(() => expect(store.getState().items.find((i) => i.id === "i2")?.archived).toBe(true));
    // Out of the list the sidebar shows by default...
    expect(screen.queryByRole("button", { name: /^Fix the build/ })).not.toBeInTheDocument();
    // ...but still an item, and never deleted (the named mutant: archiving that calls deleteItem).
    expect(api.calls).not.toContain("deleteItem:i2");
    expect(store.getState().items.map((i) => i.id)).toContain("i2");
    // The shelf appears counting one, and starts closed — a section that unfolded itself would undo
    // the putting-away.
    expect(screen.getByRole("button", { name: "Archived 1" })).toHaveAttribute("aria-expanded", "false");
    expand();
    expect(screen.getByRole("button", { name: /^Fix the build/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unarchive Fix the build" })).toBeInTheDocument();
  });

  it("archiving an OPEN session closes its pane on the way", async () => {
    const layout: Layout = { type: "split", id: "root", dir: "row", sizes: [50, 50], children: [
      { type: "leaf", id: "L1", itemId: "i1" }, { type: "leaf", id: "L2", itemId: "i2" }] };
    const api = fakeApi({
      spaces: [space("s1", "p1", "Versed", { layout })],
      items: { s1: [item("i1", "s1", { title: "Terminal" }),
                    item("i2", "s1", { kind: "session", refId: "se1", title: "Fix the build" })] },
      sessions: [session("se1", "s1")],
    });
    const { store } = await mount(api);
    fireEvent.click(screen.getByRole("button", { name: "Archive Fix the build" }));
    await waitFor(() => expect(openIds(store)).not.toContain("i2"));
    expect(store.getState().items.find((i) => i.id === "i2")?.archived).toBe(true);
    expect(openIds(store)).toContain("i1"); // the pane beside it is untouched
  });

  it("the shelf's own button restores the row without opening it", async () => {
    const { store } = await mount(sessionAndTerminal(true));
    expand();
    fireEvent.click(screen.getByRole("button", { name: "Unarchive Fix the build" }));
    await waitFor(() => expect(store.getState().items.find((i) => i.id === "i2")?.archived).toBe(false));
    // Back in the space list, and the now-empty shelf is gone entirely rather than reading "0".
    expect(screen.getByRole("button", { name: /^Fix the build/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Archived/ })).not.toBeInTheDocument();
    expect(openIds(store)).not.toContain("i2");
  });

  it("clicking an archived row takes it off the shelf on the way to opening it", async () => {
    const { store } = await mount(sessionAndTerminal(true));
    expand();
    fireEvent.click(screen.getByRole("button", { name: /^Fix the build/ }));
    await waitFor(() => expect(openIds(store)).toContain("i2"));
    // The mutant this kills: opening without restoring, which leaves a pane on screen for a row the
    // sidebar files under "Archived".
    expect(store.getState().items.find((i) => i.id === "i2")?.archived).toBe(false);
  });

  it("the context menu carries the same gesture, labelled for the row's current state", async () => {
    const { store } = await mount(sessionAndTerminal());
    // Not offered for the kinds that have no answer for what archiving would mean.
    fireEvent.contextMenu(screen.getByRole("button", { name: "Terminal" }));
    expect(screen.queryByRole("menuitem", { name: "Archive" })).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await exited();

    fireEvent.contextMenu(screen.getByRole("button", { name: /^Fix the build/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    await waitFor(() => expect(store.getState().items.find((i) => i.id === "i2")?.archived).toBe(true));
    expand();
    await exited();
    fireEvent.contextMenu(screen.getByRole("button", { name: /^Fix the build/ }));
    expect(screen.queryByRole("menuitem", { name: "Archive" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Unarchive" }));
    await waitFor(() => expect(store.getState().items.find((i) => i.id === "i2")?.archived).toBe(false));
  });
});
