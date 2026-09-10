import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PAGE_REF_IDS, type Session } from "@realm/contracts";
import { AgentsPage, ago, groupAgents } from "./AgentsPage";
import { createAppStore, StoreContext } from "../../state/store";
import { fakeApi, item, session, space } from "../../state/store.test-fakes";

afterEach(() => cleanup());

const row = (id: string, spaceId: string, over: Partial<Session> = {}) =>
  session(id, spaceId, { title: `Session ${id}`, ...over });

describe("groupAgents", () => {
  it("groups by the LIVE status, in the order a manager wants attention, newest first within a group", () => {
    /* The mutant: read `s.status` off the row. The row is what the server had when the list was
       fetched, and a session that finished since would sit under Working forever. */
    const rows = [
      row("a", "s1", { status: "idle", updatedAt: 1 }),
      row("b", "s1", { status: "running", updatedAt: 5 }),
      row("c", "s2", { status: "running", updatedAt: 9 }),
      row("d", "s2", { status: "idle", updatedAt: 3 }),
    ];
    const groups = groupAgents(rows, { a: "waiting_permission", b: "running", c: "running", d: "idle" });
    expect(groups.map((g) => [g.state.label, g.rows.map((r) => r.id)])).toEqual([
      ["Needs you", ["a"]], ["Working", ["c", "b"]], ["Ready", ["d"]],
    ]);
  });

  it("skips empty groups rather than drawing an empty heading", () => {
    expect(groupAgents([row("a", "s1", { status: "error" })], {}).map((g) => g.state.label)).toEqual(["Failed"]);
  });

  it("says how long ago in the units a person would", () => {
    const now = 1_000_000_000;
    expect(ago(now - 20_000, now)).toBe("now");
    expect(ago(now - 5 * 60_000, now)).toBe("5m");
    expect(ago(now - 3 * 3_600_000, now)).toBe("3h");
    expect(ago(now - 26 * 3_600_000, now)).toBe("yesterday");
    expect(ago(now - 4 * 86_400_000, now)).toBe("4d");
  });
});

describe("the Agents page", () => {
  async function mount() {
    const api = fakeApi({
      spaces: [space("s1", "p1", "Versed"), space("s2", "p1", "Plynn")],
      sessions: [
        row("se1", "s1", { status: "waiting_permission", cwd: "/Users/me/versed", model: "claude-opus-5", updatedAt: 9 }),
        row("se2", "s2", { status: "running", cwd: "/Users/me/plynn", agentKind: "codex", updatedAt: 5 }),
      ],
    });
    const store = createAppStore(api); await store.getState().boot();
    render(<StoreContext.Provider value={store}>
      <AgentsPage item={item("pg", "s1", { kind: "agents-page", refId: PAGE_REF_IDS["agents-page"], title: "Agents" })} visible />
    </StoreContext.Provider>);
    return { api, store };
  }

  it("lists every session across every space under its state, with where and on what it runs", async () => {
    await mount();
    const needs = await screen.findByRole("region", { name: "Needs you" });
    expect(within(needs).getByRole("button", { name: /Session se1/ })).toHaveTextContent("Versed");
    expect(within(needs).getByRole("button", { name: /Session se1/ })).toHaveTextContent("versed");
    expect(within(needs).getByRole("button", { name: /Session se1/ })).toHaveTextContent("claude-opus-5");
    const working = screen.getByRole("region", { name: "Working" });
    expect(within(working).getByRole("button", { name: /Session se2/ })).toHaveTextContent("Plynn");
    expect(screen.getByText("1 waiting on you")).toBeInTheDocument();
  });

  it("folds history: Ready past eight rows, Ended entirely, each behind one line that opens it", async () => {
    /* A real home had 225 finished sessions; a page whose point is "what needs me" cannot open
       onto a wall of them. The mutant: render every row of every group. */
    const rows = Array.from({ length: 12 }, (_, i) => row(`r${i}`, "s1", { status: "idle", updatedAt: 100 - i }));
    const ended = [row("e1", "s1", { status: "ended" }), row("e2", "s1", { status: "ended" })];
    const api = fakeApi({ spaces: [space("s1", "p1", "Versed")], sessions: [...rows, ...ended] });
    const store = createAppStore(api); await store.getState().boot();
    render(<StoreContext.Provider value={store}>
      <AgentsPage item={item("pg", "s1", { kind: "agents-page", refId: PAGE_REF_IDS["agents-page"], title: "Agents" })} visible />
    </StoreContext.Provider>);
    const ready = await screen.findByRole("region", { name: "Ready" });
    expect(within(ready).getAllByRole("button", { name: /Session r/ })).toHaveLength(8);
    fireEvent.click(within(ready).getByRole("button", { name: "4 more" }));
    expect(within(ready).getAllByRole("button", { name: /Session r/ })).toHaveLength(12);
    const endedGroup = screen.getByRole("region", { name: "Ended" });
    expect(within(endedGroup).queryAllByRole("button", { name: /Session e/ })).toHaveLength(0);
    fireEvent.click(within(endedGroup).getByRole("button", { name: "Show 2" }));
    expect(within(endedGroup).getAllByRole("button", { name: /Session e/ })).toHaveLength(2);
  });

  it("a row goes to its session, switching space when it has to", async () => {
    const { store } = await mount();
    fireEvent.click(await screen.findByRole("button", { name: /Session se2/ }));
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s2"));
  });

  it("re-reads the list when a status changes, so a finished agent moves groups without a reload", async () => {
    const { store } = await mount();
    await screen.findByRole("region", { name: "Needs you" });
    store.setState({ sessionStatus: { ...store.getState().sessionStatus, se1: "idle" } });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull());
    expect(screen.getByRole("region", { name: "Ready" })).toBeInTheDocument();
  });
});
