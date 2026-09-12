import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { sessionEvent, type DelegatedRun } from "@realm/contracts";
import { DOCK_PIN_MIN_PANE } from "./pane-dock";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { SessionPane } from "./SessionPane";
import { reduceAll } from "./transcript-model";

const ITEMS = { s1: [item("i9", "s1", { kind: "session", title: "Parent", refId: "se1" })] };
const SESSIONS = [session("se1", "s1", { title: "Parent" })];

/** A Task call, plus whatever the sub-agent did under it — the shape a real transcript carries:
 *  the child's calls arrive INTERLEAVED with the parent's, told apart only by `parentToolUseId`. */
const launch = (id: string, description: string, prompt = "") =>
  sessionEvent("tool_call", { toolUseId: id, name: "Task", input: { description, ...(prompt ? { prompt } : {}) }, parentToolUseId: null });
const under = (parent: string, id: string, name: string, input: Record<string, unknown>) =>
  sessionEvent("tool_call", { toolUseId: id, name, input, parentToolUseId: parent });
const result = (id: string, content: string, isError = false) =>
  sessionEvent("tool_result", { toolUseId: id, content, isError });

async function mount(events: ReturnType<typeof sessionEvent>[], delegatedRuns: Record<string, DelegatedRun[]> = {}) {
  const api = fakeApi({ items: ITEMS, sessions: SESSIONS, delegatedRuns });
  const store = createAppStore(api);
  await store.getState().boot();
  store.setState({ sessionStatus: { se1: "running" }, transcripts: { se1: { lastSeq: 0, t: reduceAll(events) } } });
  await store.getState().openItem("i9");
  const r = render(<StoreContext.Provider value={store}><SessionPane item={ITEMS.s1[0]!} visible /></StoreContext.Provider>);
  return { store, ...r };
}

const drawer = () => screen.getByRole("dialog", { name: /Sub-agent/ });
const watch = async (label: string) => {
  fireEvent.click(await screen.findByRole("button", { name: `Watch ${label}` }));
};

afterEach(() => cleanup());

