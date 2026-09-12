import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { AgentKind, MidTurnMode, PlanLimits, QueuedPrompt } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { SessionPane } from "./SessionPane";
import { reduceAll } from "./transcript-model";

/**
 * The queue, on screen. The server decides WHETHER a message queues (`apps/server` queue suite); this
 * proves the prompter shows what is waiting, that each row's send-now and remove reach the right
 * session and message, and — the thing that would quietly rot — that the row names what steering
 * costs on the agent the session is actually running.
 */
const prompt = (id: string, text: string, extra: Partial<QueuedPrompt> = {}): QueuedPrompt =>
  ({ id, text, attachments: [], ts: 1, ...extra });

async function mount(queued: QueuedPrompt[], agentKind: AgentKind = "fake", midTurnMode: MidTurnMode = "queue") {
  const it0 = item("i9", "s1", { kind: "session", refId: "se1", title: "s" });
  const api = fakeApi({
    sessions: [session("se1", "s1", { status: "running", agentKind })],
    items: { s1: [it0] },
  });
  // Seeded on the FAKE, not in the store: the pane reads the queue once when it mounts, so store
  // state set here would be overwritten by that read a tick later.
  api.queuedPrompts.push(...queued);
  const store = createAppStore(api);
  await store.getState().boot();
  store.setState({
    sessionStatus: { se1: "running" },
    transcripts: { se1: { lastSeq: 0, t: reduceAll([]) } },
    midTurnMode,
  });
  render(
    <StoreContext.Provider value={store}>
      <SessionPane item={it0} visible />
    </StoreContext.Provider>,
  );
  await act(async () => { await new Promise((res) => setTimeout(res, 1)); });
  return { api, store };
}

const rows = () => Array.from(document.querySelectorAll(".composer-queue-item"));
const list = () => document.querySelector(".composer-queue");

describe("the prompter's queue", () => {
  it("draws nothing at all when nothing is waiting", async () => {
    await mount([]);
    expect(list()).toBeNull();
  });

  it("lists what is waiting, oldest first, with its position", async () => {
    await mount([prompt("q1", "first"), prompt("q2", "second")]);
    expect(rows().map((r) => r.querySelector(".queue-text")?.textContent)).toEqual(["first", "second"]);
    expect(rows().map((r) => r.querySelector(".queue-position")?.textContent)).toEqual(["1", "2"]);
  });

  it("sends one now by id, leaving the others alone", async () => {
    const { api } = await mount([prompt("q1", "first"), prompt("q2", "second")]);
    fireEvent.click(rows()[1]!.querySelector(".queue-send")!);
    await waitFor(() => expect(api.calls).toContain("releaseQueued:se1:q2"));
    expect(api.calls.filter((c) => c.startsWith("releaseQueued"))).toEqual(["releaseQueued:se1:q2"]);
  });

  it("removes one by id", async () => {
    const { api } = await mount([prompt("q1", "first"), prompt("q2", "second")]);
    fireEvent.click(rows()[0]!.querySelector(".queue-drop")!);
    await waitFor(() => expect(api.calls).toContain("dequeue:se1:q1"));
  });

  /* The one thing that differs per agent, and the reason `steerNote` exists rather than one sentence:
   * on an interrupt kind the send-now ends the running turn, and a tooltip that did not say so would
   * be selling a free action. `fake` is an interrupt kind (AGENT_MIDTURN_DELIVERY). */
  it("names the interrupt on an agent whose turn steering would stop", async () => {
    await mount([prompt("q1", "first")]);
    expect(rows()[0]!.querySelector(".queue-send")?.getAttribute("title")).toContain("stops the running turn");
  });

  it("promises no interruption on Codex, which takes the message mid-turn", async () => {
    await mount([prompt("q1", "first")], "codex");
    const title = rows()[0]!.querySelector(".queue-send")?.getAttribute("title") ?? "";
    expect(title).toContain("Nothing is interrupted");
    expect(title).not.toContain("stops the running turn");
  });

  it("counts a queued message's attachments rather than dropping them from the row", async () => {
    await mount([prompt("q1", "look", { attachments: [{ path: "/tmp/a.png", mime: "image/png" }, { path: "/tmp/b.png", mime: "image/png" }] })]);
    expect(rows()[0]!.querySelector(".queue-attach")?.textContent).toContain("2");
    expect(rows()[0]!.querySelector(".queue-attach")?.getAttribute("title")).toBe("a.png, b.png");
  });

  it("says so rather than showing an empty row for an attachment-only message", async () => {
    await mount([prompt("q1", "", { attachments: [{ path: "/tmp/a.png", mime: "image/png" }] })]);
    expect(rows()[0]!.querySelector(".queue-text")?.textContent).toBe("(attachments only)");
  });

  it("names the message it would remove, for a reader who cannot see the row", async () => {
    await mount([prompt("q1", "also fix the test")]);
    expect(screen.getByLabelText("Remove queued message: also fix the test")).toBeTruthy();
  });

  it("reads the queue when the pane mounts, for one that filled while it was closed", async () => {
    const { store } = await mount([prompt("q1", "waiting since before this pane opened")]);
    await waitFor(() => expect(store.getState().sessionQueues.se1).toHaveLength(1));
  });

  /* An empty queue holds no key at all rather than an empty array — the prompter asks "is anything
   * waiting", and one shape for "no" is fewer than two. */
  it("drops the session's key when its queue empties", async () => {
    const { store } = await mount([prompt("q1", "first")]);
    await waitFor(() => expect(store.getState().sessionQueues.se1).toHaveLength(1));
    act(() => { store.getState().applySessionQueue("se1", []); });
    expect("se1" in store.getState().sessionQueues).toBe(false);
  });
});

