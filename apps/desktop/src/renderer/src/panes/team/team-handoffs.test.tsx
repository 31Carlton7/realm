import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import type { TeamHandoff } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, profile, space, teamRole, teamSpace, type FakeData } from "../../state/store.test-fakes";
import { TeamPage } from "./TeamPages";
import { mentionOptions, mentionRows, refFor } from "../session/mention-sources";

/**
 * Phase 4 on the team's pages: who a role hands work to, its goal, the budgets and run caps, the
 * handoff lines with each Realmite wearing its role's state, an engine's back-off, and teammates in
 * the prompter's `@` list. Each test names the change that would make it fail.
 */

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const producer = teamRole("r1", "s1", "Content Producer", { template: "content-producer", handsOffTo: ["r2"] });
const manager = teamRole("r2", "s1", "Creator Manager", { template: "creator-manager", state: "working", weekBudgetUsd: 20, weekSpendUsd: 17 });
const handoff: TeamHandoff = {
  id: "h1", spaceId: "s1", kind: "handoff", fromRoleId: "r1", fromSessionId: "se1", toRoleId: "r2", recordPath: "creators/nathan-beyenhof.md",
  note: "Six slides done; draft the message.", files: ["deck/01.png"], runId: "run1", sessionId: "se2", state: "working", costUsd: null, createdAt: Date.now(), settledAt: null,
};

const base = (extra: Partial<FakeData> = {}): FakeData => ({
  profiles: [profile("p1", "Work")],
  spaces: [space("s1", "p1", "Versed")],
  teams: [teamSpace("s1", [producer, manager], [], { handoffs: [handoff] })],
  ...extra,
});

async function mount(data: FakeData, ui: ReactNode) {
  const api = fakeApi(data);
  const store = createAppStore(api);
  await store.getState().boot();
  await store.getState().refreshTeams();
  render(<StoreContext.Provider value={store}>{ui}</StoreContext.Provider>);
  return { api, store };
}

/** A teammate's chat with its details drawer open — where the role page's settings live now. */
async function details(data: FakeData, roleId: string) {
  const mounted = await mount(data, <TeamPage spaceId="s1" tab={`role:${roleId}`} />);
  const name = data.teams![0]!.roles.find((r) => r.id === roleId)!.name;
  fireEvent.click(screen.getByRole("button", { name: `${name}, in detail` }));
  return { ...mounted, drawer: screen.getByRole("complementary", { name: `${name}, in detail` }) };
}

describe("a teammate's details", () => {
  it("lists the team's other roles as switches, the ones it hands to pressed, and a press sends the new edges", async () => {
    const { api } = await details(base(), "r2");
    const group = screen.getByRole("group", { name: "Roles Creator Manager hands off to" });
    const cp = within(group).getByRole("button", { name: "Content Producer" });
    expect(cp).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(cp);
    // THE MUTANT: the press replaces the list instead of adding to it, or sends nothing.
    await waitFor(() => expect(api.calls).toContain("teamRoleHandoffs:r2:r1:"));
  });

  it("a press adds to the roles it already hands to, and a second press takes one away", async () => {
    const editor = teamRole("r3", "s1", "Editor");
    const { api } = await details(base({ teams: [teamSpace("s1", [producer, manager, editor])] }), "r1");
    const group = screen.getByRole("group", { name: "Roles Content Producer hands off to" });
    expect(within(group).getByRole("button", { name: "Creator Manager" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(group).getByRole("button", { name: "Editor" }));
    await waitFor(() => expect(api.calls).toContain("teamRoleHandoffs:r1:r2,r3:"));
  });

  it("shows a handoff it made in its chat, the receiver's Realmite wearing its role's state", async () => {
    const run = { id: "run0", roleId: "r1", state: "succeeded" as const, wokeOn: "manual" as const, wokeNote: "pass it on", wokeBy: null, sessionId: "se1",
      createdAt: Date.now() - 60_000, startedAt: Date.now() - 60_000, settledAt: Date.now() - 1_000, costUsd: null, summary: null, report: "Handed over.", error: null,
      stoppedAtCap: null, reviewId: null, reviewState: null };
    await mount(base({ teamRoleRuns: { r1: [run] } }), <TeamPage spaceId="s1" tab="role:r1" />);
    const card = (await screen.findByText("Handed work to Creator Manager")).closest(".tc-card")!;
    expect(card).toHaveTextContent("“Six slides done; draft the message.”");
    expect(card).toHaveTextContent("creators/nathan-beyenhof.md · 1 file");
    expect(within(card as HTMLElement).getByText("Working")).toHaveClass("tp-chip");
    // THE MUTANT: the receiving Realmite drawn without its state — a working role shown at rest.
    expect(card.querySelector("[data-state='working']")).not.toBeNull();
  });

  it("edits its week and run caps in place, and says the week is nearly spent in orange", async () => {
    const { api } = await details(base(), "r2");
    expect(screen.getByRole("meter", { name: "Spent this week" })).toHaveAttribute("data-high");
    const row = screen.getByText("Budget", { selector: ".settings-row-name" }).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Creator Manager's run limit, in dollars"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Creator Manager's run limit, in minutes"), { target: { value: "30" } });
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.calls).toContain("teamRoleUpdate:r2"));
    expect(api.data.teams[0]!.roles[1]).toMatchObject({ runCapUsd: 5, runCapMs: 1_800_000, weekBudgetUsd: 20 });
  });

  it("offers a goal, and a mention switch", async () => {
    await details(base(), "r2");
    fireEvent.click(screen.getByRole("button", { name: "Give Creator Manager a goal…" }));
    expect(screen.getByLabelText("A goal for Creator Manager")).toHaveFocus();
    expect(screen.getByRole("switch", { name: "When someone @mentions it, on" })).toBeChecked();
  });

  it("a live goal shows its objective and where the loop stands, and offers no second one", async () => {
    const working = { ...manager, goal: { runId: "run9", sessionId: "se9", objective: "Keep every record current", status: "active" as const, turns: 3, note: null, startedAt: 0 } };
    const { drawer } = await details(base({ teams: [teamSpace("s1", [producer, working])] }), "r2");
    expect(within(drawer).getByText("Keep every record current")).toBeInTheDocument();
    expect(screen.getByText("Working toward it · 3 turns")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /a goal…/ })).toBeNull();
  });
});

