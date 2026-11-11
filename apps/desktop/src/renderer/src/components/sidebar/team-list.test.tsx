import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { TeammateTaskSession } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, profile, session, space, teammate, type FakeData } from "../../state/store.test-fakes";
import { exited } from "../popover-exit.test-fakes";
import { Sidebar } from "./Sidebar";

/**
 * The space's team in the column (direction A): one flat list under the pinned row, the person's
 * groups the only nesting, and no disclosure on a teammate — its sessions are on its page.
 */

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const task = (id: string, extra: Partial<TeammateTaskSession> = {}): TeammateTaskSession =>
  ({ id, title: id, teammateId: "cto", parentId: null, state: "idle", updatedAt: 0, unread: false, ...extra });
const sessionItem = (id: string, title: string, extra = {}) => item(`i-${id}`, "s1", { kind: "session", refId: id, title, ...extra });

/** Versed holds a Lead, cto (working, with a task and a hand-off under it) and research in Strat, plus
 *  one session of the person's own. */
const team = (over: FakeData = {}): FakeData => ({
  profiles: [profile("p1", "Work")],
  spaces: [space("s1", "p1", "Versed")],
  items: { s1: [sessionItem("mine", "Alpha"), sessionItem("home-cto", "cto"), sessionItem("t1", "cto - sqlite search"), sessionItem("home-lead", "Lead")] },
  sessions: [
    session("mine", "s1", { title: "Alpha" }),
    session("home-cto", "s1", { title: "cto", teammateId: "cto", teammateHome: true }),
    session("t1", "s1", { title: "cto - sqlite search", teammateId: "cto", status: "running" }),
    session("home-lead", "s1", { title: "Lead", teammateId: "lead", teammateHome: true }),
  ],
  teammates: [
    teammate("cto", "s1", { name: "cto", brief: "You own the architecture.", state: "working", homeSessionId: "home-cto", sortOrder: 0,
      icon: { shape: "hexagon", color: "blue" }, liveTask: "cto - sqlite search",
      taskSessions: [task("t1", { title: "cto - sqlite search", state: "working", updatedAt: 20 }), task("t2", { title: "design - icon", teammateId: "design", parentId: "t1", updatedAt: 10 })] }),
    teammate("lead", "s1", { name: "Lead", lead: true, sortOrder: 5, homeSessionId: "home-lead" }),
    teammate("research", "s1", { name: "research", group: "Strat", state: "needs-you", sortOrder: 2 }),
  ],
  ...over,
});

async function mount(over: FakeData = {}) {
  const api = fakeApi(team(over));
  const store = createAppStore(api); await store.getState().boot();
  await act(() => store.getState().refreshTeammates());
  const r = render(<StoreContext.Provider value={store}><Sidebar /></StoreContext.Provider>);
  await waitFor(() => expect(api.calls).toContain("listAllItems"));
  return { api, store, ...r };
}

const teamList = () => screen.getByRole("group", { name: "Team" });
const titles = () => [...teamList().querySelectorAll(".item-title")].map((t) => t.textContent);

