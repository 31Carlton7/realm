import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { sessionEvent, sessionLink, type SessionStatus, type TeammateTaskSession } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session, space, profile, teammate, type FakeData } from "../../state/store.test-fakes";
import { PanelBar } from "../../components/PanelBar";
import { SessionPane } from "../session/SessionPane";
import { renderMarkdown } from "../session/Markdown";
import { reduceAll } from "../session/transcript-model";
import { mentionOptions, mentionRows, refFor } from "../session/mention-sources";
import { ComputerPane } from "./ComputerPane";
import { TeammateSheet } from "./TeammateSheet";
import { commandKind, dayLabel, groupTeammates, plainTitle, sessionTree, teammateMark, todayLine } from "./teammate-model";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const ID = (n: number) => `01ARZ3NDEKTSV4RRFFQ69G5T${String(n).padStart(2, "0")}`;
const task = (id: string, extra: Partial<TeammateTaskSession> = {}): TeammateTaskSession =>
  ({ id, title: id, teammateId: "cto", parentId: null, state: "idle", updatedAt: 0, unread: false, ...extra });
const sessionItem = (id: string, title: string) => item(`i-${id}`, "s1", { kind: "session", refId: id, title });

describe("teammate-model", () => {
  it("says a teammate's state as the session rows do, needs-you first, and unread only when nothing else is", () => {
    // THE MUTANTS: a working dot for a teammate waiting on you; an unread ring hiding that it works.
    expect(teammateMark("needs-you", true)?.mark).toBe("waiting_permission");
    expect(teammateMark("working", true)?.mark).toBe("running");
    expect(teammateMark("idle", true)?.mark).toBe("unseen");
    expect(teammateMark("idle", false)).toBeNull();
  });

  it("nests what was handed on under the session that asked, newest first, and counts it", () => {
    const tree = sessionTree([
      task("a", { updatedAt: 10 }), task("b", { updatedAt: 30 }),
      task("a1", { parentId: "a", updatedAt: 20 }), task("a2", { parentId: "a", updatedAt: 25 }), task("a1x", { parentId: "a1", updatedAt: 21 }),
      task("orphan", { parentId: "gone", updatedAt: 5 }),
    ]);
    expect(tree.map((n) => `${n.session.id}:${n.depth}:${n.handoffs}`)).toEqual(["b:0:0", "a:0:2", "a2:1:0", "a1:1:1", "a1x:2:0", "orphan:0:0"]);
  });

  it("puts the ungrouped first and each group where its first teammate stands", () => {
    const g = groupTeammates([teammate("lead", "s1", { lead: true }), teammate("r", "s1", { group: "Strat" }), teammate("cto", "s1"), teammate("d", "s1", { group: "Strat" })]);
    expect(g.top.map((t) => t.id)).toEqual(["lead", "cto"]);
    expect(g.groups).toEqual([["Strat", [expect.objectContaining({ id: "r" }), expect.objectContaining({ id: "d" })]]]);
  });

  it("takes only a teammate's own handle off a title", () => {
    // THE MUTANTS: any "word - " prefix taken off; the prefix kept.
    expect(plainTitle("captain - ship 2.7.3", ["captain", "engines"])).toBe("ship 2.7.3");
    expect(plainTitle("engines - move - part 2", ["captain", "engines"])).toBe("move - part 2");
    expect(plainTitle("v2 - the plan", ["captain"])).toBe("v2 - the plan");
  });

  it("names a day as today, yesterday or its date, by the calendar rather than 24 hours", () => {
    const now = new Date(2026, 10, 4, 0, 30).getTime();
    expect(dayLabel(new Date(2026, 10, 4, 0, 5).getTime(), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 10, 3, 23, 50).getTime(), now)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 10, 1, 12).getTime(), now)).not.toMatch(/Today|Yesterday/);
  });

  it("counts only today's outcomes in the head, and says nothing when there are none", () => {
    const now = Date.now();
    expect(todayLine([task("a", { updatedAt: now, outcome: { kind: "pr", number: 1, url: null, merged: true } }),
      task("b", { updatedAt: now, outcome: { kind: "pr", number: 2, url: null, merged: true } }),
      task("c", { updatedAt: now - 3 * 86_400_000, outcome: { kind: "pr", number: 3, url: null, merged: true } })], now)).toBe("Today: 2 PRs merged");
    expect(todayLine([task("a", { updatedAt: now, outcome: null })], now)).toBeNull();
  });

  it("reads a build or a dev server off a terminal's command", () => {
    expect(commandKind("pnpm build")).toBe("build");
    expect(commandKind("next dev -p 3000")).toBe("server");
    expect(commandKind("pnpm vitest")).toBe("terminal");
  });
});

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
    teammate("cto", "s1", { name: "cto", brief: "You own the architecture.\nMore.", state: "working", homeSessionId: "home-cto", sortOrder: 0,
      icon: { shape: "hexagon", color: "blue" }, liveTask: "cto - sqlite search",
      taskSessions: [task("t1", { title: "cto - sqlite search", state: "working", updatedAt: 20 }), task("t2", { title: "design - icon", teammateId: "design", parentId: "t1", updatedAt: 10 })] }),
    teammate("lead", "s1", { name: "Lead", lead: true, sortOrder: 5, homeSessionId: "home-lead" }),
    teammate("research", "s1", { name: "research", group: "Strat", state: "needs-you", sortOrder: 2 }),
  ],
  ...over,
});

