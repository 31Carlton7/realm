import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { sessionEvent, sessionLink, type TeammateTaskSession } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session, space, profile, teammate, type FakeData } from "../../state/store.test-fakes";
import { Sidebar } from "../../components/sidebar/Sidebar";
import { PanelBar } from "../../components/PanelBar";
import { SessionPane } from "../session/SessionPane";
import { renderMarkdown } from "../session/Markdown";
import { reduceAll } from "../session/transcript-model";
import { mentionOptions, mentionRows, refFor } from "../session/mention-sources";
import { ComputerPane } from "./ComputerPane";
import { TeammateSheet } from "./TeammateSheet";
import { groupTeammates, recentSessions, sessionTree, teammateMark } from "./teammate-model";

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

  it("unfolds a row to everything live and the newest of the rest", () => {
    const list = [task("1"), task("2", { state: "working" }), task("3"), task("4"), task("5", { state: "needs-you" }), task("6"), task("7")];
    expect(recentSessions(list, 4).map((s) => s.id)).toEqual(["1", "2", "3", "5"]);
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

async function mountSidebar(over: FakeData = {}) {
  const api = fakeApi(team(over));
  const store = createAppStore(api); await store.getState().boot();
  await act(() => store.getState().refreshTeammates());
  const r = render(<StoreContext.Provider value={store}><Sidebar /></StoreContext.Provider>);
  await waitFor(() => expect(api.calls).toContain("listAllItems"));
  return { api, store, ...r };
}

const titles = () => [...screen.getByRole("region", { name: "Versed" }).querySelectorAll(".sb-section-clip .item-title")].map((t) => t.textContent);

describe("the sidebar's Team list", () => {
  it("heads the space with its teammates, the Lead first, and lists their sessions there and nowhere else", async () => {
    await mountSidebar();
    // THE MUTANTS: the Lead in its sort order; a teammate's chat or task also loose among the sessions.
    await waitFor(() => expect(titles()).toEqual(["Lead", "cto", "Strat", "research", "Alpha"]));
    expect(screen.getByRole("button", { name: "Sessions", expanded: true })).toBeInTheDocument();
  });

  it("folds the Team and the Sessions lists from their captions, and remembers each", async () => {
    const { store, api } = await mountSidebar();
    // THE MUTANTS: a caption that folds both lists, or one that hides its rows without saying so.
    fireEvent.click(await screen.findByRole("button", { name: "Team", expanded: true }));
    await waitFor(() => expect(titles()).toEqual(["Alpha"]));
    expect(screen.getByRole("button", { name: "Team", expanded: false })).toBeInTheDocument();
    expect(api.calls).toContain("setSetting:ui.sidebarFoldedLists=s1/team");
    fireEvent.click(screen.getByRole("button", { name: "Sessions", expanded: true }));
    await waitFor(() => expect(titles()).toEqual([]));
    expect(store.getState().sidebarFoldedLists).toEqual(["s1/team", "s1/sessions"]);
    fireEvent.click(screen.getByRole("button", { name: "Team", expanded: false }));
    await waitFor(() => expect(titles()).toEqual(["Lead", "cto", "Strat", "research"]));
  });

  it("comes back with the lists folded as they were left", async () => {
    await mountSidebar({ settings: { "ui.sidebarFoldedLists": ["s1/sessions"] } });
    await waitFor(() => expect(titles()).toEqual(["Lead", "cto", "Strat", "research"]));
    expect(screen.getByRole("button", { name: "Sessions", expanded: false })).toBeInTheDocument();
  });

  it("keeps a teamless space's sessions showing whatever a fold left behind, since it has no caption to open them", async () => {
    await mountSidebar({ teammates: [], settings: { "ui.sidebarFoldedLists": ["s1/sessions"] } });
    await waitFor(() => expect(titles()).toContain("Alpha"));
    expect(screen.queryByRole("button", { name: "Sessions" })).toBeNull();
  });

  it("says each teammate's state in words, not only in the dot's colour", async () => {
    await mountSidebar();
    expect(await screen.findByRole("button", { name: "cto — working, on cto - sqlite search" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "research — needs you" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lead, the Lead" })).toBeInTheDocument();
  });

  it("unfolds a teammate to its sessions, with the hand-off nested under the one that asked", async () => {
    await mountSidebar();
    fireEvent.click(await screen.findByRole("button", { name: "Show cto's sessions" }));
    const rows = [...document.querySelectorAll(".sb-team-sessions .sb-row")];
    expect(rows.map((r) => r.textContent)).toEqual(["cto - sqlite search", "↳design - icon"]);
    expect((rows[1] as HTMLElement).style.getPropertyValue("--sb-depth")).toBe("1");
  });

  it("folds a group the person made, and remembers it", async () => {
    const { store, api } = await mountSidebar();
    fireEvent.click(await screen.findByRole("button", { name: /^Strat, 1 teammate, 1 needs you/ }));
    await waitFor(() => expect(titles()).toEqual(["Lead", "cto", "Strat", "Alpha"]));
    expect(store.getState().teamGroupsFolded).toEqual(["s1/Strat"]);
    expect(api.calls).toContain("setSetting:ui.sidebarTeamGroupsFolded=s1/Strat");
  });

  it("opens a teammate onto its chat, with its computer beside it the first time", async () => {
    const { store, api } = await mountSidebar();
    fireEvent.click(await screen.findByRole("button", { name: /^cto — working/ }));
    await waitFor(() => expect(api.calls).toContain("createItem:s1|computer|cto"));
    const computer = store.getState().items.find((i) => i.kind === "computer" && i.refId === "cto");
    expect(computer).toBeDefined();
    expect(store.getState().layout && JSON.stringify(store.getState().layout)).toContain("i-home-cto");
  });

  it("moves a teammate dragged onto a group's head into that group, keeping everyone else's order", async () => {
    const { api } = await mountSidebar();
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
    const { store } = await mountSidebar({ items: { s1: [] }, sessions: [], teammates: [] });
    fireEvent.click(await screen.findByRole("button", { name: "Add a teammate" }));
    expect(store.getState().sheet).toEqual({ kind: "teammate", spaceId: "s1" });
  });
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
  async function mountComputer() {
    const api = fakeApi(team());
    const store = createAppStore(api); await store.getState().boot();
    await act(() => store.getState().refreshTeammates());
    const r = render(<StoreContext.Provider value={store}><ComputerPane item={item("i-comp", "s1", { kind: "computer", refId: "cto", title: "Computer" })} visible /></StoreContext.Provider>);
    return { api, store, ...r };
  }

  it("says where it works and its state in words, and lists its sessions with the hand-offs counted", async () => {
    const { api } = await mountComputer();
    expect(document.querySelector(".tm-machine")).toHaveTextContent("This MacWorking");
    await waitFor(() => expect(api.calls).toContain("teammateSessions:cto"));
    const rows = [...document.querySelectorAll(".tm-session")];
    expect(rows.map((r) => r.querySelector(".tm-session-title")!.textContent)).toEqual(["cto - sqlite search", "design - icon"]);
    expect(rows[0]!.querySelector(".tm-handoffs")).toHaveTextContent("↳ 1");
  });

  it("stops everything it is running, its chat and its live sessions", async () => {
    const { api } = await mountComputer();
    await waitFor(() => expect(api.calls).toContain("teammateSessions:cto"));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    // THE MUTANT: Stop on the chat alone, leaving the session it started running.
    await waitFor(() => expect(api.calls.filter((c) => c.startsWith("interrupt:")).sort()).toEqual(["interrupt:home-cto", "interrupt:t1"]));
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