describe("the team's overview", () => {
  it("says an engine's back-off and until when, and Try now lifts it", async () => {
    const until = Date.now() + 3_600_000;
    const { api } = await mount(base({ teams: [teamSpace("s1", [producer, manager], [], {
      limits: { teamMaxLive: 2, realmMaxUnattended: 3, teamRunning: 1, realmRunning: 2, teamQueued: 1, backoff: [{ agentKind: "claude", until, why: "Claude reported its plan limit", since: 0 }] },
    })] }), <TeamPage spaceId="s1" tab="overview" />);
    expect(screen.getByRole("status")).toHaveTextContent("Claude reported its plan limit. Team runs on it wait until");
    // The plan-limit protection, surfaced where the budget is.
    expect(screen.getByText(/1 of 2 running for this team · 2 of 3 unattended across Realm · 1 waiting for a slot/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try now" }));
    await waitFor(() => expect(api.calls).toContain("teamLiftBackoff:claude"));
  });

  it("changes how many runs go at once from the Budget section", async () => {
    const { api } = await mount(base(), <TeamPage spaceId="s1" tab="overview" />);
    fireEvent.change(screen.getByLabelText("Unattended runs at once across Realm"), { target: { value: "2" } });
    await waitFor(() => expect(api.calls).toContain("teamSetLimits:s1::2"));
  });

  it("edits the team's week", async () => {
    const { api } = await mount(base(), <TeamPage spaceId="s1" tab="overview" />);
    const row = screen.getByText("The team's week").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("The team's week, in dollars"), { target: { value: "80" } });
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.calls).toContain("teamSetBudget:s1:80"));
  });
});

describe("teammates in the @ list", () => {
  const opts = (roles = [producer, manager]) => mentionOptions({ mac: null, skills: [], files: [], cwd: "/w", library: [], apps: [], roles });

  it("lists a team's roles first under Team, and a pick names the role", () => {
    const rows = mentionRows(opts(), "");
    expect(rows[0]).toMatchObject({ kind: "role", name: "Content Producer", head: "Team" });
    expect(refFor(rows[1]!)).toEqual({ kind: "role", roleId: "r2" });
    expect(mentionRows(opts(), "creator")[0]).toMatchObject({ kind: "role", name: "Creator Manager", detail: expect.stringMatching(/^Teammate · Starts as a sub-agent/) });
  });

  it("leaves out a role set not to wake on a mention", () => {
    // THE MUTANT: every role offered — a chip the server will only refuse.
    expect(opts([producer, { ...manager, wakeOnMention: false }]).map((o) => o.name)).toEqual(["Content Producer"]);
  });
});