describe("the sub-agent panel", () => {
  it("shows the calls the sub-agent made — the work that has never been visible anywhere else", async () => {
    /* A harness sub-agent has no session, no row and no pane. What it DOES leave is every call it
       made, carrying its launching call's id. Those calls are the whole of its working life. */
    await mount([
      launch("t1", "audit the mapper"),
      under("t1", "c1", "Read", { file_path: "/repo/mapper.ts" }),
      under("t1", "c2", "Bash", { command: "pnpm vitest run mapper" }),
    ]);
    await watch("audit the mapper");
    const body = within(drawer());
    expect(body.getByText("What it has done")).toBeInTheDocument();
    expect(body.getByText("2 calls")).toBeInTheDocument();
    expect(body.getByText("/repo/mapper.ts")).toBeInTheDocument();
    expect(body.getByText("pnpm vitest run mapper")).toBeInTheDocument();
  });

  it("does NOT show a call the parent made itself, only the ones made under this agent", async () => {
    /* THE MUTANT: list every tool call in the transcript. A sub-agent's drawer would then report the
       parent's own work as the child's, which is the one thing this panel exists to tell apart. */
    await mount([
      launch("t1", "audit the mapper"),
      under("t1", "c1", "Read", { file_path: "/repo/mapper.ts" }),
      sessionEvent("tool_call", { toolUseId: "p1", name: "Read", input: { file_path: "/repo/parent-only.ts" }, parentToolUseId: null }),
    ]);
    await watch("audit the mapper");
    const body = within(drawer());
    expect(body.getByText("/repo/mapper.ts")).toBeInTheDocument();
    expect(body.queryByText("/repo/parent-only.ts")).toBeNull();
    expect(body.getByText("1 call")).toBeInTheDocument();
  });

  it("shows the brief it was handed in full — the dock's label is the first eighty characters of it", async () => {
    const prompt = "Audit every mapper in packages/adapters and report anything that drops a field.";
    await mount([launch("t1", "audit the mapper", prompt)]);
    await watch("audit the mapper");
    const body = within(drawer());
    expect(body.getByText("What it was asked")).toBeInTheDocument();
    expect(body.getByText(/drops a field/)).toBeInTheDocument();
  });

  it("says it is still working out what to do rather than drawing an empty list", async () => {
    await mount([launch("t1", "audit the mapper")]);
    await watch("audit the mapper");
    expect(within(drawer()).getByText(/still working out what to do/)).toBeInTheDocument();
  });

  it("closes on a TRASH, not a ×: there is no object under this view to keep", async () => {
    /* design.md: a close that promises to preserve something must have something to preserve. This
       panel is a view opened at a moment; nothing of it is in the space, and the sub-agent behind it
       is untouched either way. */
    const { store } = await mount([launch("t1", "audit the mapper"), under("t1", "c1", "Read", { file_path: "/repo/m.ts" })]);
    await watch("audit the mapper");
    fireEvent.click(within(drawer()).getByRole("button", { name: "Close this sub-agent view" }));
    expect(store.getState().sessionDock.se1).toBeUndefined();
    // THE MUTANT: have the close delete or interrupt the run. The agent goes on working, and its
    // calls go on landing in the transcript — the strip still lists it.
    expect(await screen.findByRole("button", { name: "Watch audit the mapper" })).toBeInTheDocument();
  });

  it("nothing of the panel reaches the space: it docks to the pane, it is not a layout item", async () => {
    const { store } = await mount([launch("t1", "audit the mapper")]);
    const before = store.getState().items.length;
    await watch("audit the mapper");
    expect(store.getState().items).toHaveLength(before);
    expect(store.getState().items.some((i) => i.title.includes("audit the mapper"))).toBe(false);
  });

  it("fills in as the agent works — the calls land in this transcript while the panel is open", async () => {
    const { store } = await mount([launch("t1", "audit the mapper")]);
    await watch("audit the mapper");
    expect(within(drawer()).getByText(/still working out what to do/)).toBeInTheDocument();
    store.setState({ transcripts: { se1: { lastSeq: 1, t: reduceAll([
      launch("t1", "audit the mapper"),
      under("t1", "c1", "Read", { file_path: "/repo/mapper.ts" }),
    ]) } } });
    await waitFor(() => expect(within(drawer()).getByText("/repo/mapper.ts")).toBeInTheDocument());
  });

  it("shows the report once it lands, which is the whole point of having delegated", async () => {
    const { store } = await mount([launch("t1", "audit the mapper"), under("t1", "c1", "Read", { file_path: "/repo/m.ts" })]);
    await watch("audit the mapper");
    expect(within(drawer()).queryByText("What it reported")).toBeNull();
    store.setState({ transcripts: { se1: { lastSeq: 1, t: reduceAll([
      launch("t1", "audit the mapper"),
      under("t1", "c1", "Read", { file_path: "/repo/m.ts" }),
      result("t1", "Three mappers drop `parentToolUseId`."),
    ]) } } });
    const body = within(drawer());
    await waitFor(() => expect(body.getByText("What it reported")).toBeInTheDocument());
    expect(body.getByText(/Three mappers drop/)).toBeInTheDocument();
    // The clock stops rather than climbing on after the agent left.
    expect(body.getByText("finished")).toBeInTheDocument();
  });

  it("names a failure a failure", async () => {
    await mount([launch("t1", "audit the mapper"), result("t1", "the sub-agent ran out of context", true)]);
    // A settled call is no longer in flight, so the strip has dropped it — the drawer is opened
    // through the store, exactly as a row that is still there would.
    const store = createAppStore(fakeApi({ items: ITEMS, sessions: SESSIONS }));
    await store.getState().boot();
    store.setState({ sessionStatus: { se1: "idle" }, transcripts: { se1: { lastSeq: 0, t: reduceAll([
      launch("t1", "audit the mapper"), result("t1", "the sub-agent ran out of context", true),
    ]) } } });
    store.getState().toggleSessionDock("se1", { kind: "subagent", toolUseId: "t1" });
    await store.getState().openItem("i9");
    render(<StoreContext.Provider value={store}><SessionPane item={ITEMS.s1[0]!} visible /></StoreContext.Provider>);
    const body = within(await screen.findByRole("dialog", { name: /Sub-agent/ }));
    expect(body.getByText("It failed")).toBeInTheDocument();
    expect(body.getByText(/ran out of context/)).toBeInTheDocument();
  });

  it("shares ONE strip with the summary — opening either puts the other away", async () => {
    /* They dock to the same edge of the same pane. Held as two open flags they would each measure
       that edge, each claim it, and draw one over the other; one slot is what makes the strip a
       place with an occupant instead of two panels racing for a rectangle.

       THE MUTANT: give the summary back its own `useState`. Both panels then render at the same
       `right`/`top` and the one mounted second hides the first completely. */
    const { store } = await mount([launch("t1", "audit the mapper")]);
    store.getState().toggleSessionDock("se1", { kind: "summary" });
    expect(store.getState().sessionDock.se1).toEqual({ kind: "summary" });
    await watch("audit the mapper");
    expect(store.getState().sessionDock.se1).toEqual({ kind: "subagent", toolUseId: "t1" });
    expect(screen.queryByRole("dialog", { name: "Session summary" })).toBeNull();
  });

  it("the strip's own toggle closes it: the same thing docked twice is undocked", async () => {
    const { store } = await mount([launch("t1", "audit the mapper")]);
    store.getState().toggleSessionDock("se1", { kind: "subagent", toolUseId: "t1" });
    store.getState().toggleSessionDock("se1", { kind: "subagent", toolUseId: "t1" });
    expect(store.getState().sessionDock.se1).toBeUndefined();
    // A DIFFERENT sub-agent is a different occupant, not a close — the toggle is per thing, not
    // per kind, or watching the second of three agents would just shut the panel.
    store.getState().toggleSessionDock("se1", { kind: "subagent", toolUseId: "t1" });
    store.getState().toggleSessionDock("se1", { kind: "subagent", toolUseId: "t2" });
    expect(store.getState().sessionDock.se1).toEqual({ kind: "subagent", toolUseId: "t2" });
  });

  it("pins beside the transcript in a wide pane — and the PANE is what makes room", async () => {
    /* THE MUTANT, and the one that actually shipped: measure from a ref React has not attached yet.
       A child rendered inside the pane runs its layout effect before the pane's own ref is assigned,
       so the panel measured `null`, fell back to the whole WINDOW, decided it was wide enough to pin
       — and then wrote its "make room" attribute onto a pane it had never found. The panel pinned
       itself over the transcript it was supposed to sit beside, in every real window.

       jsdom lays nothing out, so the pane's width is stubbed; what is being pinned here is that the
       panel found the pane at all. */
    const real = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      return this.classList.contains("session-pane")
        ? ({ x: 0, y: 0, top: 0, left: 0, right: DOCK_PIN_MIN_PANE + 50, bottom: 800, width: DOCK_PIN_MIN_PANE + 50, height: 800, toJSON: () => ({}) } as DOMRect)
        : real.call(this);
    };
    try {
      await mount([launch("t1", "audit the mapper")]);
      await watch("audit the mapper");
      const panel = await screen.findByRole("dialog", { name: /Sub-agent/ });
      expect(panel).toHaveAttribute("data-pinned");
      expect(document.querySelector(".session-pane")).toHaveAttribute("data-dock-pinned");
      // Pinned, it stays: its whole job is to be readable while you work in the transcript beside it.
      fireEvent.mouseDown(document.body);
      expect(screen.getByRole("dialog", { name: /Sub-agent/ })).toBeInTheDocument();
    } finally { HTMLElement.prototype.getBoundingClientRect = real; }
  });

  it("floats in a narrow pane, and a click outside dismisses it", async () => {
    // jsdom's zero rects ARE the narrow case, so this needs no stub.
    await mount([launch("t1", "audit the mapper")]);
    await watch("audit the mapper");
    const panel = await screen.findByRole("dialog", { name: /Sub-agent/ });
    expect(panel).not.toHaveAttribute("data-pinned");
    expect(document.querySelector(".session-pane")).not.toHaveAttribute("data-dock-pinned");
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Sub-agent/ })).toBeNull());
  });

  it("Escape closes it in either mode", async () => {
    const { store } = await mount([launch("t1", "audit the mapper")]);
    await watch("audit the mapper");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(store.getState().sessionDock.se1).toBeUndefined());
  });

  it("says so when the launching call is no longer in the transcript, rather than drawing an empty panel", async () => {
    const { store } = await mount([launch("t1", "audit the mapper")]);
    await watch("audit the mapper");
    // What a compaction that dropped the call looks like from here.
    store.setState({ transcripts: { se1: { lastSeq: 1, t: reduceAll([]) } } });
    await waitFor(() => expect(screen.getByText(/no longer in the transcript/)).toBeInTheDocument());
  });
});
