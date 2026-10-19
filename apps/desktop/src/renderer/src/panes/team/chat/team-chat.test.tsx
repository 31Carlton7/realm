import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import type { RoleRun } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../../state/store";
import { fakeApi, profile, space, teamReview, teamRole, teamSpace, type FakeData } from "../../../state/store.test-fakes";
import { TeamPage, TeamRailList } from "../TeamPages";
import { chatPreview, landingRole } from "./chat-format";
import { headLine, sendsOn } from "./TeamChat";

/**
 * The team as a messenger: a chat per teammate in the column, the open one with its head, thread and
 * prompter. Each test names the change that would make it fail.
 */

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const NOW = Date.now();
const run = (id: string, roleId: string, extra: Partial<RoleRun> = {}): RoleRun => ({
  id, roleId, state: "succeeded", wokeOn: "manual", wokeNote: null, wokeBy: null, sessionId: `ses-${id}`,
  createdAt: NOW - 120_000, startedAt: NOW - 120_000, settledAt: NOW - 60_000, costUsd: 0.4, summary: null, report: null, error: null,
  stoppedAtCap: null, reviewId: null, reviewState: null, ...extra,
});

const researcher = teamRole("r1", "s1", "Researcher", { template: "researcher", lastRunAt: NOW - 120_000 });
const editor = teamRole("r2", "s1", "Ava", { template: "editor", state: "working", stateSince: NOW - 240_000, lastRunAt: NOW - 240_000 });
const ops = teamRole("r3", "s1", "Ops", { template: "ops", unread: true, lastRunAt: NOW - 30_000 });
// Sent after the run's report: what the row says is the draft waiting, not the report before it.
const draft = teamReview("v1", "s1", "Launch brief", { roleId: "r1", roleName: "Researcher", runId: "a", createdAt: NOW - 50_000, updatedAt: NOW - 50_000 });