describe("the space's team", () => {
  it("is one flat list, the Lead first, then each group under its name — and no Team caption", async () => {
    // THE MUTANTS: the Lead in its sort order; the "Team" caption back over the list.
    await mount();
    await waitFor(() => expect(titles()).toEqual(["Lead", "cto", "Strat", "research"]));
    expect(screen.queryByRole("button", { name: /^Team/ })).toBeNull();
    expect(within(teamList()).queryByText("Team")).toBeNull();
  });

  it("draws no disclosure on a teammate, and none of its sessions in the column", async () => {
    // THE MUTANT: the per-teammate chevron and the nested session tree back in the sidebar.
    const { container } = await mount();
    await screen.findByRole("button", { name: /^cto/ });
    for (const row of container.querySelectorAll(".sb-teammate")) {
      expect(row.querySelector(".sb-caret, [aria-expanded]"), row.textContent ?? "").toBeNull();
      expect(row.querySelectorAll("button")).toHaveLength(1);
    }
    expect(screen.queryByRole("button", { name: /sessions$/ })).toBeNull();
    // A teammate's task sessions are in neither the team nor the Sessions list.
    expect(screen.queryByText("cto - sqlite search")).toBeNull();
    expect(screen.queryByText("design - icon")).toBeNull();
    const sessions = screen.getByRole("group", { name: "Sessions" });
    expect([...sessions.querySelectorAll(".item-title")].map((t) => t.textContent)).toEqual(["Alpha"]);
  });

  it("says each teammate's state in words on its accessible name, and never in a tooltip", async () => {
    // THE mutant: the sentence back as the row's title, so hovering a name already on screen covers
    // the row under it with "cto — working".
    await mount();
    const cto = await screen.findByRole("button", { name: "cto — working — on cto - sqlite search" });
    expect(cto).not.toHaveAttribute("title");
    expect(cto).toHaveAttribute("data-tip", "clipped");
    expect(cto.querySelector("[data-tip-text]")!.textContent).toBe("cto");
    expect(screen.getByRole("button", { name: "research — needs you" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lead, the Lead" })).toBeInTheDocument();
  });

  it("wears its state in the age's slot: a spinner while it works, the amber dot while it needs you, else its age", async () => {
    const now = Date.now();
    await mount({ sessions: [...team().sessions!, session("home-lead", "s1", { title: "Lead", teammateId: "lead", teammateHome: true, activityAt: now - 3 * 3_600_000 })] });
    const trail = async (name: RegExp) => (await screen.findByRole("button", { name })).querySelector(".item-trail")!;
    expect((await trail(/^cto/)).querySelector(".spinner")).not.toBeNull();
    expect((await trail(/^cto/)).querySelector(".status-dot")).toBeNull();
    expect((await trail(/^research/)).querySelector(".status-dot")).toHaveAttribute("data-status", "waiting_permission");
    expect((await trail(/^research/)).querySelector(".spinner")).toBeNull();
    await waitFor(async () => expect((await trail(/^Lead/)).textContent).toBe("3h"));
  });

  it("bolds a teammate with something unread, and no other", async () => {
    await mount({ teammates: [teammate("lead", "s1", { name: "Lead", lead: true, unread: true }), teammate("cto", "s1", { name: "cto" })] });
    const row = async (name: RegExp) => (await screen.findByRole("button", { name })).closest(".sb-row")!;
    expect(await row(/^Lead/)).toHaveAttribute("data-unread");
    expect(await row(/^cto/)).not.toHaveAttribute("data-unread");
    expect(screen.getByRole("button", { name: /^Lead/ })).toHaveAccessibleName("Lead, the Lead — unread");
  });

  it("folds a group the person made, and remembers it", async () => {
    const { store, api } = await mount();
    fireEvent.click(await screen.findByRole("button", { name: /^Strat, 1 teammate, 1 needs you/ }));
    await waitFor(() => expect(titles()).toEqual(["Lead", "cto", "Strat"]));
    expect(store.getState().teamGroupsFolded).toEqual(["s1/Strat"]);
    expect(api.calls).toContain("setSetting:ui.sidebarTeamGroupsFolded=s1/Strat");
  });

  it("renames a group from its caption's menu, moving every teammate in it", async () => {
    // THE MUTANT: a rename that moves only the first member, splitting the group in two.
    const { api } = await mount({ teammates: [...team().teammates!, teammate("ops", "s1", { name: "ops", group: "Strat", sortOrder: 3 })] });
    fireEvent.contextMenu(await screen.findByRole("button", { name: /^Strat,/ }), { clientX: 40, clientY: 200 });
    fireEvent.click(within(await screen.findByRole("menu", { name: "Strat" })).getByRole("menuitem", { name: "Rename group…" }));
    const input = await screen.findByRole("textbox", { name: "Rename the group Strat" });
    fireEvent.change(input, { target: { value: "Ship" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.calls.some((c) => c.startsWith("teammatesReorder:"))).toBe(true));
    const order = JSON.parse(api.calls.find((c) => c.startsWith("teammatesReorder:"))!.slice("teammatesReorder:".length));
    expect(order.filter((o: { group: string | null }) => o.group === "Ship").map((o: { id: string }) => o.id).sort()).toEqual(["ops", "research"]);
    expect(order.some((o: { group: string | null }) => o.group === "Strat")).toBe(false);
  });

  it("makes a group from a teammate's own menu: Edit… opens its sheet, where Group names one", async () => {
    // The sheet's Group field is where a group is made; the row's menu has to reach it.
    const { store } = await mount();
    fireEvent.contextMenu(await screen.findByRole("button", { name: /^cto — working/ }), { clientX: 40, clientY: 200 });
    fireEvent.click(within(await screen.findByRole("menu", { name: "cto" })).getByRole("menuitem", { name: "Edit…" }));
    await waitFor(() => expect(store.getState().sheet).toEqual({ kind: "teammate", spaceId: "s1", id: "cto" }));
  });

  it("opens a teammate onto its chat, with its computer beside it the first time", async () => {
    const { store, api } = await mount();
    fireEvent.click(await screen.findByRole("button", { name: /^cto — working/ }));
    await waitFor(() => expect(api.calls).toContain("createItem:s1|computer|cto"));
    expect(store.getState().layout && JSON.stringify(store.getState().layout)).toContain("i-home-cto");
  });

  it("moves a teammate dragged onto a group's head into that group, keeping everyone else's order", async () => {
    const { api } = await mount();
    const row = (await screen.findByRole("button", { name: /^cto — working/ })).closest(".sb-teammate")!;
    const group = screen.getByRole("button", { name: /^Strat,/ }).closest(".sb-team-group")!;
    const dataTransfer = { setData: () => {}, effectAllowed: "" };
    fireEvent.dragStart(row, { dataTransfer });
    fireEvent.dragOver(group, { dataTransfer });
    fireEvent.drop(group, { dataTransfer });
    await waitFor(() => expect(api.calls.some((c) => c.startsWith("teammatesReorder:"))).toBe(true));
    const order = JSON.parse(api.calls.find((c) => c.startsWith("teammatesReorder:"))!.slice("teammatesReorder:".length));
    expect(order).toEqual([{ id: "lead", group: null }, { id: "research", group: "Strat" }, { id: "cto", group: "Strat" }]);
  });

  it("offers the first teammate from an empty space, beside a new session", async () => {
    const { store } = await mount({ items: { s1: [] }, sessions: [], teammates: [] });
    fireEvent.click(await screen.findByRole("button", { name: "Add a teammate" }));
    expect(store.getState().sheet).toEqual({ kind: "teammate", spaceId: "s1" });
  });
});

describe("pinned teammates", () => {
  const pinnedTeam = (over: FakeData = {}) => team({
    items: { s1: [sessionItem("mine", "Alpha"), sessionItem("home-cto", "cto", { pinned: true }), sessionItem("home-lead", "Lead", { pinned: true })] },
    ...over,
  });

  it("stand as a row of icons over the list, the Lead first, and leave the team list", async () => {
    // THE MUTANTS: pinned teammates as full rows; the Lead in pin order; a pinned teammate listed twice.
    const { container } = await mount(pinnedTeam());
    const pinned = await screen.findByRole("region", { name: "Pinned" });
    await waitFor(() => expect([...pinned.querySelectorAll(".sb-mate-name")].map((n) => n.textContent)).toEqual(["Lead", "cto"]));
    expect(titles()).toEqual(["Strat", "research"]);
    expect(container.querySelector(".sb-pinned .sb-row")).toBeNull();
    // Its state rides the tile, said in words.
    const cto = within(pinned).getByRole("button", { name: "cto — working" });
    expect(cto.querySelector(".spinner")).not.toBeNull();
    // …and not in a tooltip, which the tile has only while its name is cut short.
    expect(cto).not.toHaveAttribute("title");
    expect(cto).toHaveAttribute("data-tip", "clipped");
    expect(cto.querySelector("[data-tip-text]")!.textContent).toBe("cto");
  });

  it("pins and unpins from a teammate's own menu", async () => {
    const { api } = await mount();
    fireEvent.contextMenu(await screen.findByRole("button", { name: /^cto — working/ }), { clientX: 40, clientY: 200 });
    fireEvent.click(within(await screen.findByRole("menu", { name: "cto" })).getByRole("menuitem", { name: "Pin" }));
    await waitFor(() => expect(api.data.items.s1!.find((i) => i.id === "i-home-cto")!.pinned).toBe(true));
    const pinned = await screen.findByRole("region", { name: "Pinned" });
    await exited();
    fireEvent.contextMenu(await within(pinned).findByRole("button", { name: "cto — working" }), { clientX: 40, clientY: 100 });
    fireEvent.click(within(await screen.findByRole("menu", { name: "cto" })).getByRole("menuitem", { name: "Unpin" }));
    await waitFor(() => expect(api.data.items.s1!.find((i) => i.id === "i-home-cto")!.pinned).toBe(false));
  });
});
