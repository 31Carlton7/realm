import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { allItems, findLeafOfItem, type Layout, type McpCall } from "@realm/contracts";
import { Sidebar } from "./Sidebar";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, iconAsset, item, session, space } from "../../state/store.test-fakes";
import { paneMapOf } from "./ItemList";
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

  /* The heading is the COLUMN's, not the page's. One per swiper page meant one "Space menu" per
     space, all with the same accessible name and told apart only by `inert` — and it put the space's
     name below the destination rows instead of at the top of its own sidebar. */
  it("heads the column, above New session and outside the swiper", async () => {
    const { container, store } = await mount();
    const header = container.querySelector(".space-header")!;
    expect(header.closest(".sb-top")).not.toBeNull();
    expect(header.closest(".swiper")).toBeNull();
    // The search bar that used to sit between them is a glyph in the header's own actions now.
    expect(header.nextElementSibling).toHaveClass("new-item");
    expect(container.querySelector(".search")).toBeNull();
    expect(screen.getAllByRole("heading")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Space menu" })).toHaveLength(1);
    // It follows the active space rather than holding whichever one it was mounted with.
    fireEvent.click(screen.getByRole("button", { name: /switch to space Homework/i }));
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s2"));
    expect(screen.getByRole("heading", { name: /Homework/ })).toBeInTheDocument();
  });

  /* The feed answers IN the column: it stands where the space's list stands, in the column's own
     rows, and nothing about it is a sheet over the work. The button is the lens, lit while the feed
     is the body and flipping back on a second press. */
  it("gives the column over to the chat feed, from a button beside the collapse toggle", async () => {
    /* The lens mechanism, which did not change when its content did: a lit button, the swiper giving
       up the body, and no sheet. What it shows is now the chats — the gateway log's own behaviour is
       tested against the component in `activity-list.test.tsx`. */
    const { store, container } = await mount(fakeApi({
      sessions: [session("se1", "s1", { title: "Fix the login form", updatedAt: Date.now() })],
    }));
    const button = () => screen.getByRole("button", { name: "Activity" });
    expect(button().closest(".sb-head")).not.toBeNull();
    expect(button().nextElementSibling).toHaveClass("sb-toggle"); // the collapse toggle keeps the edge
    expect(button()).toHaveAttribute("aria-pressed", "false");
    expect(container.querySelector(".swiper")).not.toBeNull();

    fireEvent.click(button());
    await waitFor(() => expect(store.getState().sidebarView).toBe("activity"));
    // No sheet — the whole point of the change. The space's list gives up the body instead.
    expect(store.getState().sheet).toBeNull();
    expect(button()).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(container.querySelector(".sb-chat-row")).not.toBeNull());
    expect(container.querySelector(".swiper")).toBeNull();
    expect(screen.getByText("Fix the login form")).toBeInTheDocument();
    expect(container.querySelector(".sb-activity .group-label")!.textContent).toBe("Today");

    fireEvent.click(button());
    await waitFor(() => expect(store.getState().sidebarView).toBe("space"));
    expect(container.querySelector(".swiper")).not.toBeNull();
  });

  it("says the feed is empty in its own words, inside the column's own inset", async () => {
    const { container } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    const blank = await waitFor(() => {
      const el = container.querySelector(".sb-activity-empty");
      if (!el) throw new Error("not yet");
      return el;
    });
    expect(blank.textContent).toContain("No chats yet");
    expect(container.querySelectorAll(".sb-activity .item-row")).toHaveLength(0);
    // The inset is the page's, declared on the feed rather than inherited from a page it is not in.
    expect(container.querySelector(".sb-activity")).toHaveClass("sb-activity-blank");
  });

  /* The full-width "Search… ⌘K" button is gone: it was a control the height of a field standing in
     for a palette one keystroke away, and it cost the column a row of its own height. What has to
     survive the swap is the CLICK — the palette is not reachable any other way with a pointer — and
     the shortcut, which moves to the tooltip where a hint that never changes belongs. */
  it("opens the palette from a glyph in the header's actions, shortcut on the tooltip", async () => {
    const { store, container } = await mount();
    const button = screen.getByRole("button", { name: "Search" });
    expect(button.closest(".space-header-actions")).not.toBeNull();
    expect(button).toHaveAttribute("title", "Search (⌘K)");
    expect(container.querySelector(".sb-top .search")).toBeNull();
    fireEvent.click(button);
    await waitFor(() => expect(store.getState().paletteOpen).toBe(true));
  });

  /* The feed was a destination row with a count pill — a permanent line of the nav for something
     usually at zero. It is a button in the head row now, beside the activity log: both are
     app-level, both are "is this up", and neither is a place in this space. */
  it("opens the notifications page from the head row's bell, and closes it again", async () => {
    const { store, container } = await mount();
    const bell = () => screen.getByRole("button", { name: "Notifications" });
    expect(bell().closest(".sb-head")).not.toBeNull();
    expect(bell().nextElementSibling).toHaveAccessibleName("Activity");
    // …and it is not ALSO a row in the nav, which is the state a half-done move leaves behind.
    expect(within(container.querySelector<HTMLElement>(".sb-destinations")!).queryByRole("button", { name: /Notifications/ })).toBeNull();
    expect(bell()).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(bell());
    await waitFor(() => expect(store.getState().pageOverlay?.kind).toBe("notifications-page"));
    expect(bell()).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(bell());
    await waitFor(() => expect(store.getState().pageOverlay).toBeNull());
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
    await waitFor(() => expect((store.getState().pageOverlay?.kind === "profile-page")).toBe(true));
    expect((store.getState().pageOverlay?.kind === "space-page")).toBe(false);
    expect(store.getState().sheet).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New space" }));
    expect(store.getState().sheet).toEqual({ kind: "new-space" });
  });

  it("the header title row itself opens the space PAGE (the transcription's front door)", async () => {
    const { store } = await mount();
    const layout = JSON.stringify(store.getState().layout);
    fireEvent.click(screen.getByRole("button", { name: "Versed" }));
    await waitFor(() => expect(store.getState().pageOverlay).toEqual({ kind: "space-page", refId: "s1", spaceId: "s1" }));
    // Over the workspace, not in it: the layout the user arranged is untouched.
    expect(JSON.stringify(store.getState().layout)).toBe(layout);
  });

  it("the space menu's Open space opens the page — the sheet's ⋯ entry point did not go dead", async () => {
    const { store } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Space menu" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open space" }));
    await waitFor(() => expect(store.getState().pageOverlay?.kind).toBe("space-page"));
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
    // Two panes side by side, drawn as two rects splitting the box across.
    expect(panesOf(glyphOf("Alpha"))).toEqual(["1,1,11,23", "13,1,11,23"]);
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
    // The same two rects, stacked instead of side by side — the axis is in the geometry now.
    expect(panesOf(glyphOf("Alpha"))).toEqual(["1,1,23,11", "1,13,23,11"]);
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
    expect(glyphOf("Gamma").querySelectorAll("rect")).toHaveLength(3);
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
  it("is nothing but the scroller — no band element sits beside or inside it", async () => {
    // The dissolve is a mask on .space-body (pinned in styles.test.ts; seen on screen in
    // sidebar-fade-live.mjs). The named mutant is the old `.space-fade` sibling coming back: a
    // backdrop-filter band over this translucent column blurs the window's own transparency and
    // renders as a dark smudge above the space strip.
    await mount();
    expect(document.querySelector(".space-body")).not.toBeNull();
    expect(document.querySelector(".space-fade")).toBeNull();
  });
});

