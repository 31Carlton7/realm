import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Item } from "@realm/contracts";
import { Sidebar } from "./Sidebar";
import { NeedsYou } from "./NeedsYou";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, profile, session, space, teamReview, teamRole, teamSpace, type FakeData } from "../../state/store.test-fakes";

/**
 * A team inside its space's section (the Teams plan, 13.3): the Review row only while something
 * waits, a Team row that folds to its roles — each a Realmite, a name and a state mark, never a time —
 * and each waiting review a Needs you row. Every test names the change that would make it fail.
 */

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const sessionItem = (id: string, spaceId: string, title: string, extra: Partial<Item> = {}) =>
  item(`i-${id}`, spaceId, { kind: "session", refId: id, title, ...extra });

const manager = teamRole("r1", "s1", "Creator Manager", { state: "working", stateSince: 1, nextRunAt: Date.now() + 3_600_000, cron: "0 9 * * 1-5", scheduleEnabled: true, latestSessionId: "run1" });
const producer = teamRole("r2", "s1", "Content Producer", { nextRunAt: Date.now() + 86_400_000, cron: "0 9 * * 1,4", scheduleEnabled: true });

function home(over: { reviews?: ReturnType<typeof teamReview>[]; roles?: ReturnType<typeof teamRole>[] } = {}): FakeData {
  return {
    profiles: [profile("p1", "Work")],
    spaces: [space("s1", "p1", "Versed"), space("s2", "p1", "Homework")],
    items: {
      s1: [sessionItem("a", "s1", "Paywall redesign"), sessionItem("run1", "s1", "Creator Manager")],
      s2: [sessionItem("b", "s2", "Essay")],
    },
    sessions: [session("a", "s1", { title: "Paywall redesign" }), session("run1", "s1", { title: "Creator Manager", status: "running", dispatchedBy: { kind: "run", sessionId: null } }), session("b", "s2", { title: "Essay" })],
    teams: [teamSpace("s1", over.roles ?? [manager, producer], over.reviews ?? [], { runSessionIds: ["run1"] })],
  };
}

async function mount(data: FakeData, what: "sidebar" | "needs" = "sidebar") {
  const api = fakeApi(data);
  const store = createAppStore(api);
  await store.getState().boot();
  await store.getState().refreshTeams();
  await store.getState().refreshAllItems();
  render(<StoreContext.Provider value={store}>{what === "sidebar" ? <Sidebar /> : <NeedsYou />}</StoreContext.Provider>);
  if (what === "sidebar") await waitFor(() => expect(api.calls).toContain("listAllItems"));
  return { api, store };
}

const section = (name: string) => screen.getByRole("region", { name });
const titles = (name: string) => [...section(name).querySelectorAll(".sb-section-clip .item-title")].map((t) => t.textContent);

describe("a team in its space's section", () => {
  it("has no Review row while nothing waits, and one with the count while something does", async () => {
    // THE MUTANT: a Review row drawn always — a row of chrome for an inbox that is usually empty.
    await mount(home());
    expect(titles("Versed")).not.toContain("Review");
    cleanup();
    await mount(home({ reviews: [teamReview("v1", "s1", "6 slideshows for Nathan"), teamReview("v2", "s1", "Email to Nathan", { kind: "message" }), teamReview("v3", "s1", "Old", { state: "approved" })] }));
    const review = within(section("Versed")).getByRole("button", { name: "Review — 2 waiting on you" });
    expect(review.querySelector(".item-count")).toHaveTextContent("2");
    expect(review.querySelector('.status-dot[data-status="waiting_permission"]')).not.toBeNull();
    // Review heads the section, then the team, then the sessions.
    expect(titles("Versed").slice(0, 4)).toEqual(["Review", "Team", "Creator Manager", "Content Producer"]);
  });

  it("counts waiting reviews in the space's own tally", async () => {
    // THE MUTANT: the head's tally leaves Review out, so a folded Versed says nothing waits on you.
    await mount(home({ reviews: [teamReview("v1", "s1", "6 slideshows"), teamReview("v2", "s1", "Email")] }));
    const head = within(section("Versed")).getByRole("button", { name: /^Versed —/ });
    expect(head.getAttribute("aria-label")).toContain("2 waiting on you");
  });

  it("draws a role as its Realmite, its name and its state mark — never a time", async () => {
    // THE MUTANTS: the next run's time in the trail (it ellipsized the name in the first mock), or a
    // glyph where the Realmite goes.
    await mount(home());
    const row = within(section("Versed")).getByRole("button", { name: "Creator Manager — working" });
    expect(row.querySelector(".sb-gutter svg")).not.toBeNull();
    const trail = row.querySelector(".item-trail")!;
    expect(trail.textContent).toBe("");
    expect(trail.querySelector('.status-dot[data-status="running"]')).not.toBeNull();
    // Idle says nothing at the far end; the next run is in the tooltip.
    const idle = within(section("Versed")).getByRole("button", { name: /^Content Producer — / });
    expect(idle.querySelector(".item-trail")!.childElementCount).toBe(0);
    expect(idle.getAttribute("title")).toMatch(/Next run/);
  });

  it("folds the Team row to its tally, and remembers it", async () => {
    // THE MUTANT: a fold that is component state, so the next window opens it again.
    const { api } = await mount(home());
    const team = within(section("Versed")).getByRole("button", { name: /^Team — 2 roles, 1 running/ });
    expect(team).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(team);
    await waitFor(() => expect(team).toHaveAttribute("aria-expanded", "false"));
    expect(api.calls.some((c) => c.startsWith("setSetting:ui.sidebarTeamFolded="))).toBe(true);
  });

  it("leaves a role's run sessions to the role — they are not session rows", async () => {
    // THE MUTANT: the run's session listed beside the sessions the person started.
    await mount(home());
    // "Creator Manager" is the role's row, once — not also its run's session row.
    expect(titles("Versed").filter((t) => t === "Creator Manager")).toHaveLength(1);
    expect(titles("Versed")).toEqual(["Team", "Creator Manager", "Content Producer", "Add teammate", "Paywall redesign"]);
  });
});

describe("Needs you", () => {
  it("lists each waiting review with its space, and opens the space's Review pane on it", async () => {
    // THE MUTANTS: reviews left out of Needs you, or a click that opens something other than Review.
    const { api, store } = await mount(home({ reviews: [teamReview("v1", "s1", "6 slideshows for Nathan", { roleName: "Content Producer" })] }), "needs");
    const row = within(screen.getByRole("region", { name: "Needs you" })).getByRole("button", { name: /^6 slideshows for Nathan in Versed, from Content Producer — waiting for your review/ });
    expect(row.querySelector(".item-where")).toHaveTextContent("Versed");
    fireEvent.click(row);
    await waitFor(() => expect(api.calls.some((c) => c === "createItem:s1|review|s1")).toBe(true));
    expect(store.getState().teamReviewSelected["s1"]).toBe("v1");
  });
});
