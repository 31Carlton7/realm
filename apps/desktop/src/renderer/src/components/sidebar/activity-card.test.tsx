import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import type { Environment, Session, Space } from "@realm/contracts";
import { Sidebar } from "./Sidebar";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, profile, session, space } from "../../state/store.test-fakes";
import { stampTitle } from "../../panes/session/timestamps";

/**
 * The Activity view's cards (the owner, 10-12): the space's icon and name with how long ago the
 * session moved over its title, the state at the title's far end, and the worktree under it when
 * there is one. Every test names the one-line change that would make it fail.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = new Date(2026, 9, 12, 15, 0, 0).getTime();

const chat = (id: string, spaceId: string, at: number, over: Partial<Session> = {}): Session =>
  session(id, spaceId, { title: `chat ${id}`, activityAt: at, createdAt: at, ...over });

const env = (id: string, spaceId: string, over: Partial<Environment> = {}): Environment =>
  ({ id, spaceId, path: `/tmp/${id}`, branch: null, kind: "primary", portBlockStart: null, createdAt: 0, updatedAt: 0, ...over });

async function mount(sessions: Session[], extra: { spaces?: Space[]; environments?: Record<string, Environment[]>; pinned?: string[] } = {}) {
  const spaces = extra.spaces ?? [space("s1", "p1", "Work"), space("s2", "p1", "Homework", { icon: "emoji:🎓" })];
  const items: Record<string, ReturnType<typeof item>[]> = {};
  for (const s of sessions) (items[s.spaceId] ??= []).push(item(`i-${s.id}`, s.spaceId, { kind: "session", refId: s.id, title: s.title, pinned: extra.pinned?.includes(s.id) ?? false }));
  const api = fakeApi({ profiles: [profile("p1", "Work")], spaces, items, sessions, environments: extra.environments ?? {}, settings: { "ui.sidebarLens": "recent" } });
  const store = createAppStore(api);
  await store.getState().boot();
  const r = render(<StoreContext.Provider value={store}><Sidebar /></StoreContext.Provider>);
  await waitFor(() => expect(api.calls).toContain("listAllItems"));
  return { api, store, ...r };
}

/** The card whose title is `title`. */
async function card(container: HTMLElement, title: string): Promise<HTMLElement> {
  return waitFor(() => {
    const found = [...container.querySelectorAll<HTMLElement>(".sb-recent .sb-card")].find((c) => c.querySelector(".item-title")?.textContent === title);
    expect(found).toBeTruthy();
    return found!;
  });
}
const lines = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>(".item-row > .sb-card-line")];
const stateOf = (c: HTMLElement) => lines(c)[1]!.querySelector(".item-trail > .status-dot")?.getAttribute("data-status") ?? null;

afterEach(() => { cleanup(); vi.useRealTimers(); });

/** Only `Date` is faked: `waitFor` keeps its real timers, and every card reads the same instant. */
const clock = { at(now: number) { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now); } };