function glyphOf(title: string): Element {
  return screen.getByRole("button", { name: title }).querySelector(".item-glyph")!;
}
function onCells(glyph: Element): number[] {
  return Array.from(glyph.querySelectorAll("rect"))
    .map((s, i) => (s.hasAttribute("data-on") ? i : null))
    .filter((x): x is number => x !== null);
}
/** `x,y,w,h` of each pane in the glyph, rounded — the geometry the reader actually sees. */
function panesOf(glyph: Element): string[] {
  return Array.from(glyph.querySelectorAll("rect")).map((r) =>
    ["x", "y", "width", "height"].map((a) => Math.round(Number(r.getAttribute(a)))).join(","));
}

describe("paneMapOf — the arrangement itself, not a category of arrangement", () => {
  const leaf = (id: string, itemId: string | null): Layout => ({ type: "leaf", id, itemId });
  const split = (dir: "row" | "col", children: Layout[], sizes?: number[]): Layout =>
    ({ type: "split", id: `s${dir}`, dir, sizes: sizes ?? children.map(() => 100 / children.length), children });
  /** Rects rounded, so a test reads as geometry rather than as floating point. */
  const boxes = (l: Layout, id: string) =>
    paneMapOf(l, id)?.map((r) => [r.x, r.y, r.w, r.h, r.active] as const)
      .map(([x, y, w, h, a]) => [+x.toFixed(3), +y.toFixed(3), +w.toFixed(3), +h.toFixed(3), a]);

  it("draws a plain split as two halves, with this item's half lit", () => {
    expect(boxes(split("row", [leaf("L1", "i1"), leaf("L2", "i2")]), "i1")).toEqual([
      [0, 0, 0.5, 1, true],
      [0.5, 0, 0.5, 1, false],
    ]);
  });

  it("uses the layout's REAL proportions, so a dragged splitter shows as a dragged splitter", () => {
    // THE mutant: divide the box equally and ignore `sizes`. Every layout then draws as the tidy
    // version of itself, and the glyph stops being a picture of this window.
    expect(boxes(split("row", [leaf("L1", "i1"), leaf("L2", "i2")], [75, 25]), "i1")).toEqual([
      [0, 0, 0.75, 1, true],
      [0.75, 0, 0.25, 1, false],
    ]);
  });

  it("keeps two panes stacked inside one column apart", () => {
    // The failure the glyph exists to prevent: a mark that cannot distinguish two rows is not a
    // smaller answer, it is the wrong one.
    const l = split("row", [leaf("L1", "i1"), split("col", [leaf("L2", "i2"), leaf("L3", "i3")])]);
    expect(boxes(l, "i2")).toEqual([
      [0, 0, 0.5, 1, false],
      [0.5, 0, 0.5, 0.5, true],
      [0.5, 0.5, 0.5, 0.5, false],
    ]);
    expect(boxes(l, "i3")![2]![4]).toBe(true);
  });

  it("draws a layout that is not a rectangular grid, exactly — the case a grid could not hold", () => {
    // Two columns; the left split into two rows; the lower-left row split again into two columns.
    // No grid of any size has a cell for this, which is why both earlier glyphs had to approximate.
    const l = split("row", [
      split("col", [leaf("A", "a"), split("row", [leaf("B", "b"), leaf("C", "c")])]),
      leaf("D", "d"),
    ]);
    expect(boxes(l, "c")).toEqual([
      [0, 0, 0.5, 0.5, false],      // a — top left
      [0, 0.5, 0.25, 0.5, false],   // b — bottom left, left half
      [0.25, 0.5, 0.25, 0.5, true], // c — bottom left, right half
      [0.5, 0, 0.5, 1, false],      // d — the whole right column
    ]);
  });

  it("has no slot limit — a five-way split draws five panes", () => {
    // The old glyph refused past four, because four bars was all a strip could carry. Rects have no
    // such ceiling: they just get narrower, which is what the window did too.
    const five = split("row", ["a", "b", "c", "d", "e"].map((x, i) => leaf(`W${i}`, x)));
    expect(paneMapOf(five, "d")).toHaveLength(5);
    expect(paneMapOf(five, "d")!.map((r) => r.active)).toEqual([false, false, false, true, false]);
  });

  it("draws an EMPTY pane too — leaving it out would move every rect beside it", () => {
    const l = split("row", [leaf("L1", "i1"), leaf("L2", null)]);
    expect(boxes(l, "i1")).toEqual([[0, 0, 0.5, 1, true], [0.5, 0, 0.5, 1, false]]);
  });

  it("falls back to equal shares when the stored sizes are unusable", () => {
    // An older build's tree, or one caught mid-drag. The STRUCTURE is the half that matters most for
    // telling two panes apart, so it survives proportions that do not.
    expect(boxes(split("row", [leaf("L1", "i1"), leaf("L2", "i2")], [0, 0]), "i1"))
      .toEqual([[0, 0, 0.5, 1, true], [0.5, 0, 0.5, 1, false]]);
  });

  it("says nothing when there is nothing true to say", () => {
    expect(paneMapOf(leaf("L1", "i1"), "i1")).toBeNull();       // one pane is not an arrangement
    expect(paneMapOf(split("row", [leaf("L1", "i1"), leaf("L2", "i2")]), "gone")).toBeNull();
  });
});