async function mountChat(t = reduceAll([])) {
  const api = fakeApi(team());
  const store = createAppStore(api); await store.getState().boot();
  await act(() => store.getState().refreshTeammates());
  store.setState({ sessionStatus: { "home-cto": "idle" }, transcripts: { "home-cto": { lastSeq: 2, t } } });
  const homeItem = item("i-home-cto", "s1", { kind: "session", refId: "home-cto", title: "cto" });
  const r = render(<StoreContext.Provider value={store}>
    <PanelBar item={homeItem} leafId="leaf" onClose={() => {}} />
    <SessionPane item={homeItem} visible />
  </StoreContext.Provider>);
  return { api, store, ...r };
}

describe("a teammate's page", () => {
  it("is headed by the teammate, prompts by its name, and is edited rather than renamed", async () => {
    await mountChat();
    const bar = document.querySelector(".panel-bar")!;
    expect(bar.querySelector(".tm-head-name")).toHaveTextContent("cto");
    expect(bar.querySelector(".tm-head-role")).toHaveTextContent("You own the architecture.");
    expect(bar.querySelector(".panel-crumb, .panel-title")).toBeNull();
    expect(await screen.findByPlaceholderText("Message cto")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pane menu for cto" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /Edit…/ })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /Make Lead/ })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /Archive/ })).toBeInTheDocument();
    // THE MUTANT: Rename or Delete on a teammate's chat, which would orphan it from the teammate.
    expect(within(menu).queryByRole("menuitem", { name: /^Rename/ })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: /^Delete/ })).toBeNull();
  });

  it("draws a message another teammate sent as that teammate talking, not as the person's bubble", async () => {
    await mountChat(reduceAll([
      sessionEvent("user_message", { text: "From @lead: Can you take the **icon**?", attachments: [], from: { sessionId: "home-lead", title: "@lead", teammateId: "lead" } }),
    ]));
    const row = document.querySelector(".msg-teammate-row")!;
    // THE MUTANTS: the person's right-hand bubble; the server's "From @lead:" left in the words.
    expect(document.querySelector(".msg-user-row")).toBeNull();
    expect(row.querySelector(".msg-user")).toBeNull();
    expect(row.querySelector(".msg-teammate-head")).toHaveTextContent("Lead");
    expect(row.querySelector(".msg-teammate-head svg[data-shape]")).not.toBeNull();
    expect(row.querySelector(".msg-assistant")!.textContent!.trim()).toBe("Can you take the icon?");
    expect(row.querySelector(".msg-assistant strong")).toHaveTextContent("icon");
  });

  it("keeps the prompter on \"Message <name>\" after a reply, with no suggestion over it", async () => {
    await mountChat(reduceAll([
      sessionEvent("user_message", { text: "Status?", attachments: [] }),
      sessionEvent("assistant_text", { messageId: "m", text: "All green." }),
    ]));
    expect(await screen.findByPlaceholderText("Message cto")).toBeInTheDocument();
    expect(document.querySelector('[id^="prompt-hint-"]')).toBeNull();
  });

  it("opens a session it links to beside it", async () => {
    const id = ID(7);
    const { store } = await mountChat(reduceAll([
      sessionEvent("assistant_text", { messageId: "m", text: `Started [cto - sqlite search](${sessionLink(id)}).` }),
    ]));
    const peekSession = vi.fn(async () => true);
    store.setState({ peekSession });
    const chip = await waitFor(() => { const a = document.querySelector<HTMLAnchorElement>(`a[data-session="${id}"]`); if (!a) throw new Error("no chip"); return a; });
    expect(chip).toHaveTextContent("cto - sqlite search");
    expect(chip.getAttribute("target")).toBeNull();
    fireEvent.click(chip);
    await waitFor(() => expect(peekSession).toHaveBeenCalledWith(id));
  });
});

