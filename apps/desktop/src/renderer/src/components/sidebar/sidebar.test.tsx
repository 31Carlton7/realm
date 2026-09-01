import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import type { Layout } from "@realm/contracts";
import { Sidebar } from "./Sidebar";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, space } from "../../state/store.test-fakes";
import { leafPositionOf } from "./ItemList";

async function mount(api = fakeApi()) {
  const store = createAppStore(api); await store.getState().boot();
  const r = render(<StoreContext.Provider value={store}><Sidebar /></StoreContext.Provider>);
  return { store, api, ...r };
}

describe("Arc sidebar", () => {
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
      expect(track(container).style.transition).toContain("transform 380ms");
    });
  });

  it("right-click on an item offers Pin, which moves it to the pinned grid; Delete removes it permanently", async () => {
    const { store, api } = await mount();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Terminal" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Terminal/ })).toHaveAttribute("data-tile", "true"));
    expect(store.getState().items[0]?.pinned).toBe(true);
    // i1 is unopened (default layout is null), so Close should not even be offered here.
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

  it("the profile pill opens the space PAGE and + opens the new-space sheet", async () => {
    const { store } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Work" }));
    await waitFor(() => expect(store.getState().items.some((i) => i.kind === "space-page" && i.refId === "s1")).toBe(true));
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

  it("during a row split, OPEN rows render the quadrant glyph lighting the correct column", async () => {
    const layout: Layout = { type: "split", id: "root", dir: "row", sizes: [50, 50], children: [
      { type: "leaf", id: "L1", itemId: "i1" },
      { type: "leaf", id: "L2", itemId: "i2" },
    ] };
    const api = fakeApi({
      spaces: [space("s1", "p1", "Versed", { layout })],
      items: { s1: [item("i1", "s1", { title: "Alpha" }), item("i2", "s1", { title: "Beta" })] },
    });
    await mount(api);
    expect(onCells(glyphOf("Alpha"))).toEqual([0, 2]); // left child -> left column
    expect(onCells(glyphOf("Beta"))).toEqual([1, 3]); // right child -> right column
  });

  it("during a col split, OPEN rows render the quadrant glyph lighting the correct row", async () => {
    const layout: Layout = { type: "split", id: "root", dir: "col", sizes: [50, 50], children: [
      { type: "leaf", id: "L1", itemId: "i1" },
      { type: "leaf", id: "L2", itemId: "i2" },
    ] };
    const api = fakeApi({
      spaces: [space("s1", "p1", "Versed", { layout })],
      items: { s1: [item("i1", "s1", { title: "Alpha" }), item("i2", "s1", { title: "Beta" })] },
    });
    await mount(api);
    expect(onCells(glyphOf("Alpha"))).toEqual([0, 1]); // top child -> top row
    expect(onCells(glyphOf("Beta"))).toEqual([2, 3]); // bottom child -> bottom row
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

function glyphOf(title: string): Element {
  return screen.getByRole("button", { name: title }).querySelector(".item-glyph")!;
}
function onCells(glyph: Element): number[] {
  return Array.from(glyph.querySelectorAll("span"))
    .map((s, i) => (s.hasAttribute("data-on") ? i : null))
    .filter((x): x is number => x !== null);
}

describe("leafPositionOf", () => {
  const leaf = (id: string, itemId: string | null): Layout => ({ type: "leaf", id, itemId });
  const split = (dir: "row" | "col", children: Layout[]): Layout =>
    ({ type: "split", id: "root", dir, sizes: children.map(() => 100 / children.length), children });

  it("returns null for a single-leaf layout (no split at all)", () => {
    expect(leafPositionOf(leaf("L1", "i1"), "i1")).toBeNull();
  });

  it("returns null when the item isn't open anywhere in the tree", () => {
    expect(leafPositionOf(split("row", [leaf("L1", "i1"), leaf("L2", "i2")]), "i3")).toBeNull();
  });

  it("returns the child index (0/1) for a two-way split root", () => {
    const l = split("row", [leaf("L1", "i1"), leaf("L2", "i2")]);
    expect(leafPositionOf(l, "i1")).toBe(0);
    expect(leafPositionOf(l, "i2")).toBe(1);
  });

  it("falls back to depth-first leaf index modulo 4 for a root with more than two children", () => {
    const l = split("row", [leaf("L1", "i1"), leaf("L2", "i2"), leaf("L3", "i3")]);
    expect(leafPositionOf(l, "i1")).toBe(0);
    expect(leafPositionOf(l, "i2")).toBe(1);
    expect(leafPositionOf(l, "i3")).toBe(2);
  });

  it("a >2-child root with a nested split still takes the DF fallback, not the two-way branch", () => {
    // root has 3 children (not two-way), so the two-way branch never applies here even though one of
    // those children is itself a two-way split. DF leaf order is a, b, c, d — "c" is index 2.
    const l = split("row", [leaf("L1", "a"), split("col", [leaf("L2", "b"), leaf("L3", "c")]), leaf("L4", "d")]);
    expect(leafPositionOf(l, "c")).toBe(2);
  });

  it("a two-way root resolves by which top-level child's subtree holds the item, not DF order (the documented contract)", () => {
    // The root IS two-way, so the two-way branch applies: "b" lives inside child 0's subtree -> 0.
    // A DF-fallback implementation would instead see leaves [a, b, d] and answer 1 for "b" — wrong.
    const inner = split("col", [leaf("L1", "a"), leaf("L2", "b")]);
    const l = split("row", [inner, leaf("L3", "d")]);
    expect(leafPositionOf(l, "b")).toBe(0);
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