describe("the space switcher", () => {
  /* A second door to the same place the strip at the foot of the column already is — but next to the
     NAME, which is where you look when the question is "which space am I in". The strip answers a
     different question ("which others are there") and answers it without naming them. */
  const two = () => fakeApi({
    spaces: [space("s1", "p1", "Versed"), space("s2", "p1", "Ledger")],
  });

  it("does not steal the title's click — that still opens the space page", async () => {
    // The title has opened the page since Plan 12. Turning it into a switcher would move a door
    // somebody already knows where to find, which is why the caret is its own control.
    await mount(two());
    // Named by its content, which is the space's own name — `title` is a tooltip, not a name.
    const title = document.querySelector(".space-title") as HTMLButtonElement;
    expect(title.textContent).toContain("Versed");
    expect(title.getAttribute("aria-haspopup")).toBe(null);
    expect(screen.getByRole("button", { name: "Switch space" })).not.toBe(title);
  });

  it("lists every space, with its own icon and a check on the one you are in", async () => {
    await mount(two());
    fireEvent.click(screen.getByRole("button", { name: "Switch space" }));
    const menu = await screen.findByRole("menu", { name: "Spaces" });
    const rows = within(menu).getAllByRole("menuitemcheckbox");
    expect(rows.map((r) => r.textContent)).toEqual(["Versed", "Ledger"]);
    // The icon slot is what makes a space recognisable at a glance; without it this is a list of
    // words that happen to be space names.
    expect(rows[0]!.querySelector("svg")).not.toBeNull();
    expect(rows.filter((r) => r.getAttribute("aria-checked") === "true").map((r) => r.textContent)).toEqual(["Versed"]);
  });

  it("switches on select", async () => {
    const { store } = await mount(two());
    fireEvent.click(screen.getByRole("button", { name: "Switch space" }));
    const menu = await screen.findByRole("menu", { name: "Spaces" });
    await act(async () => { fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: /Ledger/ })); });
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s2"));
  });

  it("picking the space you are already in does nothing at all", async () => {
    /* `selectSpace` refetches the whole item list. Doing that to land where you already are is a
       flash of an empty column for no reason — the mutant is dropping the guard. */
    const { store, api } = await mount(two());
    const before = api.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Switch space" }));
    const menu = await screen.findByRole("menu", { name: "Spaces" });
    await act(async () => { fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: /Versed/ })); });
    expect(store.getState().activeSpaceId).toBe("s1");
    expect(api.calls.length).toBe(before);
  });
});
