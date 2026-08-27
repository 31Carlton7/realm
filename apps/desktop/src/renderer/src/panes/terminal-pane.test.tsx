import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { TerminalPane } from "./TerminalPane";
import { TerminalHub, setTerminalHubForTests, type HubTransport, type TerminalLike } from "./terminal-hub";
import { item } from "../state/store.test-fakes";

type Listener = (payload: unknown) => void;
function fakeHub() {
  const listeners = new Map<string, Set<Listener>>();
  const transport: HubTransport = {
    on: (event, fn) => { const s = listeners.get(event) ?? new Set(); s.add(fn as Listener); listeners.set(event, s); return () => s.delete(fn as Listener); },
    call: async () => ({ ok: true }),
  };
  const emit = (event: string, payload: unknown) => { for (const fn of listeners.get(event) ?? []) fn(payload); };
  const term: TerminalLike = {
    cols: 80, rows: 24, open: () => {}, write: () => {}, dispose: () => {}, focus: () => {},
    onData: () => ({ dispose() {} }), onResize: () => ({ dispose() {} }),
  };
  const hub = new TerminalHub(transport, () => ({ term, fit: { fit() {} } }));
  return { hub, emit };
}

describe("TerminalPane empty hint", () => {
  beforeEach(() => {
    // jsdom has no ResizeObserver.
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  });
  afterEach(() => { setTerminalHubForTests(null); vi.unstubAllGlobals(); });

  it("shows the hint (cwd name + shortcuts) while the buffer is empty, fades it on first data", () => {
    const { hub, emit } = fakeHub();
    setTerminalHubForTests(hub);
    render(<TerminalPane item={item("i1", "s1", { kind: "terminal", refId: "t1", title: "homework" })} visible />);
    const hint = document.querySelector(".terminal-hint")!;
    expect(hint).not.toHaveAttribute("data-hidden");
    expect(hint).toHaveTextContent("homework");
    expect(hint).toHaveTextContent("⌘\\ split · ⌘K commands");
    act(() => emit("terminal.data", { terminalId: "t1", data: "$ " }));
    expect(hint).toHaveAttribute("data-hidden"); // faded out (kept mounted for the opacity transition)
    expect(hint).toHaveAttribute("aria-hidden", "true");
  });

  it("a pane mounted for a terminal that already produced output never shows the hint", () => {
    const { hub, emit } = fakeHub();
    setTerminalHubForTests(hub);
    hub.acquire("t1");
    emit("terminal.data", { terminalId: "t1", data: "existing scrollback" });
    render(<TerminalPane item={item("i1", "s1", { kind: "terminal", refId: "t1", title: "homework" })} visible />);
    expect(document.querySelector(".terminal-hint")).toHaveAttribute("data-hidden");
  });

  it("data for a different terminal does not clear this pane's hint", () => {
    const { hub, emit } = fakeHub();
    setTerminalHubForTests(hub);
    render(<TerminalPane item={item("i1", "s1", { kind: "terminal", refId: "t1", title: "homework" })} visible />);
    act(() => emit("terminal.data", { terminalId: "t-other", data: "noise" }));
    expect(document.querySelector(".terminal-hint")).not.toHaveAttribute("data-hidden");
  });
});
