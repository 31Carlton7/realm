import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PAGE_REF_IDS, sessionEvent, type Session, type StoredSessionEvent } from "@realm/contracts";
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
    // Anchored: the row's Stop is named for its session too ("Stop Session se2").
    expect(within(working).getByRole("button", { name: /^Session se2/ })).toHaveTextContent("Plynn");
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
    fireEvent.click(await screen.findByRole("button", { name: /^Session se2/ }));
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

/** A request as the server stores it, for the transcript pipeline the board reads it from. */
const asked = (sessionId: string, seq: number, requestId: string, toolName: string, input: Record<string, unknown>, title: string): StoredSessionEvent =>
  ({ seq, sessionId, event: sessionEvent("permission_request", { requestId, toolName, input, title, suggestions: [] }, seq) });
const QUESTION = { questions: [{ question: "Which branch should this go on?", header: "Base", multiSelect: false,
  options: [{ label: "main" }, { label: "integration/v0.6", description: "the release line" }] }] };

describe("the Agents page answers in place", () => {
  /** Two waiting sessions in ANOTHER space (so a stray navigation would move the active space), one
   *  running there too, and one finished. */
  async function mount() {
    const api = fakeApi({
      spaces: [space("s1", "p1", "Versed"), space("s2", "p1", "Plynn")],
      sessions: [
        row("se1", "s2", { status: "waiting_permission", updatedAt: 9 }),
        row("se3", "s2", { status: "waiting_permission", updatedAt: 8 }),
        row("se2", "s2", { status: "running", updatedAt: 5 }),
        row("se4", "s2", { status: "idle", updatedAt: 1 }),
      ],
      sessionEvents: {
        se1: [asked("se1", 1, "r1", "Bash", { command: "rm -rf build" }, "Allow Bash?")],
        se3: [asked("se3", 1, "q1", "AskUserQuestion", QUESTION, "Allow AskUserQuestion?")],
      },
    });
    const answered: unknown[][] = [];
    const respond = api.respondPermission;
    api.respondPermission = async (...a) => { answered.push(a); return respond(...a); };
    const store = createAppStore(api); await store.getState().boot();
    render(<StoreContext.Provider value={store}>
      <AgentsPage item={item("pg", "s1", { kind: "agents-page", refId: PAGE_REF_IDS["agents-page"], title: "Agents" })} visible />
    </StoreContext.Provider>);
    const layout = store.getState().layout;
    /** Nothing moved: the same space is active and the same layout is on screen. */
    const stayed = () => { expect(store.getState().activeSpaceId).toBe("s1"); expect(store.getState().layout).toBe(layout); };
    return { api, store, answered, stayed };
  }
  const itemOf = async (name: RegExp) => (await screen.findByRole("button", { name })).closest(".agents-item") as HTMLElement;

  it("shows a waiting session's request under its row, and Allow answers it without leaving the page", async () => {
    const { answered, stayed } = await mount();
    const card = await within(await screen.findByRole("region", { name: "Needs you" })).findByRole("group", { name: "Permission request" });
    expect(await itemOf(/^Session se1/)).toContainElement(card);
    expect(card).toHaveTextContent("Allow Bash?");
    expect(card).toHaveTextContent("rm -rf build");
    fireEvent.click(within(card).getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(answered).toContainEqual(["se1", "r1", "allow", undefined]));
    stayed();
  });

  it("takes Escape on a card as leaving the page, never as Deny", async () => {
    // The cards deny on Escape. THE MUTANT: let it reach the card — someone closing the page from
    // inside a card would deny a request they only looked at.
    const { answered, store, stayed } = await mount();
    store.setState({ pageOverlay: { kind: "agents-page", refId: PAGE_REF_IDS["agents-page"], spaceId: "s1" } });
    const card = await within(await itemOf(/^Session se1/)).findByRole("group", { name: "Permission request" });
    fireEvent.keyDown(within(card).getByRole("button", { name: "Allow" }), { key: "Escape" });
    expect(store.getState().pageOverlay).toBeNull();
    const question = await within(await itemOf(/^Session se3/)).findByRole("group", { name: "Base" });
    fireEvent.keyDown(within(question).getAllByRole("button")[0]!, { key: "Escape" });
    await new Promise((r) => setTimeout(r, 0));
    expect(answered).toEqual([]);
    stayed();
  });

  it("leaves Escape in an answer being typed to the field, which steps out and keeps the page", async () => {
    // THE MUTANT: catch Escape in the field too. The page would close over a half-typed answer.
    const { answered, store } = await mount();
    store.setState({ pageOverlay: { kind: "agents-page", refId: PAGE_REF_IDS["agents-page"], spaceId: "s1" } });
    const card = await within(await itemOf(/^Session se3/)).findByRole("group", { name: "Base" });
    fireEvent.click(within(card).getByRole("button", { name: "Something else" }));
    const field = within(card).getByRole("textbox", { name: "Your answer" });
    fireEvent.change(field, { target: { value: "a new br" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(store.getState().pageOverlay).not.toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(answered).toEqual([]);
  });

  it("offers the card's own Allow always, and Deny", async () => {
    const { answered, stayed } = await mount();
    const card = await within(await itemOf(/^Session se1/)).findByRole("group", { name: "Permission request" });
    fireEvent.click(within(card).getByRole("button", { name: "Allow always" }));
    await waitFor(() => expect(answered).toContainEqual(["se1", "r1", "allow_always", undefined]));
    fireEvent.click(within(card).getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(answered).toContainEqual(["se1", "r1", "deny", undefined]));
    stayed();
  });

  it("shows a question as the transcript does — its options and a field for your own answer", async () => {
    const { answered, stayed } = await mount();
    const card = await within(await itemOf(/^Session se3/)).findByRole("group", { name: "Base" });
    expect(card).toHaveTextContent("Which branch should this go on?");
    expect(within(card).getByRole("button", { name: "integration/v0.6" })).toHaveTextContent("the release line");
    // No Allow / Deny on a question: those would ask the wrong thing.
    expect(within(card).queryByRole("button", { name: "Allow" })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Something else" }));
    fireEvent.change(within(card).getByRole("textbox", { name: "Your answer" }), { target: { value: "a new branch" } });
    fireEvent.click(within(card).getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(answered).toContainEqual(["se3", "q1", "allow", { "Which branch should this go on?": "a new branch" }]));
    stayed();
  });

  it("answers a question with an option picked off the list", async () => {
    const { answered } = await mount();
    const card = await within(await itemOf(/^Session se3/)).findByRole("group", { name: "Base" });
    fireEvent.click(within(card).getByRole("button", { name: "main" }));
    await waitFor(() => expect(answered).toContainEqual(["se3", "q1", "allow", { "Which branch should this go on?": "main" }]));
  });

  it("puts Stop on a running session, and it stops the turn without opening the session", async () => {
    const { api, stayed } = await mount();
    const working = await screen.findByRole("region", { name: "Working" });
    fireEvent.click(within(working).getByRole("button", { name: "Stop Session se2" }));
    await waitFor(() => expect(api.calls).toContain("interrupt:se2"));
    stayed();
  });

  it("offers each answer only where it means something: no Stop while waiting, nothing on a finished row", async () => {
    await mount();
    await within(await itemOf(/^Session se1/)).findByRole("group", { name: "Permission request" });
    expect(within(await itemOf(/^Session se1/)).queryByRole("button", { name: /^Stop/ })).toBeNull();
    const ready = screen.getByRole("region", { name: "Ready" });
    expect(within(ready).queryByRole("button", { name: /^Stop/ })).toBeNull();
    expect(within(ready).queryByRole("group")).toBeNull();
  });

  it("drops the card the moment the request is answered anywhere — the transcript and the board read one list", async () => {
    const { store } = await mount();
    const se1 = await itemOf(/^Session se1/);
    await within(se1).findByRole("group", { name: "Permission request" });
    act(() => store.getState().applySessionEvent({ seq: 2, sessionId: "se1", ephemeral: false,
      event: sessionEvent("permission_response", { requestId: "r1", decision: "allow" }, 2) }));
    await waitFor(() => expect(within(se1).queryByRole("group", { name: "Permission request" })).toBeNull());
  });
});