describe("an Activity card", () => {
  it("is two lines: the space and the time over the title, and nothing more for a session in the space's folder", async () => {
    // THE MUTANT: the foot drawn for any checkout (`env ?` for `env?.kind === "worktree"`) — every card a line taller to say "Work".
    clock.at(NOW);
    const { container } = await mount([chat("a", "s1", NOW - 5 * MIN, { environmentId: "e1" })], { environments: { s1: [env("e1", "s1")] } });
    const c = await card(container, "chat a");
    expect(lines(c)).toHaveLength(2);
    expect(lines(c)[0]).toHaveTextContent("Work");
    expect(lines(c)[0]!.querySelector(".sb-card-when")).toHaveTextContent("5m");
  });

  it("names the worktree a session works in on a third line, by its branch", async () => {
    // THE MUTANT: no foot at all (`branch && …` dropped).
    clock.at(NOW);
    const { container } = await mount([chat("a", "s1", NOW, { environmentId: "wt" })],
      { environments: { s1: [env("wt", "s1", { kind: "worktree", branch: "realm/fix-update-crash", path: "/tmp/wt-fix" })] } });
    const c = await card(container, "chat a");
    await waitFor(() => expect(lines(c)).toHaveLength(3));
    expect(lines(c)[2]).toHaveTextContent("realm/fix-update-crash");
    expect(lines(c)[2]!.querySelector("svg")).not.toBeNull();
  });

  it("draws the space's own icon, an emoji included", async () => {
    // THE MUTANT: a fixed folder glyph for every space (`icon="folder"`).
    clock.at(NOW);
    const { container } = await mount([chat("a", "s2", NOW)]);
    const c = await card(container, "chat a");
    expect(within(lines(c)[0]!).getByRole("img", { name: "icon" })).toHaveTextContent("🎓");
  });

  it("wears running, needs you and failed at the title's far end, apart from the time", async () => {
    // THE MUTANT: the state's dot dropped from the card (`{mark && …}` removed).
    clock.at(NOW);
    const { container } = await mount([
      chat("run", "s1", NOW - 1000, { status: "running" }),
      chat("ask", "s1", NOW - 2000, { status: "waiting_permission" }),
      chat("bad", "s1", NOW - 3000, { status: "error" }),
      chat("calm", "s1", NOW - 4000),
    ]);
    expect(stateOf(await card(container, "chat run"))).toBe("running");
    expect(stateOf(await card(container, "chat ask"))).toBe("waiting_permission");
    expect(stateOf(await card(container, "chat bad"))).toBe("error");
    expect(stateOf(await card(container, "chat calm"))).toBeNull();
    // And said in words, not by colour alone.
    expect((await card(container, "chat bad")).querySelector(".item-row")!.getAttribute("aria-label")).toBe("chat bad in Work — error");
  });

  it("marks a turn finished while you were away: the blue dot and the title lifted", async () => {
    // THE MUTANT: `data-unread` left off the card — the dot alone, the half that leans on hue.
    clock.at(NOW);
    const { container } = await mount([chat("new", "s1", NOW, { seenSeq: 2, lastEventSeq: 5 }), chat("old", "s1", NOW - 1000, { seenSeq: 5, lastEventSeq: 5 })]);
    const fresh = await card(container, "chat new");
    expect(stateOf(fresh)).toBe("unseen");
    expect(fresh).toHaveAttribute("data-unread");
    expect(await card(container, "chat old")).not.toHaveAttribute("data-unread");
  });

  it("says a schedule started it with a clock beside the time", async () => {
    // THE MUTANT: the clock dropped (`row.scheduled && …` removed).
    clock.at(NOW);
    const { container } = await mount([chat("cron", "s1", NOW, { dispatchedBy: { kind: "run", sessionId: null } }), chat("hand", "s1", NOW - 1000)]);
    expect(lines(await card(container, "chat cron"))[0]!.querySelector('[title="Started by a schedule"] svg')).not.toBeNull();
    expect(lines(await card(container, "chat hand"))[0]!.querySelector('[title="Started by a schedule"]')).toBeNull();
  });

  it("counts the sub-agents waiting on you beside the lead's state", async () => {
    // THE MUTANT: the count dropped (`row.agentsWaiting > 0 && …` removed).
    clock.at(NOW);
    const kid = (id: string) => chat(id, "s1", NOW - 5000, { status: "waiting_permission", dispatchedBy: { kind: "agent_run", sessionId: "lead" } });
    const { container } = await mount([chat("lead", "s1", NOW, { status: "running" }), kid("k1"), kid("k2")]);
    const c = await card(container, "chat lead");
    await waitFor(() => expect(lines(c)[1]!.querySelector(".item-tally .item-count")).toHaveTextContent("2"));
    expect(stateOf(c)).toBe("running");
  });

  it("names the agent only where it is not the space's usual one", async () => {
    // THE MUTANT: every card names its agent (`kind !== usual` dropped).
    clock.at(NOW);
    const { container } = await mount([chat("a", "s1", NOW), chat("b", "s1", NOW - 1000), chat("c", "s1", NOW - 2000, { agentKind: "codex" })]);
    expect(lines(await card(container, "chat c"))[0]!.querySelector('[title="Codex"]')).not.toBeNull();
    expect(lines(await card(container, "chat a"))[0]!.querySelectorAll(".sb-card-marks > span")).toHaveLength(0);
  });

  it("marks a pinned session with a pin", async () => {
    // THE MUTANT: the pin dropped (`row.item.pinned && …` removed).
    clock.at(NOW);
    const { container } = await mount([chat("a", "s1", NOW), chat("b", "s1", NOW - 1000)], { pinned: ["a"] });
    expect(lines(await card(container, "chat a"))[0]!.querySelector('[title="Pinned"]')).not.toBeNull();
    expect(lines(await card(container, "chat b"))[0]!.querySelector('[title="Pinned"]')).toBeNull();
  });
});

describe("an Activity card's time", () => {
  const when = async (ago: number) => {
    clock.at(NOW);
    const { container } = await mount([chat("a", "s1", NOW - ago, { createdAt: NOW - 400 * 24 * HOUR })]);
    const c = await card(container, "chat a");
    const t = c.querySelector<HTMLElement>(".sb-card-when")!;
    const said = t.textContent;
    cleanup();
    return { said, t };
  };

  it("counts from when the conversation last moved, not when it was made", async () => {
    // THE MUTANT: `createdAt` for `at` — every card a year old.
    expect((await when(3 * MIN)).said).toBe("3m");
  });

  it("says now under a minute, and minutes, hours and days at their boundaries", async () => {
    // THE MUTANTS: a rounding (rather than flooring) count, or `<=` at a boundary — "1m" at 59 s,
    // "60m" at an hour, "24h" at a day.
    const cases: [number, string][] = [
      [0, "now"], [59_000, "now"], [MIN, "1m"], [59 * MIN + 59_000, "59m"], [HOUR, "1h"],
      [23 * HOUR + 59 * MIN, "23h"], [24 * HOUR, "1d"], [13 * 24 * HOUR, "13d"],
    ];
    for (const [ago, said] of cases) expect([ago, (await when(ago)).said]).toEqual([ago, said]);
  });

  it("gives the full moment in its tooltip", async () => {
    // THE MUTANT: the tooltip dropped from `CardWhen`.
    const { t } = await when(2 * HOUR);
    expect(t.getAttribute("title")).toBe(stampTitle(NOW - 2 * HOUR));
  });
});
