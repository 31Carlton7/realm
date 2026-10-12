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
  ({ id, text, attachments: [], ts: 1, held: false, ...extra });

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

/* A row that just left stays a moment to fold away, inert; it is not one of the queue's rows. */
const rows = () => Array.from(document.querySelectorAll(".composer-queue-item:not([data-leaving])"));
const list = () => document.querySelector(".composer-queue");

describe("the prompter's queue", () => {
  it("draws nothing at all when nothing is waiting", async () => {
    await mount([]);
    expect(list()).toBeNull();
  });

  it("lists what is waiting, oldest first, each named by its place for a reader who cannot see the order", async () => {
    await mount([prompt("q1", "first"), prompt("q2", "second")]);
    expect(rows().map((r) => r.querySelector(".queue-text")?.textContent)).toEqual(["first", "second"]);
    expect(screen.getByRole("button", { name: "Queued message 2 of 2: second" })).toBeTruthy();
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

  it("shows a queued message's files as the prompter's tiles, each with its name, rather than a count", async () => {
    // THE MUTANT: the name dropped from the chip — a row of identical file glyphs says how many, not which.
    await mount([prompt("q1", "look", { attachments: [{ path: "/tmp/a.png", mime: "image/png" }, { path: "/tmp/notes.pdf", mime: "application/pdf" }] })]);
    const files = Array.from(rows()[0]!.querySelectorAll(".queue-file"));
    expect(files.map((f) => f.querySelector(".queue-file-name")?.textContent)).toEqual(["a.png", "notes.pdf"]);
    expect(files.every((f) => f.querySelector(".attach-tile"))).toBe(true);
    expect(screen.getByRole("button", { name: "Open a.png" })).toBeTruthy();
  });

  it("says so rather than showing an empty row for an attachment-only message", async () => {
    await mount([prompt("q1", "", { attachments: [{ path: "/tmp/a.png", mime: "image/png" }] })]);
    expect(rows()[0]!.querySelector(".queue-text")?.textContent).toBe("Attachments only");
  });

  it("names the message it would remove, for a reader who cannot see the row", async () => {
    await mount([prompt("q1", "also fix the test")]);
    expect(screen.getByLabelText("Remove queued message: also fix the test")).toBeTruthy();
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

describe("editing a queued message", () => {
  const field = () => document.querySelector<HTMLTextAreaElement>(".composer-queue-item .queue-edit");
  const edit = async (row: number) => {
    fireEvent.click(rows()[row]!.querySelector(".queue-edit-btn")!);
    await waitFor(() => expect(field()).not.toBeNull());
  };

  it("opens a field holding the text, and holds the message on the server", async () => {
    // THE MUTANT: an editor that opens without the hold — the turn settles mid-edit and the old text goes.
    const { api } = await mount([prompt("q1", "first"), prompt("q2", "second")]);
    await edit(1);
    expect(api.calls).toContain("holdQueued:se1:q2=true");
    expect(field()!.value).toBe("second");
    expect(rows()[1]!.querySelector(".queue-held")?.textContent).toContain("Held while you edit");
    expect(rows()[1]!.querySelector(".queue-held")?.textContent).toContain("↵ saves · esc cancels");
  });

  it("saves with Enter, in place", async () => {
    const { api } = await mount([prompt("q1", "first")]);
    await edit(0);
    fireEvent.change(field()!, { target: { value: "first, edited" } });
    fireEvent.keyDown(field()!, { key: "Enter" });
    await waitFor(() => expect(api.calls).toContain("editQueued:se1:q1=first, edited"));
    expect(field()).toBeNull();
    // One close, not a save and then a second one from the blur that follows.
    expect(api.calls.filter((c) => c.startsWith("editQueued") || c.startsWith("holdQueued:se1:q1=false"))).toHaveLength(1);
  });

  it("keeps Shift+Enter a newline, and under ⌘↩ sending keeps plain Enter one too", async () => {
    const { api, store } = await mount([prompt("q1", "first")]);
    act(() => store.setState({ submitKey: "cmdEnter" }));
    await edit(0);
    fireEvent.keyDown(field()!, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(field()!, { key: "Enter" });
    expect(field()).not.toBeNull();
    fireEvent.change(field()!, { target: { value: "first\nmore" } });
    fireEvent.keyDown(field()!, { key: "Enter", metaKey: true });
    await waitFor(() => expect(api.calls).toContain("editQueued:se1:q1=first\nmore"));
  });

  it("lets go with Esc, sending nothing and keeping the row as it was", async () => {
    // THE MUTANT: Esc closing the field but leaving the hold — the queue stuck until the hold expires.
    const { api } = await mount([prompt("q1", "first")]);
    await edit(0);
    fireEvent.change(field()!, { target: { value: "never mind" } });
    fireEvent.keyDown(field()!, { key: "Escape" });
    await waitFor(() => expect(api.calls).toContain("holdQueued:se1:q1=false"));
    expect(api.calls.some((c) => c.startsWith("editQueued"))).toBe(false);
    expect(rows()[0]!.querySelector(".queue-text")?.textContent).toBe("first");
  });

  it("turns Send now off while the message is held, here or in another window", async () => {
    // THE MUTANT: Send now left live on a held row — the half-typed edit's old text sent on a click.
    await mount([prompt("q1", "first"), prompt("q2", "second", { held: true })]);
    expect(rows()[1]!.querySelector<HTMLButtonElement>(".queue-send")!.disabled).toBe(true);
    expect(rows()[1]!.querySelector<HTMLButtonElement>(".queue-edit-btn")!.disabled).toBe(true);
    expect(rows()[1]!.querySelector(".queue-held")?.textContent).toBe("Being edited in another window");
    expect(rows()[0]!.querySelector<HTMLButtonElement>(".queue-send")!.disabled).toBe(false);
    await edit(0);
    expect(rows()[0]!.querySelector<HTMLButtonElement>(".queue-send")!.disabled).toBe(true);
  });

  it("Send now keeps its name when a narrow pane draws it as the send arrow", async () => {
    // The words hide in a narrow pane (styles.css); the arrow beside them is what stays, and the
    // button is still "Send now" to a screen reader.
    await mount([prompt("q1", "first")]);
    const send = rows()[0]!.querySelector<HTMLButtonElement>(".queue-send")!;
    expect(send).toHaveAccessibleName("Send now");
    expect(send.querySelector(".queue-send-glyph")).not.toBeNull();
    expect(send.querySelector(".queue-send-label")).toHaveTextContent("Send now");
  });

  it("does not open a field on a message that already went out", async () => {
    const { api } = await mount([prompt("q1", "first")]);
    api.queuedPrompts.length = 0; // drained on the server, not yet broadcast
    fireEvent.click(rows()[0]!.querySelector(".queue-edit-btn")!);
    await waitFor(() => expect(api.calls).toContain("holdQueued:se1:q1=true"));
    expect(field()).toBeNull();
  });

  it("puts an edit the drain beat into the draft, with a toast", async () => {
    // THE MUTANT: a save answered `edited: false` and dropped — the user's correction gone.
    const { api, store } = await mount([prompt("q1", "first")]);
    act(() => store.getState().setDraft("se1", "half a thought"));
    await edit(0);
    fireEvent.change(field()!, { target: { value: "first, fixed" } });
    api.queuedPrompts.length = 0;
    fireEvent.keyDown(field()!, { key: "Enter" });
    await waitFor(() => expect(store.getState().drafts["se1"]).toBe("half a thought\n\nfirst, fixed"));
    expect(store.getState().toasts.some((t) => t.text.includes("already gone out"))).toBe(true);
  });

  it("keeps what was typed when the message leaves while its field is open", async () => {
    // THE MUTANT: the row unmounting with its field — a hold that expired takes the edit with it.
    const { api, store } = await mount([prompt("q1", "first")]);
    await edit(0);
    fireEvent.change(field()!, { target: { value: "first, rewritten" } });
    api.queuedPrompts.length = 0;
    act(() => store.getState().applySessionQueue("se1", []));
    await waitFor(() => expect(store.getState().drafts["se1"]).toBe("first, rewritten"));
  });
});

describe("what the queue says it is", () => {
  const head = () => document.querySelector(".composer-queue .queue-head")?.textContent ?? "";

  it("one message: names itself, and when it goes", async () => {
    await mount([prompt("q1", "first")]);
    expect(head()).toContain("Queued");
    expect(head()).toContain("sends when this turn ends");
    // Nothing to order, so nothing to order it with.
    expect(document.querySelector(".queue-grip")).toBeNull();
    expect(document.querySelector(".queue-up")).toBeNull();
  });

  it("says the next turn, not this one, when no turn is running", async () => {
    // THE MUTANT: the head ignoring the session's state — "after this turn" with no turn to be after.
    const { store } = await mount([prompt("q1", "first")]);
    act(() => store.setState({ sessionStatus: { se1: "idle" } }));
    expect(head()).toContain("sends when the next turn ends");
  });

  it("two messages: counts them and says they go in order", async () => {
    await mount([prompt("q1", "first"), prompt("q2", "second")]);
    expect(head()).toContain("2 queued");
    expect(head()).toContain("in order");
    expect(rows()).toHaveLength(2);
    expect(document.querySelector(".queue-fold")).toBeNull();
  });

  it("shows two lines of a message, and the rest of it on a click", async () => {
    // THE MUTANT: a text that does not open — a long message stays cut off at its second line.
    await mount([prompt("q1", "a long message\nthat runs on\nand on")]);
    const text = rows()[0]!.querySelector<HTMLButtonElement>(".queue-text")!;
    expect(text.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(text);
    expect(text.getAttribute("aria-expanded")).toBe("true");
    expect(text.hasAttribute("data-long")).toBe(true);
    fireEvent.click(text);
    expect(text.hasAttribute("data-long")).toBe(false);
  });
});

describe("a queue of three or more", () => {
  const three = [prompt("q1", "first"), prompt("q2", "second"), prompt("q3", "third")];
  const fold = () => screen.getByRole("button", { name: /Show (all|less)/ });

  it("folds to one line naming the count and what goes next", async () => {
    // THE MUTANT: the fold starting at four — three full rows push the prompter halfway up the pane.
    await mount(three);
    expect(rows()).toHaveLength(0);
    const head = document.querySelector(".queue-head")!.textContent!;
    expect(head).toContain("3 queued");
    expect(head).toContain("Next: first");
    expect(fold().getAttribute("aria-expanded")).toBe("false");
  });

  it("opens to every row and folds again", async () => {
    await mount(three);
    fireEvent.click(fold());
    expect(rows().map((r) => r.querySelector(".queue-text")?.textContent)).toEqual(["first", "second", "third"]);
    expect(fold().getAttribute("aria-expanded")).toBe("true");
    expect(fold().textContent).toContain("Show less");
    fireEvent.click(fold());
    expect(rows()).toHaveLength(0);
  });

  it("says on the folded line that one of them is being edited", async () => {
    await mount([...three.slice(0, 2), prompt("q3", "third", { held: true })]);
    expect(document.querySelector(".queue-head")!.textContent).toContain("1 being edited");
  });
});

describe("reordering the queue", () => {
  const order = () => rows().map((r) => r.querySelector(".queue-text")?.textContent);

  it("moves a message up and down one place with its buttons, by id", async () => {
    // THE MUTANT: Move down anchored one row short — the message lands where it already was.
    const { api } = await mount([prompt("q1", "first"), prompt("q2", "second")]);
    expect(rows()[0]!.querySelector<HTMLButtonElement>(".queue-up")!.disabled).toBe(true);
    expect(rows()[1]!.querySelector<HTMLButtonElement>(".queue-down")!.disabled).toBe(true);
    fireEvent.click(rows()[0]!.querySelector(".queue-down")!);
    await waitFor(() => expect(api.calls).toContain("moveQueued:se1:q1>end"));
  });

  it("shows the new order at once, before the server's broadcast", async () => {
    // THE MUTANT: a move that waits on the round trip — the row snaps back, then jumps.
    await mount([prompt("q1", "first"), prompt("q2", "second"), prompt("q3", "third")]);
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    fireEvent.click(rows()[2]!.querySelector(".queue-up")!);
    expect(order()).toEqual(["first", "third", "second"]);
  });

  it("moves with ⌥↑ and ⌥↓ from anywhere in the row", async () => {
    // THE MUTANT: the keys not wired — reorder only for a pointer that can drag.
    const { api } = await mount([prompt("q1", "first"), prompt("q2", "second")]);
    fireEvent.keyDown(rows()[1]!.querySelector(".queue-text")!, { key: "ArrowUp", altKey: true });
    await waitFor(() => expect(api.calls).toContain("moveQueued:se1:q2>q1"));
    // Without ⌥ the arrow is the arrow's, and moves nothing.
    fireEvent.keyDown(rows()[0]!.querySelector(".queue-text")!, { key: "ArrowDown" });
    expect(api.calls.filter((c) => c.startsWith("moveQueued"))).toHaveLength(1);
  });

  it("moves a message dragged by its handle to where it is dropped", async () => {
    // THE MUTANT: the drop's side swapped — a message dropped on a row's top half lands under it.
    const { api } = await mount([prompt("q1", "first"), prompt("q2", "second"), prompt("q3", "third")]);
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    const types: string[] = [];
    const dataTransfer = { types, setData: (t: string) => { types.push(t); }, setDragImage: () => {}, effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(rows()[0]!.querySelector(".queue-grip")!, { dataTransfer });
    // jsdom lays nothing out, so every point is a row's top half: a drop on the third row lands in front of it.
    fireEvent.dragOver(rows()[2]!, { dataTransfer });
    expect(rows()[2]!.getAttribute("data-drop")).toBe("before");
    fireEvent.drop(rows()[2]!, { dataTransfer });
    await waitFor(() => expect(api.calls).toContain("moveQueued:se1:q1>q3"));
    expect(order()).toEqual(["second", "first", "third"]);
  });

  it("does not offer to move the message being edited", async () => {
    await mount([prompt("q1", "first"), prompt("q2", "second")]);
    fireEvent.click(rows()[1]!.querySelector(".queue-edit-btn")!);
    await waitFor(() => expect(document.querySelector(".queue-edit")).not.toBeNull());
    expect(rows()[1]!.querySelector<HTMLButtonElement>(".queue-up")!.disabled).toBe(true);
    expect(rows()[1]!.querySelector(".queue-grip")!.getAttribute("draggable")).toBe("false");
  });
});

describe("a message leaving the queue", () => {
  it("folds away rather than vanishing, inert while it does", async () => {
    // THE MUTANT: no leaving phase — Send now makes the row blink out.
    const { store } = await mount([prompt("q1", "first"), prompt("q2", "second")]);
    await waitFor(() => expect(rows()).toHaveLength(2));
    act(() => { store.getState().applySessionQueue("se1", [prompt("q2", "second")]); });
    const ghost = document.querySelector(".composer-queue-item[data-leaving]");
    expect(ghost?.textContent).toContain("first");
    expect(ghost?.hasAttribute("inert")).toBe(true);
    expect(rows()).toHaveLength(1);
    await waitFor(() => expect(document.querySelector(".composer-queue-item[data-leaving]")).toBeNull());
  });

  it("goes at once under Reduce motion", async () => {
    // THE MUTANT: the fold kept under Reduce motion — a ghost that holds still for its duration.
    const was = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
    try {
      const { store } = await mount([prompt("q1", "first"), prompt("q2", "second")]);
      await waitFor(() => expect(rows()).toHaveLength(2));
      act(() => { store.getState().applySessionQueue("se1", [prompt("q2", "second")]); });
      expect(document.querySelector(".composer-queue-item[data-leaving]")).toBeNull();
    } finally { window.matchMedia = was; }
  });
});