/**
 * The corner button is Stop while a turn runs, so a message typed into the box has no button of its
 * own — the keyboard is its only route, and this tooltip is the only place that is said. It also has
 * to say WHICH of the two things the send does, because that is a setting: a tooltip naming the
 * wrong one would be worse than the silence it replaced.
 */
describe("what the Stop button says a typed message will do", () => {
  const box = () => screen.getByRole("textbox", { name: /message/i });
  const stop = () => screen.getByRole("button", { name: "Stop" });
  const type = (value: string) => fireEvent.change(box(), { target: { value } });

  it("says nothing extra with an empty box — there is no message to explain", async () => {
    await mount([]);
    expect(stop().getAttribute("title")).toBe("Stop (interrupt)");
  });

  it("names the queue once there is something to queue", async () => {
    await mount([]);
    type("also fix the test");
    expect(stop().getAttribute("title")).toContain("⌘↵ queues your message for when this turn ends");
  });

  it("names the send, and its cost, when the setting says send now", async () => {
    await mount([], "fake", "steer");
    type("actually do this instead");
    const title = stop().getAttribute("title") ?? "";
    expect(title).toContain("⌘↵ sends your message instead");
    expect(title).toContain("which also stops this turn");
  });

  it("promises no interruption on Codex, which has a mid-turn route", async () => {
    await mount([], "codex", "steer");
    type("actually do this instead");
    const title = stop().getAttribute("title") ?? "";
    expect(title).toContain("into the turn Codex is running");
    expect(title).not.toContain("stops this turn");
  });
});

/**
 * The provider's limit warning, in the prompter.
 *
 * The whole design rests on one property: the row appears because the PROVIDER said so, not because
 * a percentage crossed a line Realm picked. So the tests drive `alert` directly and check that a high
 * utilization with no alert stays silent — that is the mutant worth catching, because a threshold
 * quietly reintroduced here would look right on every screenshot.
 */
describe("the prompter's limit warning", () => {
  const limits = (over: Partial<PlanLimits> = {}): PlanLimits => ({
    agentKind: "fake", subscriptionType: "max", organization: null, windows: [], alert: "none",
    alertWindow: null, unavailable: null, detail: null, ts: 1, ...over,
  });
  const w = (id: string, label: string, utilization: number | null, resetsAt: number | null = null) =>
    ({ id, label, utilization, resetsAt });
  const warning = () => document.querySelector(".composer-limit");

  async function withLimits(row: PlanLimits) {
    const it0 = item("i9", "s1", { kind: "session", refId: "se1", title: "s" });
    const api = fakeApi({ sessions: [session("se1", "s1", { status: "idle", agentKind: "fake" })], items: { s1: [it0] } });
    const store = createAppStore(api);
    await store.getState().boot();
    store.setState({ sessionStatus: { se1: "idle" }, transcripts: { se1: { lastSeq: 0, t: reduceAll([]) } }, planLimits: [row] });
    render(<StoreContext.Provider value={store}><SessionPane item={it0} visible /></StoreContext.Provider>);
    await act(async () => { await new Promise((res) => setTimeout(res, 1)); });
    return { store };
  }

  it("stays silent when the provider is not warning, however full the window is", async () => {
    await withLimits(limits({ alert: "none", windows: [w("seven_day", "Weekly", 97)] }));
    expect(warning()).toBeNull();
  });

  it("names the window and its level when the provider warns", async () => {
    await withLimits(limits({ alert: "approaching", alertWindow: "seven_day", windows: [w("seven_day", "Weekly", 92)] }));
    expect(warning()?.textContent).toContain("Weekly limit at 92%");
  });

  it("says the limit is reached rather than quoting a percentage once it is", async () => {
    await withLimits(limits({ alert: "exceeded", alertWindow: "five_hour", windows: [w("five_hour", "5-hour", 100)] }));
    expect(warning()?.textContent).toContain("5-hour limit reached");
    expect(warning()?.getAttribute("data-alert")).toBe("exceeded");
  });

  it("adds when the window resets, which is the actionable half", async () => {
    const soon = Date.now() + 3 * 60 * 60 * 1000;
    await withLimits(limits({ alert: "approaching", alertWindow: "five_hour", windows: [w("five_hour", "5-hour", 90, soon)] }));
    expect(warning()?.textContent).toMatch(/Resets /);
  });

  /* A provider may warn without naming which window. The account is still near a limit, and the
   * fullest window it did report is the best available answer. */
  it("falls back to the fullest window when the warning names none", async () => {
    await withLimits(limits({ alert: "approaching", alertWindow: null, windows: [w("five_hour", "5-hour", 20), w("seven_day", "Weekly", 88)] }));
    expect(warning()?.textContent).toContain("Weekly limit at 88%");
  });

  it("still warns when it has no window to name at all", async () => {
    await withLimits(limits({ alert: "exceeded", alertWindow: null, windows: [] }));
    expect(warning()?.textContent).toContain("Plan limit reached");
  });

  /* A Claude warning means nothing in a Cursor pane: the row is picked by the session's own kind. */
  it("ignores a warning belonging to another provider", async () => {
    await withLimits(limits({ agentKind: "claude", alert: "exceeded", alertWindow: "seven_day", windows: [w("seven_day", "Weekly", 100)] }));
    expect(warning()).toBeNull();
  });
});