const base = (extra: Partial<FakeData> = {}): FakeData => ({
  profiles: [profile("p1", "Work")],
  spaces: [space("s1", "p1", "Versed")],
  // A copy each time: the fake's decide writes the state onto the summary it holds.
  teams: [teamSpace("s1", [researcher, editor, ops], [{ ...draft }])],
  teamRoleRuns: {
    r1: [run("a", "r1", { wokeNote: "find three sources", report: "Found **three** sources on the launch.", reviewId: "v1", reviewState: "waiting" })],
    r2: [run("b", "r2", { state: "running", settledAt: null, wokeNote: "check the numbers" })],
    r3: [run("c", "r3", { report: "Two invoices are due Friday.", settledAt: NOW - 30_000 })],
  },
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

describe("the team's chats in the column", () => {
  it("a row per teammate: its name, the starter it was made from, the newest line, and what it is doing", async () => {
    await mount(base(), <TeamRailList spaceId="s1" team={base().teams![0]!} tab="role:r1" pick={() => undefined} />);
    const chats = screen.getByRole("group", { name: "Chats" });
    // Once every chat's runs are read: Ops' report is in its row.
    const rows = await waitFor(() => {
      const r = within(chats).getAllByRole("radio");
      expect(r[2]!.closest("label")).toHaveTextContent("Two invoices are due Friday.");
      return r;
    });
    expect(rows[0]!.closest("label")).toHaveTextContent("Sent “Launch brief” for your yes");
    expect(rows.map((r) => r.closest("label")!.querySelector(".tc-chat-name")!.textContent)).toEqual(["Researcher", "Ava", "Ops"]);
    // Ava is an Editor by template, and says so beside her name; Researcher's name already does.
    expect(rows[1]!.closest("label")!.querySelector(".tc-chat-kind")).toHaveTextContent("Editor");
    expect(rows[0]!.closest("label")!.querySelector(".tc-chat-kind")).toBeNull();
    // THE MUTANT: the preview reading the last report while a draft waits — the row that needs you
    // would look like any other.
    expect(rows[0]!.closest("label")!.querySelector(".status-dot")).toHaveAttribute("data-status", "waiting_permission");
    expect(rows[1]!.closest("label")).toHaveTextContent("Working…");
    expect(rows[2]!.closest("label")).toHaveAttribute("data-unread");
    expect(rows[2]!.closest("label")).toHaveTextContent("Two invoices are due Friday.");
    expect(rows[0]).toBeChecked();
  });

  it("is one radio group of its own, so the arrows go from chat to chat and a pick opens that chat", async () => {
    const picked: string[] = [];
    await mount(base(), <TeamRailList spaceId="s1" team={base().teams![0]!} tab="role:r1" pick={(t) => picked.push(t)} />);
    const rows = within(screen.getByRole("group", { name: "Chats" })).getAllByRole("radio");
    // THE MUTANT: the chats sharing the team pages' group — ↓ from the last chat would land on Overview.
    expect(new Set(rows.map((r) => r.getAttribute("name"))).size).toBe(1);
    expect(rows[0]!.getAttribute("name")).not.toBe(within(screen.getByRole("group", { name: "Team" })).getAllByRole("radio")[0]!.getAttribute("name"));
    fireEvent.click(rows[2]!);
    expect(picked).toEqual(["role:r3"]);
  });

  it("opens the team on the chat that needs you, then one that is working, then the newest", () => {
    const team = base().teams![0]!;
    expect(landingRole(team)?.id).toBe("r1");
    expect(landingRole({ ...team, reviews: [] })?.id).toBe("r2");
    expect(landingRole({ roles: [researcher, ops], reviews: [] })?.id).toBe("r3");
    expect(landingRole({ roles: [], reviews: [] })).toBeNull();
  });

  it("says a run's question, a queued message and a teammate's job in the preview", () => {
    const asks = run("q", "r1", { state: "blocked", settledAt: null, report: "Two are due.\nNEEDS-HUMAN: Which creator first?" });
    expect(chatPreview({ ...researcher, state: "waiting" }, [asks], [])).toMatchObject({ text: "Asks: Which creator first?", tone: "needs" });
    expect(chatPreview(researcher, [run("q", "r1", { state: "queued", wokeNote: "after that" })], [])).toMatchObject({ text: "You: after that", tone: "you" });
    expect(chatPreview(researcher, [], []).text).toBe("Looks things up when you ask, and sends back a short brief with its sources.");
    expect(chatPreview(researcher, [run("x", "r1", { report: "## Summary\nFound it." })], []).text).toBe("Summary");
    expect(chatPreview(researcher, [run("x", "r1", { state: "cancelled", stoppedAtCap: "usd", wokeNote: "pull every number" })], []).text).toBe("Stopped at its dollar limit");
  });
});

describe("a teammate's chat", () => {
  it("heads the chat with its Realmite, name, starter, state and next run, and draws the thread under it", async () => {
    await mount(base(), <TeamPage spaceId="s1" tab="role:r1" />);
    expect(screen.getByRole("heading", { name: "Researcher" })).toBeInTheDocument();
    const thread = await screen.findByText("find three sources");
    expect(thread.closest(".tc-row")).toHaveAttribute("data-side", "you");
    // The report is the transcript's own Markdown, not plain text.
    expect(screen.getByText("three", { selector: "strong" }).closest(".tc-row")).toHaveAttribute("data-side", "them");
    expect(screen.getByText("Launch brief").closest(".tc-draft")).not.toBeNull();
  });

  it("lands on the chat that needs you when the team is opened, and says Ava is working with three dots", async () => {
    await mount(base(), <TeamPage spaceId="s1" tab="team" />);
    expect(screen.getByRole("heading", { name: "Researcher" })).toBeInTheDocument();
    cleanup();
    await mount(base(), <TeamPage spaceId="s1" tab="role:r2" />);
    expect(await screen.findByRole("status", { name: "Ava is working" })).toBeInTheDocument();
    expect(screen.getByText(/Ava is working\. Your message goes when this run ends\./)).toBeInTheDocument();
  });

  it("sends what is typed to the teammate on Return, and keeps a new line on ⇧Return", async () => {
    const { api } = await mount(base(), <TeamPage spaceId="s1" tab="role:r1" />);
    const field = screen.getByRole("textbox", { name: "Message Researcher" });
    expect(field).toHaveAttribute("placeholder", "Message Researcher…");
    fireEvent.change(field, { target: { value: "and a fourth?" } });
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    expect(api.calls.some((c) => c.startsWith("teamRoleMessage"))).toBe(false);
    fireEvent.keyDown(field, { key: "Enter" });
    // THE MUTANT: the chat reusing Run now's path — a run that forgets the conversation.
    await waitFor(() => expect(api.calls).toContain("teamRoleMessage:r1:and a fourth?"));
    expect(field).toHaveValue("");
  });

  it("approves a draft in place through Review's own action, and opens it in Review", async () => {
    const { api, store } = await mount(base({ teamReviews: { v1: { ...draft, items: [], previous: [], costUsd: null, durationMs: null, runCapUsd: null, model: null, recordName: null, checks: [], ledger: [], root: null, tickets: [] } } }),
      <TeamPage spaceId="s1" tab="role:r1" />);
    const card = (await screen.findByText("Launch brief")).closest(".tc-draft") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(api.calls).toContain("teamReviewDecide:v1:approve"));
    fireEvent.click(within(card).getByRole("button", { name: "Open in Review" }));
    // The store's own way into Review: the space's Review pane, on this draft.
    await waitFor(() => expect(api.calls).toContain("createItem:s1|review|s1"));
    expect(store.getState().teamReviewSelected.s1).toBe("v1");
  });

  it("Send back puts the draft in the prompter's head, and what is sent is the changes asked for it", async () => {
    const { api } = await mount(base({ teamReviews: { v1: { ...draft, items: [], previous: [], costUsd: null, durationMs: null, runCapUsd: null, model: null, recordName: null, checks: [], ledger: [], root: null, tickets: [] } } }),
      <TeamPage spaceId="s1" tab="role:r1" />);
    const card = (await screen.findByText("Launch brief")).closest(".tc-draft") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Send back" }));
    const field = screen.getByRole("textbox", { name: "What should change in Launch brief" });
    expect(field).toHaveFocus();
    fireEvent.change(field, { target: { value: "Shorter, please." } });
    fireEvent.click(screen.getByRole("button", { name: "Send it back" }));
    // THE MUTANT: the note sent as an ordinary message — the draft would wait on as if unanswered.
    await waitFor(() => expect(api.calls).toContain("teamReviewRequestChanges:v1:Shorter, please."));
    expect(api.calls.some((c) => c.startsWith("teamRoleMessage"))).toBe(false);
  });

  it("an empty chat says who the teammate is and what a message does", async () => {
    await mount(base({ teamRoleRuns: { r1: [] }, teams: [teamSpace("s1", [{ ...researcher, cron: "0 9 * * 1-5" }])] }), <TeamPage spaceId="s1" tab="role:r1" />);
    expect(await screen.findByText("Looks things up when you ask, and sends back a short brief with its sources.")).toBeInTheDocument();
    expect(screen.getByText(/A message starts a run with your words and its brief\. It also wakes every weekday at 9:00/)).toBeInTheDocument();
  });

  it("a team with nobody left on it offers the way back", async () => {
    await mount(base({ teams: [teamSpace("s1", [])] }), <TeamPage spaceId="s1" tab="team" />);
    expect(screen.getByText("No one is on this team")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add teammate" })).toBeInTheDocument();
  });
});

describe("the chat's words and keys", () => {
  it("sends on ⌘Return always, on Return only when that is the setting, and never mid-composition", () => {
    const key = (o: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; composing: boolean }> = {}) =>
      ({ key: "Enter", metaKey: !!o.metaKey, ctrlKey: !!o.ctrlKey, shiftKey: !!o.shiftKey, altKey: !!o.altKey, nativeEvent: { isComposing: !!o.composing } });
    expect(sendsOn(key(), "enter")).toBe(true);
    // THE MUTANT: Return sending under ⌘Return — the prompter's setting ignored.
    expect(sendsOn(key(), "cmdEnter")).toBe(false);
    expect(sendsOn(key({ metaKey: true }), "cmdEnter")).toBe(true);
    expect(sendsOn(key({ shiftKey: true }), "enter")).toBe(false);
    expect(sendsOn(key({ composing: true }), "enter")).toBe(false);
  });

  it("heads a chat with the starter, what it is doing, and when its clock next runs", () => {
    const at9 = new Date(NOW); at9.setDate(at9.getDate() + 1); at9.setHours(9, 0, 0, 0);
    const next = { ...researcher, cron: "0 9 * * 1-5", scheduleEnabled: true, nextRunAt: at9.getTime() };
    expect(headLine(next, NOW)).toMatch(/^Next run \w+ 9:00\sAM$/);
    expect(headLine({ ...editor, stateSince: NOW - 240_000 }, NOW)).toBe("Editor · Working · 4m");
    expect(headLine(researcher, NOW)).toBe("Runs when you message it");
    expect(headLine({ ...researcher, state: "paused", pausedWhy: "the team has spent its $60 for this week" }, NOW)).toBe("Paused · the team has spent its $60 for this week");
  });
});
