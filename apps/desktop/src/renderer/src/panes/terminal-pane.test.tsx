import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { TerminalPane } from "./TerminalPane";
import { TerminalMeta } from "./TerminalMeta";
import { TerminalHub, setTerminalHubForTests, type HubTransport, type TerminalLike } from "./terminal-hub";
import { item } from "../state/store.test-fakes";

type Listener = (payload: unknown) => void;
function fakeHub() {
  const listeners = new Map<string, Set<Listener>>();
  const transport: HubTransport = {
    on: (event, fn) => { const s = listeners.get(event) ?? new Set(); s.add(fn as Listener); listeners.set(event, s); return () => s.delete(fn as Listener); },
    // `terminals.read` has to answer honestly: the hub holds a cursor now, and a chunk it cannot
    // place against one is held rather than written.
    call: async (method) => (method === "terminals.read"
      ? { runId: "r1", seq, live: "", truncated: false, running: true, history: null }
      : { ok: true }),
  };
  let seq = 0;
  const emit = (event: string, payload: unknown) => { for (const fn of listeners.get(event) ?? []) fn(payload); };
  /** A chunk that follows this client's cursor. The hub holds anything it cannot place and reads
   *  instead, so a bare emit with no runId/seq would never reach the pane. */
  const emitData = (terminalId: string, data: string) => emit("terminal.data", { terminalId, data, runId: "r1", seq: ++seq });
  /** Let the hub's catch-up read settle — acquiring a terminal now asks what it missed. */
  const settled = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const term: TerminalLike = {
    cols: 80, rows: 24, open: () => {}, write: () => {}, dispose: () => {}, focus: () => {},
    onData: () => ({ dispose() {} }), onResize: () => ({ dispose() {} }),
  };
  const hub = new TerminalHub(transport, () => ({ term, fit: { fit() {} } }));
  return { hub, emit, emitData, settled };
}

describe("TerminalPane empty hint", () => {
  beforeEach(() => {
    // jsdom has no ResizeObserver.
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  });
  afterEach(() => { setTerminalHubForTests(null); vi.unstubAllGlobals(); });

  it("shows the hint (cwd name + shortcuts) while the buffer is empty, fades it on first data", async () => {
    const { hub, emitData, settled } = fakeHub();
    setTerminalHubForTests(hub);
    render(<TerminalPane item={item("i1", "s1", { kind: "terminal", refId: "t1", title: "homework" })} visible />);
    await settled();
    const hint = document.querySelector(".terminal-hint")!;
    expect(hint).not.toHaveAttribute("data-hidden");
    expect(hint).toHaveTextContent("homework");
    expect(hint).toHaveTextContent("⌘\\ split · ⌘K commands");
    act(() => emitData("t1", "$ "));
    expect(hint).toHaveAttribute("data-hidden"); // faded out (kept mounted for the opacity transition)
    expect(hint).toHaveAttribute("aria-hidden", "true");
  });

  it("a pane mounted for a terminal that already produced output never shows the hint", async () => {
    const { hub, emitData, settled } = fakeHub();
    setTerminalHubForTests(hub);
    hub.acquire("t1");
    await settled();
    emitData("t1", "existing scrollback");
    render(<TerminalPane item={item("i1", "s1", { kind: "terminal", refId: "t1", title: "homework" })} visible />);
    expect(document.querySelector(".terminal-hint")).toHaveAttribute("data-hidden");
  });

  it("data for a different terminal does not clear this pane's hint", async () => {
    const { hub, emitData, settled } = fakeHub();
    setTerminalHubForTests(hub);
    render(<TerminalPane item={item("i1", "s1", { kind: "terminal", refId: "t1", title: "homework" })} visible />);
    await settled();
    act(() => emitData("t-other", "noise"));
    expect(document.querySelector(".terminal-hint")).not.toHaveAttribute("data-hidden");
  });
});

describe("the terminal pane's state word", () => {
  it("says nothing at all while the pane is live", async () => {
    const { hub, settled } = fakeHub();
    setTerminalHubForTests(hub);
    hub.acquire("t1");
    await settled();
    const { container } = render(<TerminalMeta item={item("i1", "s1", { kind: "terminal", refId: "t1", title: "homework" })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says Not running rather than letting a dead pane look idle, and updates in place", async () => {
    const { hub, emit, settled } = fakeHub();
    setTerminalHubForTests(hub);
    hub.acquire("t1");
    await settled();
    render(<TerminalMeta item={item("i1", "s1", { kind: "terminal", refId: "t1", title: "homework" })} />);
    // MUTANT: forget to announce on exit and the bar keeps claiming a shell that is gone is fine.
    await act(async () => { emit("terminal.exit", { terminalId: "t1", exitCode: 0 }); });
    expect(document.querySelector(".terminal-bar-meta")).toHaveTextContent("Not running");
  });

  it("renders nothing when there is no hub to ask — jsdom has no preload, and that is not an error", () => {
    setTerminalHubForTests(null);
    const { container } = render(<TerminalMeta item={item("i1", "s1", { kind: "terminal", refId: "t1", title: "homework" })} />);
    expect(container).toBeEmptyDOMElement();
  });
});
