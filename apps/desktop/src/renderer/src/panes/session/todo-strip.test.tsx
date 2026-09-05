import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { sessionEvent } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { SessionPane } from "./SessionPane";
import { TodoStrip } from "./TodoStrip";
import { reduceAll } from "./transcript-model";
import type { Todo } from "./rich/tool-view";

const q = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const strip = () => document.querySelector(".composer-todos");
const items = () => q(".composer-todos .todo-list li").map((li) => li.textContent);

const todo = (content: string, status: Todo["status"]): Todo => ({ content, status, activeForm: null });
const HALF: Todo[] = [todo("Parse the payload", "completed"), todo("Draw the strip", "in_progress"), todo("Test it", "pending")];
const ALL_DONE: Todo[] = HALF.map((t) => ({ ...t, status: "completed" }));

/** The pane, seeded from persisted events — the same fold a relaunch performs. */
async function mountPane(events: Parameters<typeof reduceAll>[0]) {
  const api = fakeApi({ sessions: [session("se1", "s1", { status: "idle" })] });
  const store = createAppStore(api); await store.getState().boot();
  store.setState({ sessionStatus: { se1: "idle" }, transcripts: { se1: { lastSeq: events.length, t: reduceAll(events) } } });
  const r = render(<StoreContext.Provider value={store}><SessionPane item={item("i9", "s1", { kind: "session", refId: "se1", title: "s" })} visible /></StoreContext.Provider>);
  return { store, ...r };
}

const write = (id: string, todos: unknown) =>
  sessionEvent("tool_call", { toolUseId: id, name: "TodoWrite", input: { todos }, parentToolUseId: null });

describe("TodoStrip", () => {
  it("draws nothing at all for a session with no plan — no header, no rule, no gap", () => {
    render(<TodoStrip todos={[]} />);
    expect(strip()).toBeNull();
  });

  it("is open while work remains, and the list is reachable", () => {
    render(<TodoStrip todos={HALF} />);
    expect(strip()).toHaveAttribute("data-open");
    expect(items()).toEqual(["Parse the payload", "Draw the strip", "Test it"]);
    expect(document.querySelector(".composer-todos-clip")).not.toHaveAttribute("inert");
  });

  it("collapses itself once every item is done, rather than holding prompter height open", () => {
    render(<TodoStrip todos={ALL_DONE} />);
    expect(strip()).not.toHaveAttribute("data-open");
    // Collapsed, not unmounted: the shut strip is still the record that the plan finished.
    expect(document.querySelector(".composer-todos-clip")).toHaveAttribute("inert");
    expect(screen.getByRole("button", { name: "Plan complete" })).toBeInTheDocument();
  });

  it("keeps the progress bar and the count outside the collapse — a shut strip still reports", () => {
    render(<TodoStrip todos={ALL_DONE} />);
    const track = document.querySelector<HTMLElement>(".composer-todos > .todo-track");
    expect(track).not.toBeNull();
    expect(document.querySelector(".composer-todos-wrap")!.contains(track!)).toBe(false);
    expect(document.querySelector(".composer-todos .todo-fill")!.getAttribute("style")).toContain("width: 100%");
    expect(document.querySelector(".composer-todos .todo-count")).toHaveTextContent("3 of 3");
  });

  it("a click closes an open strip, and the choice outlives the next plan update", () => {
    const { rerender } = render(<TodoStrip todos={HALF} />);
    fireEvent.click(screen.getByRole("button", { name: "Plan" }));
    expect(strip()).not.toHaveAttribute("data-open");
    // An agent rewriting its list must not shove the prompter down under a reader's hands.
    rerender(<TodoStrip todos={[...HALF, todo("And this", "pending")]} />);
    expect(strip()).not.toHaveAttribute("data-open");
  });

  it("names what is in flight in the agent's own words", () => {
    render(<TodoStrip todos={[todo("Run the suite", "pending"), { content: "Build", status: "in_progress", activeForm: "Building the app" }]} />);
    expect(document.querySelector(".composer-todos .todo-active")).toHaveTextContent("Building the app");
  });
});

describe("the strip on the pane", () => {
  it("sits inside the prompter's dock and ABOVE the card, so the two are one object that moves as one", async () => {
    await mountPane([write("t1", [{ content: "Parse the payload", status: "pending" }])]);
    const dock = document.querySelector(".composer-dock")!;
    const s = dock.querySelector(":scope > .composer-todos");
    const card = dock.querySelector(":scope > .composer");
    expect(s).not.toBeNull();
    expect(card).not.toBeNull();
    expect(s!.compareDocumentPosition(card!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows the newest plan, and a session rebuilt from its persisted events shows it again", async () => {
    const events = [
      write("t1", [{ content: "Parse the payload", status: "pending" }]),
      sessionEvent("assistant_text", { messageId: "m", text: "on it" }),
      write("t2", [{ content: "Parse the payload", status: "completed" }, { content: "Draw the strip", status: "in_progress" }]),
    ];
    const first = await mountPane(events);
    expect(items()).toEqual(["Parse the payload", "Draw the strip"]);
    first.unmount();
    // A relaunch holds no strip state of its own: the same event log folds back to the same plan.
    await mountPane(events);
    expect(items()).toEqual(["Parse the payload", "Draw the strip"]);
  });

  it("stays away from the hero prompter — a session with nothing to read has no plan to pin", async () => {
    await mountPane([]);
    expect(document.querySelector(".session-pane")).toHaveAttribute("data-composer", "hero");
    expect(strip()).toBeNull();
  });

  it("leaves the TodoWrite card alone — the log keeps the plan as it was written", async () => {
    await mountPane([write("t1", [{ content: "Parse the payload", status: "pending" }])]);
    const card = screen.getByRole("button", { name: /TodoWrite tool call/ });
    expect(card).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(card);
    expect(q(".tool-body .todo-list li").map((li) => li.textContent)).toEqual(["Parse the payload"]);
  });
});