describe("a teammate's clock", () => {
  it("is set from the sheet with Schedule a task's rows, and says when it next checks in", async () => {
    const api = fakeApi(team());
    const store = createAppStore(api); await store.getState().boot();
    await act(() => store.getState().refreshTeammates());
    render(<StoreContext.Provider value={store}><TeammateSheet spaceId="s1" id="cto" /></StoreContext.Provider>);
    fireEvent.click(screen.getByRole("switch", { name: "Check in on a schedule" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Repeat" }), { target: { value: "weekdays" } });
    fireEvent.change(screen.getByRole("textbox", { name: "What it is told" }), { target: { value: "Check the overnight builds." } });
    expect(screen.getByText(/^Next check-in /)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.calls.some((c) => c.startsWith("teammateUpdate:cto:"))).toBe(true));
    const sent = JSON.parse(api.calls.find((c) => c.startsWith("teammateUpdate:cto:"))!.slice("teammateUpdate:cto:".length));
    expect(sent.schedule).toEqual({ cron: "0 9 * * 1-5", prompt: "Check the overnight builds.", enabled: true });
  });

  it("pauses a clock it had when switched off, keeping its cadence", async () => {
    const schedule = { id: ID(9), cron: "0 9 * * 1", prompt: "Weekly review.", enabled: true, nextRunAt: null, lastRunAt: null, lastSkippedAt: null };
    const api = fakeApi(team({ teammates: [teammate("cto", "s1", { name: "cto", schedule })] }));
    const store = createAppStore(api); await store.getState().boot();
    await act(() => store.getState().refreshTeammates());
    render(<StoreContext.Provider value={store}><TeammateSheet spaceId="s1" id="cto" /></StoreContext.Provider>);
    expect(screen.getByRole("combobox", { name: "Repeat" })).toHaveValue("weekly");
    fireEvent.click(screen.getByRole("switch", { name: "Check in on a schedule" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.calls.some((c) => c.startsWith("teammateUpdate:cto:"))).toBe(true));
    expect(JSON.parse(api.calls.find((c) => c.startsWith("teammateUpdate:cto:"))!.slice("teammateUpdate:cto:".length)).schedule).toEqual({ enabled: false });
  });

  it("writes into the chat quietly, as the clock and when, never as the person", async () => {
    const ts = new Date(2026, 10, 2, 9, 0).getTime();
    await mountChat(reduceAll([{ ...sessionEvent("user_message", { text: "Do your scheduled work.", attachments: [],
      scheduled: { task: "cto", note: "[Realm] Your schedule sent this", scheduleId: ID(9) } }), ts }]));
    const line = document.querySelector(".msg-user-row .msg-user-from")!;
    expect(line.textContent).toMatch(/^Scheduled · Mon 9:00/);
    expect(document.querySelector(".msg-user-row .msg-user")).toHaveTextContent("Do your scheduled work.");
  });
});

describe("a session link in prose", () => {
  it("survives sanitizing only for a session, and any other realm: link is dropped", () => {
    const html = renderMarkdown(`[a](${sessionLink(ID(1))}) and [b](realm://settings/x)`);
    expect(html).toContain(`data-session="${ID(1)}"`);
    expect(html).not.toContain("realm://settings");
  });
});

/** The Lead's chat, with its transcript set to `t`. */
async function mountLeadChat(t: ReturnType<typeof reduceAll>) {
  const api = fakeApi(team());
  const store = createAppStore(api); await store.getState().boot();
  await act(() => store.getState().refreshTeammates());
  const openTeammate = vi.fn(async () => {});
  store.setState({ openTeammate, sessionStatus: { "home-lead": "running" }, transcripts: { "home-lead": { lastSeq: 9, t } } });
  const leadItem = item("i-home-lead", "s1", { kind: "session", refId: "home-lead", title: "Lead" });
  const r = render(<StoreContext.Provider value={store}><SessionPane item={leadItem} visible /></StoreContext.Provider>);
  return { store, openTeammate, ...r };
}

const call = (id: string, to: string, message: string, ts: number) =>
  sessionEvent("tool_call", { toolUseId: id, name: "mcp__realm__realm-team__team_message", input: { to, message }, parentToolUseId: null }, ts);
const sent = (id: string, to: string, ts: number) =>
  sessionEvent("tool_result", { toolUseId: id, content: `Sent to @${to}. You are not waiting for it — carry on.`, isError: false }, ts);
const callRow = (id: string) => document.querySelector(`.teammate-call[data-tool-use-id="${id}"]`)!;

describe("a message to a teammate in the sender's transcript", () => {
  const T0 = 1_700_000_000_000;
  const events = [
    sessionEvent("user_message", { text: "Get the search shipped.", attachments: [] }, T0),
    call("c1", "@cto", "From @lead: Index the docs folder.", T0 + 1), sent("c1", "cto", T0 + 2),
    call("r1", "research", "Which engines are in use?", T0 + 3), sent("r1", "research", T0 + 4),
    call("c2", "cto", "And the notes folder too.", T0 + 5), sent("c2", "cto", T0 + 6),
  ];

  it("draws the teammate it went to, what it was asked and what it is doing now", async () => {
    await mountLeadChat(reduceAll(events));
    const cto = callRow("c2");
    expect(cto.querySelector(".tool-name")).toHaveTextContent("cto");
    expect(cto.querySelector(".teammate-call-handle")).toHaveTextContent("@cto");
    expect(cto.querySelector("svg[data-shape]")).toHaveAttribute("data-shape", "hexagon");
    expect(cto.querySelector(".delegation-line-task")).toHaveTextContent("And the notes folder too.");
    // THE MUTANTS: a generic tool card; a state that is not the teammate's own (cto works, research needs you).
    expect(document.querySelector(".tool-card:not(.teammate-call)")).toBeNull();
    expect(cto).toHaveAttribute("data-state", "working");
    expect(cto.querySelector(".delegation-line-time")).toHaveTextContent("Working");
    expect(callRow("r1")).toHaveAttribute("data-state", "needs-you");
    expect(callRow("r1").querySelector(".delegation-line-time")).toHaveTextContent("Needs you");
    // THE MUTANT: an older message to cto claiming the work cto is doing on the newer one.
    expect(callRow("c1")).toHaveAttribute("data-state", "done");
    // THE MUTANT: the sender's own "From @lead:" left in front of what it asked.
    expect(callRow("c1").querySelector(".delegation-line-task")).toHaveTextContent(/^Index the docs folder\.$/);
  });

  it("says Done once the teammate's turn has ended", async () => {
    const { store } = await mountLeadChat(reduceAll(events));
    act(() => store.setState({ teammates: { s1: store.getState().teammates.s1!.map((t) => (t.id === "cto" ? { ...t, state: "idle" as const } : t)) } }));
    expect(callRow("c2")).toHaveAttribute("data-state", "done");
    expect(callRow("c2").querySelector(".delegation-line-time")).toHaveTextContent("Done");
  });

  it("opens the teammate's chat on a click", async () => {
    const { openTeammate } = await mountLeadChat(reduceAll(events));
    fireEvent.click(within(callRow("r1") as HTMLElement).getByRole("button", { name: /^research, Needs you/ }));
    await waitFor(() => expect(openTeammate).toHaveBeenCalledWith("research"));
  });

  it("draws a reply that repeats its own \"From @x:\" as that teammate, without either", async () => {
    await mountLeadChat(reduceAll([
      sessionEvent("user_message", { text: "From @cto: From @cto: got both.", attachments: [], from: { sessionId: "home-cto", title: "@cto", teammateId: "cto" } }, T0),
    ]));
    const row = document.querySelector(".msg-teammate-row")!;
    expect(row.querySelector(".msg-teammate-head")).toHaveTextContent("cto");
    expect(row.querySelector(".msg-teammate-head svg[data-shape]")).toHaveAttribute("data-shape", "hexagon");
    expect(row.querySelector(".msg-assistant")!.textContent!.trim()).toBe("got both.");
  });
});

describe("@ in a prompter", () => {
  it("names a teammate by its handle, matches its name too, and passes the message to it", () => {
    const cto = teammate("cto-id", "s1", { handle: "cto", name: "Chief technologist", brief: "Owns the stack." });
    const opts = mentionOptions({ mac: null, skills: [], files: [], cwd: "/tmp", library: [], apps: [], teammates: [cto] });
    const rows = mentionRows(opts, "chief", { accessibility: null });
    expect(rows[0]).toMatchObject({ kind: "role", name: "cto", detail: "Teammate · Gets the message · Owns the stack." });
    expect(refFor(rows[0]!)).toEqual({ kind: "role", roleId: "cto-id" });
  });
});

describe("a teammate's computer", () => {
  async function mountComputer(over: FakeData = {}) {
    const api = fakeApi(team(over));
    const store = createAppStore(api); await store.getState().boot();
    await act(() => store.getState().refreshTeammates());
    const r = render(<StoreContext.Provider value={store}><ComputerPane item={item("i-comp", "s1", { kind: "computer", refId: "cto", title: "Computer" })} visible /></StoreContext.Provider>);
    return { api, store, ...r };
  }

  it("says in words what is working, and lists the work without its handle", async () => {
    const { api } = await mountComputer();
    await waitFor(() => expect(api.calls).toContain("teammateSessions:cto"));
    expect(document.querySelector(".tm-headline")).toHaveTextContent("1 session working");
    // THE MUTANT: the "cto - " prefix left on the title the icon already says.
    expect(document.querySelector(".tm-now .tm-session-title")).toHaveTextContent(/^sqlite search$/);
  });

  it("stops everything it is running, its chat and its live sessions, and says how many", async () => {
    const { api } = await mountComputer({ sessions: [
      session("home-cto", "s1", { title: "cto", teammateId: "cto", teammateHome: true, status: "running" }),
      session("t1", "s1", { title: "cto - sqlite search", teammateId: "cto", status: "running" }),
    ] });
    await waitFor(() => expect(api.calls).toContain("teammateSessions:cto"));
    fireEvent.click(screen.getByRole("button", { name: "Stop 2 sessions" }));
    // THE MUTANT: Stop on the chat alone, leaving the session it started running.
    await waitFor(() => expect(api.calls.filter((c) => c.startsWith("interrupt:")).sort()).toEqual(["interrupt:home-cto", "interrupt:t1"]));
  });
});

describe("a teammate's work, on its computer", () => {
  const DAY = 86_400_000;
  const now = Date.now();
  /** cto's work: one waiting on you, two working, and finished work over three days with outcomes and a hand-off. */
  const work = () => [
    task("old", { title: "cto - quiet labels", updatedAt: now - 3 * DAY }),
    task("mid", { title: "cto - move sheet P1", updatedAt: now - DAY, outcome: { kind: "pr", number: 257, url: null, merged: true } }),
    task("child", { title: "design - move notices", teammateId: "design", parentId: "mid", unread: true, updatedAt: now - 2000 }),
    task("live", { title: "cto - space rail tiles", state: "working", updatedAt: now - 60_000 }),
    task("live2", { title: "cto - type ladder", state: "working", updatedAt: now - 120_000 }),
    task("wait", { title: "cto - light mode depth", state: "needs-you", updatedAt: now - 3000 }),
    task("shipped", { title: "cto - ship 2.7.2", updatedAt: now - 5000, outcome: { kind: "release", tag: "v2.7.2" } }),
    task("pr", { title: "cto - land #264", unread: true, updatedAt: now - 6000, outcome: { kind: "pr", number: 264, url: "https://github.com/a/b/pull/264", merged: false } }),
    task("broke", { title: "cto - sign + publish", updatedAt: now - 7000, outcome: { kind: "failed", reason: "Notarization keychain item missing" } }),
    task("plain", { title: "cto - tidy", updatedAt: now - 8000, outcome: null }),
  ];

  async function mount(tasks: TeammateTaskSession[], over: FakeData = {}, homeStatus: SessionStatus = "idle") {
    const cto = teammate("cto", "s1", { name: "cto", handle: "cto", homeSessionId: "home-cto", taskSessions: tasks, icon: { shape: "hexagon", color: "blue" } });
    const design = teammate("design", "s1", { name: "design", handle: "design", icon: { shape: "cloud", color: "pink" } });
    const api = fakeApi(team({
      teammates: [cto, design],
      items: { s1: [sessionItem("home-cto", "cto"), ...tasks.map((t) => sessionItem(t.id, t.title))] },
      sessions: [session("home-cto", "s1", { title: "cto", teammateId: "cto", teammateHome: true, status: homeStatus }), ...tasks.map((t) => session(t.id, "s1", { title: t.title, teammateId: t.teammateId }))],
      ...over,
    }));
    const store = createAppStore(api); await store.getState().boot();
    await act(() => store.getState().refreshTeammates());
    render(<StoreContext.Provider value={store}><ComputerPane item={item("i-comp", "s1", { kind: "computer", refId: "cto", title: "Computer" })} visible /></StoreContext.Provider>);
    await waitFor(() => expect(api.calls).toContain("teammateSessions:cto"));
    return { api, store, cto };
  }
  const nowRows = () => [...document.querySelectorAll<HTMLElement>(".tm-now > li")];
  const doneRows = () => [...document.querySelectorAll<HTMLElement>(".tm-day .tm-sessions > li")];
  const doneRow = (title: string) => doneRows().find((r) => r.querySelector(".tm-session-title")?.textContent === title)!;

  it("heads the report with what is working, what needs you, and what today came to", async () => {
    await mount(work());
    // THE MUTANTS: needs-you counted as working; a count off the wrong state; today's outcomes left out or yesterday's let in.
    expect(document.querySelector(".tm-headline")).toHaveTextContent("2 sessions working · 1 needs you");
    expect(document.querySelector(".tm-needs")).toHaveTextContent("1 needs you");
    expect(screen.getByText(/^Today:/)).toHaveTextContent("Today: 1 PR opened · v2.7.2 shipped · 1 failed");
    expect(screen.getByRole("button", { name: "Stop 3 sessions" })).toBeInTheDocument();
  });

  const interrupted = (api: { calls: string[] }) => api.calls.filter((c) => c.startsWith("interrupt:")).sort();

  it("names how many of the working sessions Stop stops when some are another teammate's", async () => {
    const { api } = await mount([
      task("live", { title: "cto - space rail tiles", state: "working", updatedAt: now - 60_000 }),
      task("child", { title: "design - move notices", teammateId: "design", parentId: "live", state: "working", updatedAt: now - 2000 }),
    ]);
    // THE MUTANTS: the label counting only cto's own while the head counts both; the click reaching
    // the hand-off on design, or the idle chat, which the label does not name.
    expect(document.querySelector(".tm-headline")).toHaveTextContent("2 sessions working");
    fireEvent.click(screen.getByRole("button", { name: "Stop 1 of 2 sessions" }));
    await waitFor(() => expect(interrupted(api)).toEqual(["interrupt:live"]));
  });

  it("stops every working session when all are its own, and only those", async () => {
    const { api } = await mount([
      task("live", { title: "cto - space rail tiles", state: "working", updatedAt: now - 60_000 }),
      task("live2", { title: "cto - type ladder", state: "working", updatedAt: now - 120_000 }),
    ]);
    expect(document.querySelector(".tm-headline")).toHaveTextContent("2 sessions working");
    fireEvent.click(screen.getByRole("button", { name: "Stop 2 sessions" }));
    await waitFor(() => expect(interrupted(api)).toEqual(["interrupt:live", "interrupt:live2"]));
  });

  it("counts its chat as working when only the chat runs, and stops just the chat", async () => {
    const { api } = await mount([task("old", { title: "cto - quiet labels", updatedAt: now - DAY })], {}, "running");
    // THE MUTANT: the head saying nothing runs while Stop offers to stop one.
    expect(document.querySelector(".tm-headline")).toHaveTextContent("1 session working");
    fireEvent.click(screen.getByRole("button", { name: "Stop 1 session" }));
    await waitFor(() => expect(interrupted(api)).toEqual(["interrupt:home-cto"]));
  });

  it("puts the session that needs you first in Now, with Answer, then the working ones with a spinner", async () => {
    const { store } = await mount(work());
    // THE MUTANT: Now in list order, so the one waiting on you sits under the work.
    expect(nowRows().map((r) => r.querySelector(".tm-session-title")!.textContent)).toEqual(["light mode depth", "space rail tiles", "type ladder"]);
    expect(nowRows()[0]!.querySelector(".spinner")).toBeNull();
    expect(nowRows()[1]!.querySelector(".spinner")).not.toBeNull();
    expect(document.querySelectorAll(".tm-computer .status-dot")).toHaveLength(1);
    const revealSession = vi.fn(async () => true);
    act(() => store.setState({ revealSession }));
    fireEvent.click(within(nowRows()[0]!).getByRole("button", { name: "Answer" }));
    // THE MUTANT: Answer that opens the teammate's chat instead of the session holding the question.
    await waitFor(() => expect(revealSession).toHaveBeenCalledWith("wait", "s1"));
  });

  it("shows a working session's current step from what it was last seen doing", async () => {
    const { store } = await mount(work());
    act(() => store.setState({ sessionActivity: { live: { text: "pnpm vitest run", icon: "terminal", ts: now } } }));
    expect(nowRows()[1]!.querySelector(".tm-step")).toHaveTextContent("pnpm vitest run");
    expect(nowRows()[2]!.querySelector(".tm-step")).toBeNull();
  });

  it("groups Done by day, newest first, with a hand-off under the session that asked", async () => {
    await mount(work());
    const days = [...document.querySelectorAll(".tm-day")].map((d) => [d.querySelector(".tm-day-label")!.textContent,
      [...d.querySelectorAll(".tm-session-title")].map((t) => t.textContent)]);
    // THE MUTANTS: one flat list; oldest first; the hand-off (finished today) under a day of its own; "design - " left on it.
    expect(days.slice(0, 2)).toEqual([
      ["Today", ["ship 2.7.2", "land #264", "sign + publish", "tidy"]],
      ["Yesterday", ["move sheet P1", "move notices"]],
    ]);
    expect(days).toHaveLength(3);
    expect(doneRow("move notices").style.getPropertyValue("--tm-depth")).toBe("1");
    expect(doneRow("move sheet P1").querySelector(".tm-handoffs")).toHaveTextContent("↳ 1");
  });

  it("ends each finished row in what it produced, and nothing where nothing was recorded", async () => {
    await mount(work());
    const chip = (title: string) => doneRow(title).querySelector(".tm-outcome");
    // THE MUTANTS: an opened PR called merged; a failure without its reason; a chip made up for a plain session.
    expect(chip("land #264")).toHaveTextContent("#264 open");
    expect(chip("move sheet P1")).toHaveTextContent("#257 merged");
    expect(chip("ship 2.7.2")).toHaveTextContent("v2.7.2 shipped");
    expect(chip("sign + publish")).toHaveTextContent("Failed");
    expect(chip("sign + publish")).toHaveAttribute("data-kind", "failed");
    expect(doneRow("sign + publish").querySelector(".tm-failed-why")).toHaveTextContent("Notarization keychain item missing");
    expect(chip("tidy")).toBeNull();
    expect(chip("quiet labels")).toBeNull();
    // Bold is unread.
    expect(doneRows().filter((r) => r.querySelector("[data-unread]")).map((r) => r.querySelector(".tm-session-title")!.textContent)).toEqual(["land #264", "move notices"]);
  });

  it("wears the icon of the teammate each session runs on", async () => {
    await mount(work());
    const shape = (title: string) => doneRow(title).querySelector(".tm-row-icon svg, .tm-row-icon [data-shape]");
    expect(shape("move notices")).not.toBeNull();
    // THE MUTANT: every row in the computer's own teammate's icon.
    expect(doneRow("move notices").querySelector(".tm-row-icon")!.innerHTML).not.toEqual(doneRow("tidy").querySelector(".tm-row-icon")!.innerHTML);
  });

  it("opens a finished session on a click, beside the chat, and in place when there is none", async () => {
    const { store } = await mount(work());
    const peekSession = vi.fn(async () => false);
    const revealSession = vi.fn(async () => true);
    act(() => store.setState({ peekSession, revealSession }));
    fireEvent.click(screen.getByRole("button", { name: /^move notices/ }));
    await waitFor(() => expect(peekSession).toHaveBeenCalledWith("child", "s1"));
    await waitFor(() => expect(revealSession).toHaveBeenCalledWith("child", "s1"));
  });

  it("renames and archives from the row's menu, as the sidebar row did", async () => {
    const { api } = await mount(work());
    const menu = async (title: string) => {
      fireEvent.contextMenu(doneRow(title).querySelector("button")!, { clientX: 10, clientY: 10 });
      return within(await screen.findByRole("menu", { name: `Actions for cto - ${title}` }));
    };
    fireEvent.click((await menu("tidy")).getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Rename cto - tidy" });
    fireEvent.change(input, { target: { value: "cto - tidy up" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(doneRow("tidy up")).toBeDefined());
    fireEvent.click((await menu("quiet labels")).getByRole("menuitem", { name: "Archive" }));
    // THE MUTANT: an archived session still listed on the computer.
    await waitFor(() => expect(doneRow("quiet labels")).toBeUndefined());
    expect(api.calls).not.toContain("deleteItem:i-old");
  });

  it("shows eight finished, then all of them on Show all", async () => {
    await mount(Array.from({ length: 11 }, (_, i) => task(`t${i}`, { title: `task ${i}`, updatedAt: now - (11 - i) * 1000 })));
    // THE MUTANTS: no cap; a cap that keeps the oldest; a count of the hidden ones only.
    expect(doneRows()).toHaveLength(8);
    expect(doneRows()[0]).toHaveTextContent("task 10");
    fireEvent.click(screen.getByRole("button", { name: "Show all 11" }));
    expect(doneRows()).toHaveLength(11);
    fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(doneRows()).toHaveLength(8);
  });

  it("takes in a session the moment it starts", async () => {
    const { store, cto } = await mount(work());
    cto.taskSessions = [task("fresh", { title: "cto - rail badges", state: "working", updatedAt: now }), ...cto.taskSessions];
    await act(() => store.getState().refreshTeammates("s1"));
    // THE MUTANT: a list read once when the computer opened.
    await waitFor(() => expect(nowRows().map((r) => r.querySelector(".tm-session-title")!.textContent)).toContain("rail badges"));
  });

  it("lists what its sessions hold open on this Mac, and opens and stops each", async () => {
    const term = item("i-term", "s1", { kind: "terminal", refId: "term-1", title: "pnpm vitest" });
    const tab = item("i-tab", "s1", { kind: "browser", refId: "br-1", title: "PR #269 · GitHub" });
    const sim = item("i-sim", "s1", { kind: "simulator", refId: "sim-1", title: "iPhone 17 Pro" });
    const stranger = item("i-other", "s1", { kind: "terminal", refId: "term-2", title: "someone else's" });
    const tasks = work();
    const { store } = await mount(tasks, {
      items: { s1: [sessionItem("home-cto", "cto"), ...tasks.map((t) => sessionItem(t.id, t.title)), term, tab, sim, stranger] },
    });
    act(() => store.setState({
      view: { layout: { type: "leaf", id: "l", itemId: null }, zoomedLeafId: null, sidePanes: { "i-live": { tabs: ["i-tab", "i-sim"], itemId: "i-tab" } } },
      sessionTerminals: { "home-cto": "term-1" },
      simulatorState: { "sim-1": { simulatorId: "sim-1", status: "running", udid: "U", serial: null, streamUrl: null, wsUrl: null, screen: null, error: null, detail: null, physical: false } },
    }));
    const rows = () => [...document.querySelectorAll<HTMLElement>(".tm-resource")];
    // THE MUTANTS: another session's terminal listed; a session's kept tabs missed; a device read as off.
    await waitFor(() => expect(rows().map((r) => r.querySelector(".tm-resource-label")!.textContent)).toEqual(["pnpm vitest", "PR #269 · GitHub", "iPhone 17 Pro"]));
    expect(rows()[2]!.querySelector(".tm-resource-state")).toHaveTextContent("On");
    expect(screen.getByText(/Simulator on/)).toBeInTheDocument();
    const openInSidePane = vi.fn(async () => true);
    const deleteItem = vi.fn(async () => {});
    act(() => store.setState({ openInSidePane, deleteItem }));
    fireEvent.click(within(rows()[1]!).getByRole("button", { name: "Open" }));
    // THE MUTANT: Open that shows the tab beside the wrong session, or not at all.
    await waitFor(() => expect(openInSidePane).toHaveBeenCalledWith("live", "i-tab", { focus: true }));
    // A browser tab has nothing running to stop.
    expect(within(rows()[1]!).queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("stands Done beside Now and On this Mac when the panel is wide, and under Now when it is narrow", async () => {
    let fire: (w: number) => void = () => {};
    vi.stubGlobal("ResizeObserver", class {
      constructor(cb: ResizeObserverCallback) { fire = (w) => cb([{ borderBoxSize: [{ inlineSize: w, blockSize: 0 }], contentRect: { width: w - 32 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver); }
      observe() {} disconnect() {}
    });
    await mount(work());
    const order = () => [...document.querySelectorAll(".tm-section")].map((s) => s.getAttribute("aria-label"));
    const root = document.querySelector(".tm-computer")!;
    act(() => fire(420));
    expect(root).not.toHaveAttribute("data-wide");
    expect(order()).toEqual(["Now", "Done", "On this Mac"]);
    act(() => fire(780));
    // THE MUTANTS: one column at any width; the switch made at the wrong width, or read off the content box.
    expect(root).toHaveAttribute("data-wide");
    expect([...document.querySelectorAll(".tm-column")].map((c) => [...c.querySelectorAll(".tm-section")].map((s) => s.getAttribute("aria-label"))))
      .toEqual([["Now", "On this Mac"], ["Done"]]);
    act(() => fire(759));
    expect(root).not.toHaveAttribute("data-wide");
  });
});

describe("the New teammate sheet", () => {
  async function mountSheet(id?: string) {
    const api = fakeApi(team());
    const store = createAppStore(api); await store.getState().boot();
    await act(() => store.getState().refreshTeammates());
    store.setState({ sheet: { kind: "teammate", spaceId: "s1", ...(id ? { id } : {}) } });
    const r = render(<StoreContext.Provider value={store}><TeammateSheet spaceId="s1" id={id} /></StoreContext.Provider>);
    return { api, store, ...r };
  }

  it("fills a name, a brief and an icon from a quick start, and makes the teammate with them", async () => {
    const { api, store } = await mountSheet();
    fireEvent.click(screen.getByRole("button", { name: "CTO" }));
    expect(screen.getByLabelText("Name")).toHaveValue("CTO");
    expect((screen.getByLabelText("What it does") as HTMLTextAreaElement).value).toContain("technical direction");
    expect(screen.getByRole("radio", { name: "Hexagon" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Blue" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: "Cloud" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(api.calls.some((c) => c.startsWith("teammateCreate:"))).toBe(true));
    const sent = JSON.parse(api.calls.find((c) => c.startsWith("teammateCreate:"))!.slice("teammateCreate:".length));
    expect(sent).toMatchObject({ spaceId: "s1", name: "CTO", icon: { shape: "cloud", color: "blue" }, lead: false, folder: null, group: null });
    await waitFor(() => expect(store.getState().sheet).toBeNull());
  });

  it("keeps a name the person typed when a quick start is picked after it", async () => {
    await mountSheet();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada" } });
    fireEvent.click(screen.getByRole("button", { name: "Research" }));
    expect(screen.getByLabelText("Name")).toHaveValue("Ada");
  });

  it("edits a teammate in place and saves only to it", async () => {
    const { api } = await mountSheet("cto");
    expect(screen.getByRole("dialog", { name: "Edit cto" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Quick starts" })).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: /Make this the Lead/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.calls.some((c) => c.startsWith("teammateUpdate:cto:") && c.includes('"lead":true'))).toBe(true));
  });
});
