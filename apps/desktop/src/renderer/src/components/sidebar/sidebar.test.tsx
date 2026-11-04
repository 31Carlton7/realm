import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act, within, cleanup } from "@testing-library/react";
import { allItems, findLeafOfItem, type Item, type Layout, type Session } from "@realm/contracts";
import { spaceColor } from "@realm/ui";
import { Sidebar } from "./Sidebar";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, iconAsset, item, profile, session, space, type FakeData } from "../../state/store.test-fakes";
import { layoutOnScreen, paneMapOf } from "./ItemList";
import { ALL_ITEMS_SETTLE_MS } from "./use-sidebar-model";
import { exited } from "../popover-exit.test-fakes";

/**
 * The sidebar's list (Plan 27): the profile's spaces as sections of one list, the profile's pinned
 * items, New space at the end — sessions only, from every space at once. Every test names the
 * one-line change that would make it fail.
 */

async function mount(over: FakeData | ReturnType<typeof fakeApi> = {}) {
  const api = "calls" in over ? over : fakeApi(over as FakeData);
  const store = createAppStore(api); await store.getState().boot();
  const r = render(<StoreContext.Provider value={store}><Sidebar /></StoreContext.Provider>);
  // Every space's rows come from `items.listAll`, read when the sidebar mounts.
  await waitFor(() => expect(api.calls).toContain("listAllItems"));
  return { store, api, ...r };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const sessionItem = (id: string, spaceId: string, title: string, extra: Partial<Item> = {}) =>
  item(`i-${id}`, spaceId, { kind: "session", refId: id, title, ...extra });

/** Work holds Versed (the room on screen: a terminal and "Alpha") and Homework ("Wants a yes",
 *  waiting on you); School holds Lectures ("Notes"). */
const home = (over: FakeData = {}): FakeData => ({
  profiles: [profile("p1", "Work"), profile("p2", "School")],
  spaces: [space("s1", "p1", "Versed", { color: "#7c6cff" }), space("s2", "p1", "Homework", { color: "#3ddc97" }), space("s3", "p2", "Lectures")],
  items: {
    s1: [item("i-term", "s1", { kind: "terminal", title: "Terminal" }), sessionItem("a", "s1", "Alpha")],
    s2: [sessionItem("b", "s2", "Wants a yes")],
    s3: [sessionItem("c", "s3", "Notes")],
  },
  sessions: [session("a", "s1", { title: "Alpha" }), session("b", "s2", { title: "Wants a yes", status: "waiting_permission" }), session("c", "s3", { title: "Notes" })],
  ...over,
});

const section = (name: string) => screen.getByRole("region", { name });
const rowsIn = (name: string) => [...section(name).querySelectorAll(".item-title")].map((t) => t.textContent);

describe("a lead whose sub-agents need you", () => {
  it("says how many on its row and opens its Agents tab on the one that has waited longest", async () => {
    // THE MUTANTS: no count on the row; a click that opens the lead and not the card the request is on.
    const kid = (id: string, at: number) => session(id, "s1", { title: `Kid ${id}`, status: "waiting_permission", updatedAt: at, dispatchedBy: { kind: "agent_run", sessionId: "a" } });
    const { store } = await mount(home({
      items: { ...home().items, s1: [...home().items!.s1!, sessionItem("k1", "s1", "Kid k1"), sessionItem("k2", "s1", "Kid k2")] },
      sessions: [...home().sessions!, kid("k1", 20), kid("k2", 10)],
    }));
    const row = await screen.findByRole("button", { name: /^Alpha, 2 sub-agents need you/ });
    expect(row.querySelector(".item-count")).toHaveTextContent("2");
    // Their requests are on the lead's row, not rows of their own at the top.
    expect(screen.queryByRole("button", { name: /^Kid k\d/ })).toBeNull();
    fireEvent.click(row);
    await waitFor(() => expect(store.getState().agentsShown["a"]).toBe("k2"));
  });
});

describe("the list", () => {
  it("is one space at a time: the space in front, under its name, and none of the others", async () => {
    // THE MUTANT: every space of the profile stacked as sections again.
    const { container } = await mount(home());
    const body = container.querySelector(".space-body")!;
    expect([...body.querySelectorAll(".sb-section")].map((s) => s.getAttribute("aria-label"))).toEqual(["Versed"]);
    expect(screen.getByRole("heading", { name: "Versed" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Homework" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Lectures" })).toBeNull();
    // What left the sidebar, by name.
    expect(container.querySelector(".space-strip, .swiper, .space-page, .sb-section-head, .sb-profile")).toBeNull();
    for (const gone of [/^Open$/, /^Other spaces$/, /^Archived$/]) expect(within(body as HTMLElement).queryByText(gone)).toBeNull();
    expect(screen.queryByRole("button", { name: /New split/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Switch to space/ })).toBeNull();
  });

  it("changes with the space: making another space current puts its sessions and its name in the column", async () => {
    // THE MUTANT: a column that reads a space of its own instead of the current one.
    const { store } = await mount(home());
    expect(rowsIn("Versed")).toEqual(["Alpha"]);
    await act(async () => { await store.getState().selectSpace("s2"); });
    await waitFor(() => expect(rowsIn("Homework")).toEqual(["Wants a yes"]));
    expect(screen.getByRole("heading", { name: "Homework" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Versed" })).toBeNull();
  });

  it("hydrates saved custom space icons before the title draws them", async () => {
    const asset = iconAsset("ia-saved", "p1");
    const api = fakeApi({ spaces: [space("s1", "p1", "Versed", { icon: `asset:${asset.id}` })], iconAssets: { p1: [asset] } });
    const { container } = await mount(api);
    expect(api.calls).toContain("listIconAssets:p1");
    expect(container.querySelector(".sb-space-title .sb-space-icon circle")).not.toBeNull();
  });

  it("carries its own shade, outside the slide, so it is the column's width on every frame and leaves with it", async () => {
    // The column casts it over the rail (styles.css, `.sidebar-shade`), reading the column's own
    // `--sidebar-open`. THE MUTANTS: the shade drawn by the rail or the panes, which cannot read that
    // number and would stand still beside a column folding away — or put on the slide, which travels.
    const { container } = await mount(home());
    const shade = container.querySelector(".sidebar-shade")!;
    expect(shade.parentElement).toBe(document.getElementById("app-sidebar"));
    expect(shade.closest(".sidebar-slide")).toBeNull();
    expect(shade).toHaveAttribute("aria-hidden", "true");
    expect(shade.childNodes).toHaveLength(0);
  });
});

describe("the column's title", () => {
  const more = () => screen.getByRole("button", { name: "More for Versed" });
  const open = async () => {
    fireEvent.click(more());
    return within(await screen.findByRole("menu", { name: "Versed" }));
  };

  it("is the space's name in its colour — a plain title, with no chevron and nothing to switch", async () => {
    // THE MUTANTS: the profile switcher back at the head; the title a button that opens a list of spaces.
    const { container } = await mount(home());
    const title = screen.getByRole("heading", { name: "Versed" });
    expect(title.closest("button")).toBeNull();
    const head = container.querySelector(".sb-title")!;
    expect(head.querySelector(".sb-space-icon")!.getAttribute("style")).toContain(hexToRgb(spaceColor("#7c6cff", "light")));
    expect([...head.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual(["More for Versed"]);
    expect(head.querySelector("[data-icon='chevronDown'], .sb-caret")).toBeNull();
  });

  it("opens its space's own pages from the ···", async () => {
    const { store } = await mount(home());
    fireEvent.click((await open()).getByRole("menuitem", { name: "Connections" }));
    await waitFor(() => expect(store.getState().pageOverlay).toMatchObject({ kind: "space-page", refId: "s1" }));
    expect(store.getState().spacePageTab.s1).toBe("connections");
    for (const [name, tab] of [["Memory", "memory"], ["Archived sessions", "sessions"], ["Space settings", "general"], ["Delete space…", "general"]] as const) {
      await exited();
      act(() => store.getState().closePageOverlay());
      fireEvent.click((await open()).getByRole("menuitem", { name }));
      await waitFor(() => expect(store.getState().spacePageTab.s1).toBe(tab));
      if (name === "Archived sessions") expect(store.getState().spaceSessionsView.s1).toBe("archived");
    }
    // Show in Finder is offered only where the desktop bridge can reveal a folder.
    await exited();
    act(() => store.getState().closePageOverlay());
    expect((await open()).queryByRole("menuitem", { name: "Show in Finder" })).toBeNull();
  });

  it("makes a new session, a teammate and the activity view from the ···", async () => {
    const { api, store } = await mount(home());
    fireEvent.click((await open()).getByRole("menuitem", { name: "New session" }));
    await waitFor(() => expect(api.calls).toContain("createSession:claude"));
    expect(api.data.sessions.at(-1)!.spaceId).toBe("s1");
    await exited();
    fireEvent.click((await open()).getByRole("menuitem", { name: "Add a teammate…" }));
    await waitFor(() => expect(store.getState().sheet).toEqual({ kind: "teammate", spaceId: "s1" }));
    act(() => store.getState().closeSheet());
    await exited();
    fireEvent.click((await open()).getByRole("menuitem", { name: "All sessions by time" }));
    await waitFor(() => expect(store.getState().sidebarLens).toBe("recent"));
  });

  it("renames its space in place from the ···, committing on Enter and keeping the name on Escape", async () => {
    // THE MUTANT: Rename that opens the settings page, or a field that writes on Escape.
    const { api } = await mount(home());
    fireEvent.click((await open()).getByRole("menuitem", { name: "Rename…" }));
    const input = await screen.findByRole("textbox", { name: "Rename Versed" });
    fireEvent.change(input, { target: { value: "Gone" } });
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Versed" })).toBeInTheDocument());
    expect(api.calls.some((c) => c.startsWith("updateSpace:"))).toBe(false);
    await exited();
    fireEvent.click((await open()).getByRole("menuitem", { name: "Rename…" }));
    const again = await screen.findByRole("textbox", { name: "Rename Versed" });
    fireEvent.change(again, { target: { value: "Versed app" } });
    fireEvent.keyDown(again, { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Versed app" })).toBeInTheDocument());
    expect(api.data.spaces.find((sp) => sp.id === "s1")!.name).toBe("Versed app");
  });

  it("reveals its folder in the Finder where the bridge can", async () => {
    const reveal = vi.fn(async () => true);
    vi.stubGlobal("realm", { files: { reveal } });
    await mount(home({ spaces: [space("s1", "p1", "Versed", { folderPath: "/work/versed" }), space("s2", "p1", "Homework")] }));
    fireEvent.click((await open()).getByRole("menuitem", { name: "Show in Finder" }));
    expect(reveal).toHaveBeenCalledWith("/work/versed");
  });

  it("asks for a session in a fresh worktree of its space from the ··· — a name and a branch to start from", async () => {
    const { api, store } = await mount(home({ gitInfo: { "/tmp": { branch: "main", additions: 0, deletions: 0, dirty: 0, ahead: 0, behind: 0 } },
      branches: { s1: { branches: ["main"], current: "main" } } }));
    fireEvent.click((await open()).getByRole("menuitem", { name: "New session in a worktree…" }));
    await waitFor(() => expect(store.getState().sheet).toEqual({ kind: "new-worktree", spaceId: "s1" }));
    expect(api.calls).toContain("listBranches:s1");
    await exited();
    act(() => store.getState().closeSheet());
    fireEvent.click((await open()).getByRole("menuitem", { name: "Worktrees" }));
    await waitFor(() => expect(store.getState().spacePageTab.s1).toBe("worktrees"));
  });

  it("offers no session in a worktree from the ··· of a space that is a plain folder", async () => {
    const { store } = await mount(home({ spaces: [space("s1", "p1", "Versed", { folderPath: "/work/versed" }), space("s2", "p1", "Homework")] }));
    await act(async () => { await store.getState().refreshGitInfo("/work/versed"); });
    const menu = await open();
    expect(menu.queryByRole("menuitem", { name: /New session in a worktree/ })).toBeNull();
    expect(menu.queryByRole("menuitem", { name: "Worktrees" })).toBeNull();
    expect(menu.getByRole("menuitem", { name: "Space settings" })).toBeInTheDocument();
  });

  it("opens the ···'s own menu at the pointer on a right-click of the title", async () => {
    // THE MUTANTS: no context menu on the title; a second, shorter menu; the menu still under the ···.
    const { store } = await mount(home());
    const fromDots = [...(await open()).getAllByRole("menuitem")].map((b) => b.textContent);
    fireEvent.keyDown(screen.getByRole("menu", { name: "Versed" }), { key: "Escape" });
    await exited();
    fireEvent.contextMenu(screen.getByRole("heading", { name: "Versed" }), { clientX: 120, clientY: 340 });
    const menu = await screen.findByRole("menu", { name: "Versed" });
    expect([...within(menu).getAllByRole("menuitem")].map((b) => b.textContent)).toEqual(fromDots);
    expect(menu.style.left).toBe("120px");
    expect(menu.style.top).toBe("340px");
    expect(more()).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Memory" }));
    await waitFor(() => expect(store.getState().spacePageTab.s1).toBe("memory"));
  });

  it("opens under the ··· when the context menu comes from the keyboard", async () => {
    await mount(home());
    more().getBoundingClientRect = () => ({ x: 200, y: 300, left: 200, top: 300, right: 220, bottom: 320, width: 20, height: 20, toJSON: () => ({}) });
    // A keyboard context menu carries no pointer: 0,0 is not where anyone asked for it.
    fireEvent.contextMenu(screen.getByRole("heading", { name: "Versed" }), { clientX: 0, clientY: 0 });
    const menu = await screen.findByRole("menu", { name: "Versed" });
    expect(menu.style.top).toBe("324px");
  });
});

describe("the space's sessions", () => {
  it("lists them newest first, five of them, then Show more opens the space's page", async () => {
    const many = Array.from({ length: 7 }, (_, i) => session(`m${i}`, "s1", { title: `Task ${i}`, activityAt: 1000 + i }));
    const { store } = await mount(home({
      items: { s1: many.map((m) => sessionItem(m.id, "s1", m.title)), s2: [] },
      sessions: many,
    }));
    await waitFor(() => expect(rowsIn("Versed")).toEqual(["Task 6", "Task 5", "Task 4", "Task 3", "Task 2"]));
    const showMore = within(section("Versed")).getByRole("button", { name: /Show more/ });
    expect(showMore).toHaveTextContent("Show more 2");
    act(() => store.getState().setSpaceSessionsView("s1", "archived"));
    fireEvent.click(showMore);
    await waitFor(() => expect(store.getState().pageOverlay).toMatchObject({ kind: "space-page", refId: "s1" }));
    expect(store.getState().spacePageTab.s1).toBe("sessions");
    expect(store.getState().spaceSessionsView.s1).toBe("active");
  });

  it("offers a new session in an empty space as its one row", async () => {
    const { api, store } = await mount(home({ items: { s1: [], s2: [] }, sessions: [] }));
    fireEvent.click(within(section("Versed")).getByRole("button", { name: "New session" }));
    await waitFor(() => expect(api.calls).toContain("createSession:claude"));
    expect(store.getState().activeSpaceId).toBe("s1");
  });
});

describe("a session's row", () => {
  it("opens its session", async () => {
    const { store } = await mount(home());
    fireEvent.click(await within(section("Versed")).findByRole("button", { name: /^Alpha/ }));
    await waitFor(() => expect(allItems(store.getState().layout!)).toContain("i-a"));
  });

  it("wears its state at the far end, and says it in its name (A-L4)", async () => {
    const { store } = await mount(home());
    const row = () => within(section("Versed")).getByRole("button", { name: /^Alpha/ });
    await waitFor(() => expect(row()).toHaveAccessibleName("Alpha"));
    expect(row().querySelector(".status-dot")).toBeNull(); // idle wears nothing
    act(() => store.getState().applySessionStatus("a", "waiting_permission"));
    expect(row().querySelector(".item-trail .status-dot")).toHaveAttribute("data-status", "waiting_permission");
    expect(row()).toHaveAccessibleName("Alpha — needs permission");
    act(() => store.getState().applySessionStatus("a", "idle"));
    expect(row().querySelector(".status-dot")).toBeNull();
  });

  it("wears the unread ring when something new happened, and a running dot instead while it works", async () => {
    // THE MUTANT this kills is the one once shipped: a dot for every status, idle included — the ring
    // only draws on a row with no other mark, so it could never appear.
    const { store } = await mount(home({ sessions: [session("a", "s1", { title: "Alpha", seenSeq: 3, lastEventSeq: 5 }), session("b", "s2", { title: "Wants a yes" })] }));
    const row = () => within(section("Versed")).getByRole("button", { name: /^Alpha/ });
    await waitFor(() => expect(row().querySelector(".status-dot")).toHaveAttribute("data-status", "unseen"));
    expect(row()).toHaveAccessibleName("Alpha — new since you were here");
    act(() => store.getState().applySessionStatus("a", "running"));
    expect(row().querySelectorAll(".status-dot")).toHaveLength(1);
    expect(row().querySelector(".status-dot")).toHaveAttribute("data-status", "running");
  });

  it("lifts an unread row's title, and only while unread is the mark it wears", async () => {
    // THE MUTANT: `data-unread` keyed on `row.unread` alone — a running session that also has news
    // would wear a heavy title beside a green dot, two marks asking to be told apart.
    const { store } = await mount(home({ sessions: [session("a", "s1", { title: "Alpha", seenSeq: 3, lastEventSeq: 5 }), session("b", "s2", { title: "Wants a yes", seenSeq: 4, lastEventSeq: 4 })] }));
    const rowOf = (name: RegExp) => within(section("Versed")).getByRole("button", { name }).closest(".sb-row")!;
    await waitFor(() => expect(rowOf(/^Alpha/)).toHaveAttribute("data-unread"));
    act(() => store.getState().applySessionStatus("a", "running"));
    expect(rowOf(/^Alpha/)).not.toHaveAttribute("data-unread");
  });

  it("wears a clock when a schedule started it", async () => {
    await mount(home({ sessions: [session("a", "s1", { title: "Alpha", dispatchedBy: { kind: "run", sessionId: null } }), session("b", "s2", {})] }));
    const row = within(section("Versed")).getByRole("button", { name: /^Alpha/ });
    expect(row).toHaveAccessibleName("Alpha, from a schedule");
    expect(row.querySelector(".sb-gutter svg")).not.toBeNull();
  });

  it("leaves out a sub-agent and an archived session", async () => {
    await mount(home({
      items: { s1: [sessionItem("a", "s1", "Alpha"), sessionItem("kid", "s1", "Agent: look it up"), sessionItem("old", "s1", "Put away", { archived: true })] },
      sessions: [session("a", "s1", { title: "Alpha" }), session("kid", "s1", { dispatchedBy: { kind: "agent_run", sessionId: "a" } }), session("old", "s1", {})],
    }));
    await waitFor(() => expect(rowsIn("Versed")).toEqual(["Alpha"]));
  });

  it("puts its session away from its shelf", async () => {
    const { api } = await mount(home({ items: { s1: [sessionItem("a", "s1", "Alpha")], s2: [sessionItem("b", "s2", "Wants a yes")] } }));
    fireEvent.click(await within(section("Versed")).findByRole("button", { name: "Archive Alpha" }));
    await waitFor(() => expect(rowsIn("Versed")).toEqual(["New session", "Add a teammate"])); // an empty space's two ways in
    expect(api.data.items.s1![0]!.archived).toBe(true);
  });

  it("reads every space's rows again straight after a write to another space's row", async () => {
    /* The window hears `items.changed` for the room on screen only, so a pin from another space put
       away here is re-read by the sidebar itself, at once — not on the next beat something else
       happens to move. THE MUTANT: a row that writes and leaves the list to catch up. */
    const { api } = await mount(home({ items: { ...home().items, s2: [sessionItem("b", "s2", "Wants a yes", { pinned: true })] } }));
    const pinned = await screen.findByRole("region", { name: "Pinned" });
    const reads = () => api.calls.filter((c) => c === "listAllItems").length;
    const before = reads();
    fireEvent.click(within(pinned).getByRole("button", { name: "Unpin Wants a yes" }));
    await waitFor(() => expect(reads()).toBeGreaterThan(before), { timeout: ALL_ITEMS_SETTLE_MS - 100 });
  });

  it("keeps its state and its one action in one slot at the far end", async () => {
    /* THE MUTANTS: a mark outside the trailing group would stay on screen under the button, and a
       wrong count would make the title give way by the wrong amount on hover. */
    const layout: Layout = { type: "split", id: "S", dir: "row", sizes: [50, 50], children: [
      { type: "leaf", id: "L1", itemId: "i-a" }, { type: "leaf", id: "L2", itemId: "i-term" },
    ] };
    await mount(home({ spaces: [space("s1", "p1", "Versed", { layout }), space("s2", "p1", "Homework")],
      sessions: [session("a", "s1", { title: "Alpha", status: "running" }), session("b", "s2", {})] }));
    const alpha = within(section("Versed")).getByRole("button", { name: /^Alpha/ }).closest(".item")!;
    expect(alpha.querySelector(".item-row > .status-dot, .item-row > .item-glyph")).toBeNull();
    expect(alpha.querySelectorAll(".item-trail .status-dot, .item-trail .item-glyph")).toHaveLength(2);
    expect([...alpha.querySelectorAll(".item-actions > button")].map((b) => b.getAttribute("aria-label"))).toEqual(["Archive Alpha"]);
    expect(alpha.getAttribute("data-actions")).toBe("1");
  });

  it("draws the pane glyph for a session on screen in a split, lighting its own side", async () => {
    const layout: Layout = { type: "split", id: "root", dir: "row", sizes: [50, 50], children: [
      { type: "leaf", id: "L1", itemId: "i-a" }, { type: "leaf", id: "L2", itemId: "i-x" },
    ] };
    await mount(home({ spaces: [space("s1", "p1", "Versed", { layout }), space("s2", "p1", "Homework")],
      items: { s1: [sessionItem("a", "s1", "Alpha"), sessionItem("x", "s1", "Beta")] },
      sessions: [session("a", "s1", { title: "Alpha" }), session("x", "s1", { title: "Beta" })] }));
    const glyph = (name: RegExp) => within(section("Versed")).getByRole("button", { name }).querySelector(".item-glyph")!;
    expect(onCells(glyph(/^Alpha/))).toEqual([0]);
    expect(onCells(glyph(/^Beta/))).toEqual([1]);
  });

  it("pictures the split as it is drawn: none for a session filling its place, the side panel out or not", async () => {
    /* The owner, 10-05: a session filling the window — its side pane put away by the toggle at the top
       right, nothing else split — wore a half-lit glyph, for the side pane the window was not drawing.
       The panel is the window's now, not a pane of the split, so it is in no glyph at all.
       THE MUTANTS: the glyph drawing the panel (half-lit beside a browser), or none for a real split. */
    const { store } = await mount(home({ items: {
      s1: [item("i-term", "s1", { kind: "terminal", title: "Terminal" }), sessionItem("a", "s1", "Alpha"), sessionItem("x", "s1", "Beta")],
      s2: [sessionItem("b", "s2", "Wants a yes")],
    }, sessions: [session("a", "s1", { title: "Alpha" }), session("x", "s1", { title: "Beta" }), session("b", "s2", { title: "Wants a yes" })] }));
    const glyph = (name: RegExp) => within(section("Versed")).getByRole("button", { name }).querySelector(".item-glyph");
    await act(async () => { await store.getState().openItem("i-a"); });
    expect(glyph(/^Alpha/), "one pane filling the window").toBeNull();
    await act(async () => { await store.getState().openInSidePane("a", "i-term"); });
    expect(glyph(/^Alpha/), "beside the side panel: still the one pane of the split").toBeNull();
    // A real split is one, with the panel out or put away alike.
    await act(async () => { await store.getState().openItemBeside("i-x"); });
    expect(onCells(glyph(/^Alpha/)!)).toEqual([0]);
    expect(onCells(glyph(/^Beta/)!)).toEqual([1]);
    expect(glyph(/^Alpha/)!.querySelectorAll("rect")).toHaveLength(2);
    await act(async () => { await store.getState().toggleSidePanes(); });
    expect(store.getState().sidePanesHidden).toBe(true);
    expect(glyph(/^Alpha/)!.querySelectorAll("rect")).toHaveLength(2);
    // Filling their place by pane focus (⌘⇧F) is one pane on screen too, and the other is not there.
    await act(async () => { await store.getState().focusPaneFull(findLeafOfItem(store.getState().layout!, "i-a")!.id); });
    expect(glyph(/^Alpha/)).toBeNull();
    expect(glyph(/^Beta/)).toBeNull();
  });

  it("opens a session BESIDE the one in focus on ⌘-click", async () => {
    // THE MUTANT: ignore the modifier. ⌘-click would then replace the session on screen, and the
    // window's one split would have no way in from the list.
    const { store } = await mount(home({ items: { s1: [sessionItem("a", "s1", "Alpha"), sessionItem("x", "s1", "Beta")] },
      sessions: [session("a", "s1", { title: "Alpha" }), session("x", "s1", { title: "Beta" })] }));
    fireEvent.click(within(section("Versed")).getByRole("button", { name: /^Alpha/ }));
    await waitFor(() => expect(store.getState().layout).not.toBeNull());
    fireEvent.click(within(section("Versed")).getByRole("button", { name: /^Beta/ }), { metaKey: true });
    await waitFor(() => expect(allItems(store.getState().layout!)).toEqual(expect.arrayContaining(["i-a", "i-x"])));
  });

  it("lights the row of the session in focus, and only that one", async () => {
    const layout: Layout = { type: "split", id: "root", dir: "row", sizes: [50, 50], children: [
      { type: "leaf", id: "L1", itemId: "i-a" }, { type: "leaf", id: "L2", itemId: "i-x" },
    ] };
    const { store } = await mount(home({ spaces: [space("s1", "p1", "Versed", { layout }), space("s2", "p1", "Homework")],
      items: { s1: [sessionItem("a", "s1", "Alpha"), sessionItem("x", "s1", "Beta")] },
      sessions: [session("a", "s1", { title: "Alpha" }), session("x", "s1", { title: "Beta" })] }));
    const row = (name: RegExp) => within(section("Versed")).getByRole("button", { name }).closest(".item")!;
    act(() => store.setState({ focusedLeafId: "L2" }));
    expect(row(/^Beta/)).toHaveAttribute("data-active");
    expect(row(/^Alpha/)).not.toHaveAttribute("data-active");
  });

  it("drags into a pane, carrying its item", async () => {
    await mount(home());
    const row = within(section("Versed")).getByRole("button", { name: /^Alpha/ }).closest(".item")!;
    expect(row).toHaveAttribute("draggable", "true");
    const data: Record<string, string> = {};
    fireEvent.dragStart(row, { dataTransfer: { setData: (k: string, v: string) => { data[k] = v; }, effectAllowed: "" } });
    expect(data["application/x-realm-item"]).toBe("i-a");
    expect(row).toHaveAttribute("data-dragging");
    fireEvent.dragEnd(row);
    expect(row).not.toHaveAttribute("data-dragging");
  });

  it("pins from its menu, and the pin shows under Pinned", async () => {
    await mount(home());
    fireEvent.contextMenu(within(section("Versed")).getByRole("button", { name: /^Alpha/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Pin" }));
    const pinned = await screen.findByRole("region", { name: "Pinned" });
    expect(within(pinned).getByRole("button", { name: "Alpha in Versed" })).toBeInTheDocument();
  });

  it("renames from its menu, committing on Enter", async () => {
    await mount(home());
    fireEvent.contextMenu(within(section("Versed")).getByRole("button", { name: /^Alpha/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Rename Alpha" });
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(rowsIn("Versed")).toEqual(["Renamed"]));
  });

  it("deletes from its menu in two steps", async () => {
    const { api } = await mount(home());
    fireEvent.contextMenu(within(section("Versed")).getByRole("button", { name: /^Alpha/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(api.calls.some((c) => c.startsWith("deleteItem:"))).toBe(false);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Really delete?" }));
    await waitFor(() => expect(api.calls).toContain("deleteItem:i-a"));
    await waitFor(() => expect(rowsIn("Versed")).not.toContain("Alpha"));
  });
});

describe("a fan-out", () => {
  const fan = (id: string, at: number, status: Session["status"] = "running") =>
    session(id, "s1", { title: "Migrate the API", status, createdAt: at, updatedAt: at, dispatchedBy: { kind: "user-dispatch", sessionId: null } });

  it("is one row that unfolds to its sessions, summing their states", async () => {
    // THE MUTANT: list the siblings flat, and twenty of them bury the space.
    await mount(home({
      items: { s1: ["f1", "f2", "f3"].map((id) => sessionItem(id, "s1", "Migrate the API")), s2: [] },
      sessions: [fan("f1", 1000), fan("f2", 2000, "waiting_permission"), fan("f3", 3000)],
    }));
    const row = await within(section("Versed")).findByRole("button", { name: /^Fan-out: Migrate the API/ });
    expect(row).toHaveAccessibleName("Fan-out: Migrate the API — 3 sessions, 1 waiting on you, 2 running");
    expect(within(section("Versed")).queryAllByRole("button", { name: /^Migrate the API/ })).toHaveLength(0);
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(within(section("Versed")).getAllByRole("button", { name: /^Migrate the API/ })).toHaveLength(3);
  });
});

describe("Pinned", () => {
  const pinnedRegion = () => screen.findByRole("region", { name: "Pinned" });

  it("holds the profile's pinned items from every one of its spaces, and opens them where they are", async () => {
    const { store } = await mount(home({
      items: {
        s1: [item("i-gh", "s1", { kind: "browser", refId: "br1", title: "GitHub", pinned: true })],
        s2: [sessionItem("b", "s2", "Wants a yes", { pinned: true })],
        s3: [sessionItem("c", "s3", "Notes", { pinned: true })],
      },
    }));
    const pinned = await pinnedRegion();
    await waitFor(() => expect([...pinned.querySelectorAll(".item-row")].map((b) => b.getAttribute("aria-label")))
      .toEqual(["GitHub in Versed", "Wants a yes in Homework — needs permission"]));
    fireEvent.click(within(pinned).getByRole("button", { name: /^Wants a yes/ }));
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s2"));
  });

  it("is not drawn while nothing is pinned", async () => {
    await mount(home());
    expect(screen.queryByRole("region", { name: "Pinned" })).toBeNull();
  });

  it("draws a pinned browser with its page's own icon", async () => {
    const ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9h";
    await mount(home({ items: { s1: [item("i1", "s1", { kind: "browser", refId: "b1", pinned: true, title: "GitHub", favicon: ICON })] } }));
    expect(within(await pinnedRegion()).getByRole("button", { name: /^GitHub/ })
      .querySelector("img.page-icon")?.getAttribute("src")).toBe(ICON);
  });

  it("wears the state its session's row wears — running, needs you, failed, finished while you were away", async () => {
    // THE MUTANT: a pin that draws no mark (the old tile), so a finished build says nothing from Pinned.
    const pin = (id: string, title: string) => sessionItem(id, "s1", title, { pinned: true });
    await mount(home({
      items: { s1: [pin("r", "Builds"), pin("w", "Asks"), pin("e", "Broke"), pin("u", "Finished"), pin("q", "Quiet")], s2: [] },
      sessions: [
        session("r", "s1", { status: "running" }), session("w", "s1", { status: "waiting_permission" }), session("e", "s1", { status: "error" }),
        session("u", "s1", { lastEventSeq: 9, seenSeq: 4 }), session("q", "s1", { lastEventSeq: 4, seenSeq: 4 }),
      ],
    }));
    const pinned = await pinnedRegion();
    const row = (title: string) => within(pinned).getByRole("button", { name: new RegExp(`^${title} in Versed`) });
    await waitFor(() => expect(row("Builds")).toHaveAccessibleName("Builds in Versed — running"));
    expect(row("Asks")).toHaveAccessibleName("Asks in Versed — needs permission");
    expect(row("Broke")).toHaveAccessibleName("Broke in Versed — error");
    expect(row("Finished")).toHaveAccessibleName("Finished in Versed — new since you were here");
    expect(row("Quiet")).toHaveAccessibleName("Quiet in Versed");
    const dot = (title: string) => row(title).querySelector(".status-dot")?.getAttribute("data-status") ?? null;
    expect(["Builds", "Asks", "Broke", "Finished", "Quiet"].map(dot)).toEqual(["running", "waiting_permission", "error", "unseen", null]);
    // Finished while away is said twice, as on the rows below: the dot, and the title lifted.
    expect(row("Finished").closest(".item")).toHaveAttribute("data-unread");
    expect(row("Quiet").closest(".item")).not.toHaveAttribute("data-unread");
    // The title is the whole title, in the row's elastic column — not cut to a tile's six letters.
    expect(row("Finished").querySelector(".item-title")).toHaveTextContent(/^Finished$/);
  });

  it("counts a lead's sub-agents that need you", async () => {
    // THE MUTANT: the pin built from the item alone, without `agentsWaiting` — no count, and a lead
    // whose children are stuck reads as merely running.
    const kid = (id: string) => session(id, "s1", { title: `Kid ${id}`, status: "waiting_permission", dispatchedBy: { kind: "agent_run", sessionId: "a" } });
    await mount(home({
      items: { s1: [sessionItem("a", "s1", "Alpha", { pinned: true }), sessionItem("k1", "s1", "Kid k1"), sessionItem("k2", "s1", "Kid k2")] },
      sessions: [session("a", "s1", { title: "Alpha", status: "running" }), kid("k1"), kid("k2")],
    }));
    const pin = await within(await pinnedRegion()).findByRole("button", { name: "Alpha in Versed, 2 sub-agents need you — running" });
    expect(pin.querySelector(".item-count")).toHaveTextContent("2");
  });

  it("leads with what the item is: a session's space, a page's icon, a document's glyph", async () => {
    // THE MUTANTS: every pin the same chat bubble, which is what made twelve tiles indistinguishable;
    // and a session led by its agent's mark, which says nothing about which space it is in.
    await mount(home({
      spaces: [space("s1", "p1", "Versed", { icon: "emoji:🎬", color: "#7c6cff" }), space("s2", "p1", "Homework", { color: "#3ddc97" })],
      items: { s1: [sessionItem("a", "s1", "Alpha", { pinned: true }), item("i-doc", "s1", { kind: "documents", refId: "d1", title: "Spec", pinned: true })], s2: [] },
      sessions: [session("a", "s1", { title: "Alpha", agentKind: "claude" })],
    }));
    const pinned = await pinnedRegion();
    const alpha = await within(pinned).findByRole("button", { name: "Alpha in Versed" });
    expect(alpha.querySelector(".sb-space-icon")).toHaveTextContent("🎬");
    expect(alpha.querySelector("svg[data-brand]")).toBeNull();
    // The space's colour, as its section's icon wears it.
    expect((alpha.querySelector(".sb-space-icon") as HTMLElement).style.color).not.toBe("");
    expect(within(pinned).getByRole("button", { name: /^Spec/ }).querySelector("svg")).not.toBeNull();
    // Below the pins, the same session keeps its own row's mark.
    expect(within(section("Versed")).getByRole("button", { name: /^Alpha/ }).querySelector(".sb-space-icon")).toBeNull();
  });

  it("unpins from the row, and the pin leaves", async () => {
    // THE MUTANT: the session row's Archive in the pin's slot — a click that shelves the session.
    await mount(home({ items: { s1: [sessionItem("a", "s1", "Alpha", { pinned: true })], s2: [] } }));
    fireEvent.click(within(await pinnedRegion()).getByRole("button", { name: "Unpin Alpha" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Pinned" })).toBeNull());
    // Still a session of its space, not put away.
    expect(rowsIn("Versed")).toEqual(["Alpha"]);
  });

  it("drags into a pane like any row, carrying its item", async () => {
    await mount(home({ items: { s1: [item("i-gh", "s1", { kind: "browser", refId: "br1", title: "GitHub", pinned: true })], s2: [] } }));
    const row = within(await pinnedRegion()).getByRole("button", { name: /^GitHub/ }).closest(".item")!;
    expect(row).toHaveAttribute("draggable", "true");
    const data: Record<string, string> = {};
    fireEvent.dragStart(row, { dataTransfer: { setData: (k: string, v: string) => { data[k] = v; }, effectAllowed: "" } });
    expect(data["application/x-realm-item"]).toBe("i-gh");
  });
});

describe("the list's fade", () => {
  it("is nothing but the scroller — no band element sits beside or inside it", async () => {
    // The dissolve is the shared mask on .space-body, which marks itself `data-dissolve` (pinned in
    // styles.test.ts). The named mutant is the old `.space-fade` sibling coming back: a
    // backdrop-filter band over this translucent column blurs the window's own transparency into a
    // dark smudge. THE second mutant: the scroller left unmarked, which leaves it no dissolve at all.
    const { container } = await mount();
    const body = container.querySelector(".space-body")!;
    expect(body.parentElement).toHaveClass("sb-list");
    expect(body).toHaveAttribute("data-dissolve");
    expect(container.querySelector(".space-fade")).toBeNull();
    // Everything that scrolls is inside it: Needs you, Pinned, the list's head and the space alike.
    expect(body.querySelector(".sb-lens")).not.toBeNull();
    expect(body.querySelector(".sb-section")).not.toBeNull();
  });
});

function onCells(glyph: Element): number[] {
  return Array.from(glyph.querySelectorAll("rect"))
    .map((s, i) => (s.hasAttribute("data-on") ? i : null))
    .filter((x): x is number => x !== null);
}
function hexToRgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

describe("paneMapOf — the arrangement itself, not a category of arrangement", () => {
  const leaf = (id: string, itemId: string | null): Layout => ({ type: "leaf", id, itemId });
  const split = (dir: "row" | "col", children: Layout[], sizes?: number[]): Layout =>
    ({ type: "split", id: `s${dir}`, dir, sizes: sizes ?? children.map(() => 100 / children.length), children });
  /** Rects rounded, so a test reads as geometry rather than as floating point. */
  const boxes = (l: Layout, id: string) =>
    paneMapOf(l, id)?.map((r) => [r.x, r.y, r.w, r.h, r.active] as const)
      .map(([x, y, w, h, a]) => [+x.toFixed(3), +y.toFixed(3), +w.toFixed(3), +h.toFixed(3), a]);

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

describe("layoutOnScreen — the split as the window draws it", () => {
  const leaf = (id: string, itemId: string | null): Layout => ({ type: "leaf", id, itemId });
  const panel = (id: string, owner: string, tabs: string[]): Layout => ({ type: "leaf", id, itemId: tabs[0]!, tabs, owners: Object.fromEntries(tabs.map((t) => [t, owner])) });
  const split = (id: string, dir: "row" | "col", children: Layout[], sizes?: number[]): Layout =>
    ({ type: "split", id, dir, sizes: sizes ?? children.map(() => 100 / children.length), children });
  const ids = (l: Layout | null): unknown => (!l ? null : l.type === "leaf" ? l.id : { [l.dir]: l.children.map(ids), sizes: l.sizes });

  it("is the main panes, never the side panel: a session beside the panel alone wears no glyph", () => {
    // THE MUTANT: picture the panel as a pane. A session with a browser open beside it would wear a
    // half-lit glyph for a pane it is not split with (the owner, 10-05).
    const one = split("R", "row", [leaf("A", "a"), panel("P", "a", ["t"])], [50, 50]);
    expect(ids(layoutOnScreen(one))).toBe("A");
    expect(paneMapOf(layoutOnScreen(one)!, "a")).toBeNull();
    const two = split("R", "row", [split("M", "row", [leaf("A", "a"), leaf("B", "b")], [30, 70]), panel("P", "a", ["t"])]);
    expect(ids(layoutOnScreen(two))).toEqual({ row: ["A", "B"], sizes: [30, 70] });
    const plain = split("M", "col", [leaf("A", "a"), leaf("B", "b")]);
    expect(layoutOnScreen(plain)).toBe(plain);
  });

  it("is the one pane that fills their place under pane focus, and nothing while the panel fills the window", () => {
    const l = split("R", "row", [split("M", "row", [leaf("A", "a"), leaf("B", "b")]), panel("P", "a", ["t"])]);
    expect(ids(layoutOnScreen(l, { zoomedLeafId: "B" }))).toBe("B");
    expect(layoutOnScreen(l, { zoomedLeafId: "P" })).toBeNull();
    // A zoom the tree no longer holds is no zoom.
    expect(ids(layoutOnScreen(l, { zoomedLeafId: "gone" }))).toEqual({ row: ["A", "B"], sizes: [50, 50] });
  });
});

