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
const head = (name: string) => within(section(name)).getByRole("button", { name: new RegExp(`^${name}( —|$)`) });
const rowsIn = (name: string) => [...section(name).querySelectorAll(".sb-section-clip .item-title")].map((t) => t.textContent);

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
    await waitFor(() => expect(store.getState().agentsAsk["a"]).toMatchObject({ childId: "k2" }));
  });
});

describe("the list", () => {
  it("is the profile's spaces as sections of one scroller — no strip, no Open, no other spaces, no Archived", async () => {
    const { container } = await mount(home());
    const body = container.querySelector(".space-body")!;
    expect([...body.querySelectorAll(".sb-section")].map((s) => s.getAttribute("aria-label"))).toEqual(["Versed", "Homework"]);
    // Another profile's spaces are its own list.
    expect(screen.queryByRole("region", { name: "Lectures" })).toBeNull();
    // What left the sidebar, by name.
    expect(container.querySelector(".space-strip, .swiper, .space-page")).toBeNull();
    for (const gone of [/^Open$/, /^Other spaces$/, /^Archived$/, /^Sessions$/]) expect(within(body as HTMLElement).queryByText(gone)).toBeNull();
    expect(screen.queryByRole("button", { name: /New split/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Switch to space/ })).toBeNull();
  });

  it("shows every space's sessions at once, without switching to it", async () => {
    // THE MUTANT: draw the active room's rows alone, and Homework's waiting session is a walk away.
    const { store } = await mount(home());
    await waitFor(() => expect(rowsIn("Homework")).toEqual(["Wants a yes"]));
    expect(store.getState().activeSpaceId).toBe("s1");
  });

  it("hydrates saved custom space icons before the sections draw them", async () => {
    const asset = iconAsset("ia-saved", "p1");
    const api = fakeApi({ spaces: [space("s1", "p1", "Versed", { icon: `asset:${asset.id}` })], iconAssets: { p1: [asset] } });
    await mount(api);
    expect(api.calls).toContain("listIconAssets:p1");
    expect(head("Versed").querySelector(".sb-space-icon circle")).not.toBeNull();
  });

  it("keeps New space at the column's foot, outside the list, however long the list and in either reading", async () => {
    // The owner, 10-04: "the button disappears when the list is too long". THE MUTANT: New space back
    // at the list's end, inside the scroller, where thirty spaces carry it out of the column.
    const many = Array.from({ length: 30 }, (_, i) => space(`m${i}`, "p1", `Space ${i + 1}`));
    const { store, container } = await mount(home({ spaces: many }));
    const row = () => screen.getByRole("button", { name: "New space" });
    expect(container.querySelectorAll(".sb-section")).toHaveLength(30);
    expect(row().closest(".space-body")).toBeNull();
    expect(row().closest(".sb-foot")!.previousElementSibling).toHaveClass("space-body");
    fireEvent.click(row());
    await waitFor(() => expect(store.getState().sheet).toEqual({ kind: "new-space" }));
    act(() => store.getState().closeSheet());
    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    await waitFor(() => expect(store.getState().sidebarLens).toBe("recent"));
    expect(row().closest(".sb-foot")).not.toBeNull();
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

describe("a space's section", () => {
  it("names its space in the space's colour, and says what is going on in it", async () => {
    await mount(home({ sessions: [
      session("a", "s1", { title: "Alpha", status: "running" }), session("b", "s2", { title: "Wants a yes", status: "waiting_permission" }),
      session("c", "s3", { title: "Notes" }),
    ] }));
    // THE MUTANT: tint nothing, and the colour is back to marking one icon in a strip that is gone.
    // The colour as the face on screen can carry it — jsdom has no media queries, so the light face.
    expect((head("Homework").querySelector(".sb-space-icon") as HTMLElement).style.color).toBe(hexToRgb(spaceColor("#3ddc97", "light")));
    expect(head("Homework")).toHaveAccessibleName("Homework — 1 waiting on you");
    const tally = head("Homework").querySelector(".item-trail")!;
    expect(within(tally as HTMLElement).getByText("1").nextElementSibling).toHaveAttribute("data-status", "waiting_permission");
    expect(head("Versed")).toHaveAccessibleName("Versed — 1 running");
    expect(head("Versed").querySelector(".item-trail .status-dot")).toHaveAttribute("data-status", "running");
  });

  it("wears the unread mark and its count on a folded head whose only news is a finished, unread session", async () => {
    // THE MUTANT: `TallyMarks` drawing waiting and running only — a folded space with two finished
    // turns nobody has read says nothing at all, which is the report this answers.
    await mount(home({
      items: { s1: [sessionItem("a", "s1", "Alpha"), sessionItem("d", "s1", "Delta")], s2: [sessionItem("b", "s2", "Wants a yes")] },
      sessions: [session("a", "s1", { title: "Alpha", seenSeq: 3, lastEventSeq: 5 }), session("d", "s1", { title: "Delta", seenSeq: 1, lastEventSeq: 2 }),
        session("b", "s2", { title: "Wants a yes", status: "waiting_permission" })],
      settings: { "ui.sidebarCollapsedSpaces": ["s1"] },
    }));
    await waitFor(() => expect(head("Versed")).toHaveAttribute("aria-expanded", "false"));
    expect(head("Versed")).toHaveAccessibleName("Versed — 2 unread");
    const tally = head("Versed").querySelector(".item-trail")!;
    expect(within(tally as HTMLElement).getByText("2").nextElementSibling).toHaveAttribute("data-status", "unseen");
  });

  it("keeps one mark on a head: something working outranks the unread count", async () => {
    // THE MUTANT: the unread tally drawn whatever else is showing — two counts and two dots on one head.
    await mount(home({
      items: { s1: [sessionItem("a", "s1", "Alpha"), sessionItem("d", "s1", "Delta")], s2: [sessionItem("b", "s2", "Wants a yes")] },
      sessions: [session("a", "s1", { title: "Alpha", seenSeq: 3, lastEventSeq: 5 }), session("d", "s1", { title: "Delta", status: "running" }),
        session("b", "s2", { title: "Wants a yes", status: "waiting_permission" })],
    }));
    await waitFor(() => expect(head("Versed")).toHaveAccessibleName("Versed — 1 running, 1 unread"));
    const dots = [...head("Versed").querySelectorAll(".item-trail .status-dot")].map((d) => d.getAttribute("data-status"));
    expect(dots).toEqual(["running"]);
  });

  it("folds, and remembers it across a relaunch", async () => {
    const { api, store } = await mount(home());
    await waitFor(() => expect(rowsIn("Homework")).toEqual(["Wants a yes"]));
    expect(head("Homework")).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(head("Homework"));
    await waitFor(() => expect(head("Homework")).toHaveAttribute("aria-expanded", "false"));
    expect(api.data.settings["ui.sidebarCollapsedSpaces"]).toEqual(["s2"]);
    // Folded rows are out of the tab order and out of what a reader hears.
    const clip = section("Homework").querySelector(".sb-section-clip")!;
    expect(clip).toHaveAttribute("inert");
    expect(clip).toHaveAttribute("aria-hidden", "true");
    expect(within(section("Homework")).queryByRole("button", { name: /Wants a yes/ })).toBeNull();
    void store;
    cleanup();
    await mount(home({ settings: { "ui.sidebarCollapsedSpaces": ["s2"] } }));
    await waitFor(() => expect(head("Homework")).toHaveAttribute("aria-expanded", "false"));
    expect(head("Versed")).toHaveAttribute("aria-expanded", "true");
  });

  it("lists its sessions newest first, five of them, then Show more opens the space's page", async () => {
    const many = Array.from({ length: 7 }, (_, i) => session(`m${i}`, "s2", { title: `Task ${i}`, activityAt: 1000 + i }));
    const { store } = await mount(home({
      items: { s1: [], s2: many.map((m) => sessionItem(m.id, "s2", m.title)) },
      sessions: many,
    }));
    await waitFor(() => expect(rowsIn("Homework")).toEqual(["Task 6", "Task 5", "Task 4", "Task 3", "Task 2"]));
    const more = within(section("Homework")).getByRole("button", { name: /Show more/ });
    expect(more).toHaveTextContent("Show more 2");
    // The page last showed the archived ones; "Show more 2" counts live ones, so it lands on those.
    act(() => store.getState().setSpaceSessionsView("s2", "archived"));
    fireEvent.click(more);
    await waitFor(() => expect(store.getState().pageOverlay).toMatchObject({ kind: "space-page", refId: "s2" }));
    expect(store.getState().spacePageTab.s2).toBe("sessions");
    expect(store.getState().spaceSessionsView.s2).toBe("active");
  });

  it("offers a new session in an empty space as its one row", async () => {
    const { api, store } = await mount(home({ items: { s1: [], s2: [] }, sessions: [] }));
    fireEvent.click(within(section("Homework")).getByRole("button", { name: "New session" }));
    await waitFor(() => expect(api.calls).toContain("createSession:claude"));
    expect(store.getState().activeSpaceId).toBe("s2");
  });

  it("makes a new session in its own space from the + on its head", async () => {
    // THE MUTANT: create in the room on screen. The session would land in Versed under Homework's +.
    const { api, store } = await mount(home());
    fireEvent.click(within(section("Homework")).getByRole("button", { name: "New session in Homework" }));
    await waitFor(() => expect(api.calls).toContain("createSession:claude"));
    expect(api.data.sessions.at(-1)!.spaceId).toBe("s2");
    expect(store.getState().activeSpaceId).toBe("s2");
  });

  it("opens its space's own pages from the ⋯ on its head", async () => {
    const { store } = await mount(home());
    const open = async () => {
      fireEvent.click(within(section("Homework")).getByRole("button", { name: "More for Homework" }));
      return within(await screen.findByRole("menu", { name: "Homework" }));
    };
    fireEvent.click((await open()).getByRole("menuitem", { name: "Connections" }));
    await waitFor(() => expect(store.getState().pageOverlay).toMatchObject({ kind: "space-page", refId: "s2" }));
    expect(store.getState().spacePageTab.s2).toBe("connections");
    for (const [name, tab] of [["Memory", "memory"], ["Archived sessions", "sessions"], ["Space settings", "general"]] as const) {
      await exited();
      fireEvent.click((await open()).getByRole("menuitem", { name }));
      await waitFor(() => expect(store.getState().spacePageTab.s2).toBe(tab));
      // "Archived sessions" lands on the page's Archived filter, not on the live list.
      if (name === "Archived sessions") expect(store.getState().spaceSessionsView.s2).toBe("archived");
    }
    // Show in Finder is offered only where the desktop bridge can reveal a folder.
    await exited();
    expect((await open()).queryByRole("menuitem", { name: "Show in Finder" })).toBeNull();
  });

  it("reveals its folder in the Finder where the bridge can", async () => {
    const reveal = vi.fn(async () => true);
    vi.stubGlobal("realm", { files: { reveal } });
    await mount(home({ spaces: [space("s1", "p1", "Versed"), space("s2", "p1", "Homework", { folderPath: "/work/homework" })] }));
    fireEvent.click(within(section("Homework")).getByRole("button", { name: "More for Homework" }));
    fireEvent.click(within(await screen.findByRole("menu", { name: "Homework" })).getByRole("menuitem", { name: "Show in Finder" }));
    expect(reveal).toHaveBeenCalledWith("/work/homework");
  });

  it("starts a session in a fresh worktree of its space from the ⋯", async () => {
    const { api } = await mount(home({ gitInfo: { "/tmp": { branch: "main", additions: 0, deletions: 0, dirty: 0, ahead: 0, behind: 0 } } }));
    fireEvent.click(within(section("Homework")).getByRole("button", { name: "More for Homework" }));
    fireEvent.click(within(await screen.findByRole("menu", { name: "Homework" })).getByRole("menuitem", { name: "New session in a worktree" }));
    await waitFor(() => expect(api.calls).toContain("createWorktree:s2"));
  });

  it("offers no session in a worktree from the ⋯ of a space that is a plain folder", async () => {
    const { store } = await mount(home({ spaces: [space("s1", "p1", "Versed"), space("s2", "p1", "Homework", { folderPath: "/work/homework" })] }));
    await act(async () => { await store.getState().refreshGitInfo("/work/homework"); });
    fireEvent.click(within(section("Homework")).getByRole("button", { name: "More for Homework" }));
    const menu = await screen.findByRole("menu", { name: "Homework" });
    expect(within(menu).queryByRole("menuitem", { name: "New session in a worktree" })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "Space settings" })).toBeInTheDocument();
  });
});

describe("a session's row", () => {
  it("opens its session wherever it is", async () => {
    const { store } = await mount(home());
    fireEvent.click(await within(section("Homework")).findByRole("button", { name: /^Wants a yes/ }));
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s2"));
    await waitFor(() => expect(allItems(store.getState().layout!)).toContain("i-b"));
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
    const rowOf = (sec: string, name: RegExp) => within(section(sec)).getByRole("button", { name }).closest(".sb-row")!;
    await waitFor(() => expect(rowOf("Versed", /^Alpha/)).toHaveAttribute("data-unread"));
    expect(rowOf("Homework", /^Wants a yes/)).not.toHaveAttribute("data-unread");
    act(() => store.getState().applySessionStatus("a", "running"));
    expect(rowOf("Versed", /^Alpha/)).not.toHaveAttribute("data-unread");
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

  it("puts its session away from its shelf — in this space or another", async () => {
    const { api } = await mount(home());
    await within(section("Homework")).findByRole("button", { name: /^Wants a yes/ });
    fireEvent.click(within(section("Versed")).getByRole("button", { name: "Archive Alpha" }));
    // (Closing the room's last pane lands in a fresh session, which is the store's rule, not the row's.)
    await waitFor(() => expect(rowsIn("Versed")).not.toContain("Alpha"));
    fireEvent.click(within(section("Homework")).getByRole("button", { name: "Archive Wants a yes" }));
    await waitFor(() => expect(rowsIn("Homework")).toEqual(["New session"])); // an empty space's one row
    expect(api.data.items.s2![0]!.archived).toBe(true);
  });

  it("reads every space's rows again straight after a write to another space's row", async () => {
    /* The window hears `items.changed` for the room on screen only, so a row put away or pinned in
       another space is re-read by the sidebar itself, at once — not on the next beat something else
       happens to move. THE MUTANTS: a shelf or a menu that writes and leaves the list to catch up. */
    const { api } = await mount(home());
    await within(section("Homework")).findByRole("button", { name: /^Wants a yes/ });
    const reads = () => api.calls.filter((c) => c === "listAllItems").length;
    const soon = { timeout: ALL_ITEMS_SETTLE_MS - 100 };
    let before = reads();
    fireEvent.contextMenu(within(section("Homework")).getByRole("button", { name: /^Wants a yes/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Pin" }));
    await waitFor(() => expect(reads()).toBeGreaterThan(before), soon);
    await exited();
    before = reads();
    fireEvent.click(within(section("Homework")).getByRole("button", { name: "Archive Wants a yes" }));
    await waitFor(() => expect(reads()).toBeGreaterThan(before), soon);
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

  it("opens a session BESIDE the one in focus on ⌘-click — from any space", async () => {
    // THE MUTANT: ignore the modifier. ⌘-click would then replace the session on screen, and the
    // window's one split would have no way in from the list.
    const { store } = await mount(home());
    fireEvent.click(within(section("Versed")).getByRole("button", { name: /^Alpha/ }));
    await waitFor(() => expect(store.getState().layout).not.toBeNull());
    fireEvent.click(within(section("Homework")).getByRole("button", { name: /^Wants a yes/ }), { metaKey: true });
    await waitFor(() => {
      const open = allItems(store.getState().layout!);
      expect(open).toEqual(expect.arrayContaining(["i-a", "i-b"]));
    });
  });

  it("lights a row from another space once its session has focus", async () => {
    // THE MUTANT: keep the room's rule (only the current space's rows light). A session from another
    // space would then never show it is the one in focus.
    const { store } = await mount(home());
    const other = within(section("Homework")).getByRole("button", { name: /^Wants a yes/ }).closest(".item")!;
    fireEvent.click(within(section("Homework")).getByRole("button", { name: /^Wants a yes/ }));
    await waitFor(() => expect(other).toHaveAttribute("data-active"));
    void store;
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

  it("drags into a pane from any space, carrying its item", async () => {
    await mount(home());
    const row = within(section("Versed")).getByRole("button", { name: /^Alpha/ }).closest(".item")!;
    expect(row).toHaveAttribute("draggable", "true");
    const data: Record<string, string> = {};
    fireEvent.dragStart(row, { dataTransfer: { setData: (k: string, v: string) => { data[k] = v; }, effectAllowed: "" } });
    expect(data["application/x-realm-item"]).toBe("i-a");
    expect(row).toHaveAttribute("data-dragging");
    fireEvent.dragEnd(row);
    expect(row).not.toHaveAttribute("data-dragging");
    // Another space's row drags just the same: the view is the window's, not a room's.
    const other = (await within(section("Homework")).findByRole("button", { name: /^Wants a yes/ })).closest(".item")!;
    fireEvent.dragStart(other, { dataTransfer: { setData: (k: string, v: string) => { data[k] = v; }, effectAllowed: "" } });
    expect(data["application/x-realm-item"]).toBe("i-b");
  });

  it("pins from its menu, and the pin shows under Pinned", async () => {
    await mount(home());
    fireEvent.contextMenu(within(section("Homework")).getByRole("button", { name: /^Wants a yes/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Pin" }));
    const pinned = await screen.findByRole("region", { name: "Pinned" });
    expect(within(pinned).getByRole("button", { name: "Wants a yes in Homework — needs permission" })).toBeInTheDocument();
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
    session(id, "s2", { title: "Migrate the API", status, createdAt: at, updatedAt: at, dispatchedBy: { kind: "user-dispatch", sessionId: null } });

  it("is one row that unfolds to its sessions, summing their states", async () => {
    // THE MUTANT: list the siblings flat, and twenty of them bury the space.
    await mount(home({
      items: { s1: [], s2: ["f1", "f2", "f3"].map((id) => sessionItem(id, "s2", "Migrate the API")) },
      sessions: [fan("f1", 1000), fan("f2", 2000, "waiting_permission"), fan("f3", 3000)],
    }));
    const row = await within(section("Homework")).findByRole("button", { name: /^Fan-out: Migrate the API/ });
    expect(row).toHaveAccessibleName("Fan-out: Migrate the API — 3 sessions, 1 waiting on you, 2 running");
    expect(within(section("Homework")).queryAllByRole("button", { name: /^Migrate the API/ })).toHaveLength(0);
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(within(section("Homework")).getAllByRole("button", { name: /^Migrate the API/ })).toHaveLength(3);
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

  it("leads with what the item is: the session's agent, a page's icon, a document's glyph", async () => {
    // THE MUTANT: every pin the same chat bubble, which is what made twelve tiles indistinguishable.
    await mount(home({
      items: { s1: [sessionItem("a", "s1", "Alpha", { pinned: true }), item("i-doc", "s1", { kind: "documents", refId: "d1", title: "Spec", pinned: true })], s2: [] },
      sessions: [session("a", "s1", { title: "Alpha", agentKind: "claude" })],
    }));
    const pinned = await pinnedRegion();
    await waitFor(() => expect(within(pinned).getByRole("button", { name: /^Alpha/ }).querySelector("svg[data-brand]")).toHaveAttribute("data-brand", "claude"));
    expect(within(pinned).getByRole("button", { name: /^Spec/ }).querySelector("svg")).not.toBeNull();
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
    // Everything that scrolls is inside it: Needs you, Pinned, the list's head and the sections alike —
    // and New space is not, pinned below it.
    expect(body.querySelector(".sb-lens")).not.toBeNull();
    expect(body.querySelector(".sb-sections")).not.toBeNull();
    expect(body.querySelector(".sb-new-space")).toBeNull();
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

