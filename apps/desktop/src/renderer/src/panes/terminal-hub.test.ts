import { describe, expect, it } from "vitest";
import { terminalBackground, TerminalHub, type HubTransport, type TerminalLike } from "./terminal-hub";

type Listener = (payload: unknown) => void;
function fakeTransport() {
  const listeners = new Map<string, Set<Listener>>();
  const calls: { method: string; params: unknown }[] = [];
  const transport: HubTransport = {
    on: (event, fn) => { const s = listeners.get(event) ?? new Set(); s.add(fn as Listener); listeners.set(event, s); return () => s.delete(fn as Listener); },
    call: async (method, params) => { calls.push({ method, params }); return { ok: true }; },
  };
  const emit = (event: string, payload: unknown) => { for (const fn of listeners.get(event) ?? []) fn(payload); };
  const count = (event: string) => listeners.get(event)?.size ?? 0;
  return { transport, emit, calls, count };
}

function fakeTerm() {
  const writes: string[] = []; let dataFn: ((d: string) => void) | null = null; let disposed = false; let opened: HTMLElement | null = null;
  const term: TerminalLike & { writes: string[]; typed(d: string): void; disposed(): boolean; openedIn(): HTMLElement | null } = {
    cols: 80, rows: 24, writes,
    open: (el) => { opened = el; }, write: (d) => { writes.push(d); }, dispose: () => { disposed = true; }, focus: () => {},
    onData: (fn) => { dataFn = fn; return { dispose() { dataFn = null; } }; },
    onResize: () => ({ dispose() {} }),
    typed: (d) => dataFn?.(d), disposed: () => disposed, openedIn: () => opened,
  };
  return term;
}

function setup() {
  const t = fakeTransport();
  const terms: ReturnType<typeof fakeTerm>[] = [];
  const hub = new TerminalHub(t.transport, () => { const term = fakeTerm(); terms.push(term); return { term, fit: { fit() {} } }; });
  return { ...t, hub, terms };
}

describe("TerminalHub", () => {
  it("subscribes once and buffers data that arrives before a pane attaches, then flushes into xterm on attach", () => {
    const { hub, emit, count, terms } = setup();
    hub.acquire("t1"); hub.acquire("t1"); hub.acquire("t2");
    expect(count("terminal.data")).toBe(1);
    expect(count("terminal.exit")).toBe(1);
    emit("terminal.data", { terminalId: "t1", data: "hello " });
    emit("terminal.data", { terminalId: "t1", data: "world" });
    expect(terms[0]!.writes).toEqual([]); // not opened yet
    const container = document.createElement("div"); document.body.appendChild(container);
    hub.acquire("t1").attach(container);
    expect(terms[0]!.openedIn()).toBe(hub.acquire("t1").host);
    expect(hub.acquire("t1").host.parentElement).toBe(container);
    expect(terms[0]!.writes).toEqual(["hello world"]);
    emit("terminal.data", { terminalId: "t1", data: "!" });
    expect(terms[0]!.writes).toEqual(["hello world", "!"]);
  });

  it("buffers data for terminals nobody has acquired yet", () => {
    const { hub, emit, terms } = setup();
    hub.acquire("other"); // creates the subscription
    emit("terminal.data", { terminalId: "late", data: "early bird" });
    const c = document.createElement("div"); document.body.appendChild(c);
    hub.acquire("late").attach(c);
    expect(terms[1]!.writes).toEqual(["early bird"]);
  });

  it("detach/re-attach moves the same host and keeps the same xterm (no data lost, opened once)", () => {
    const { hub, emit, terms } = setup();
    const a = document.createElement("div"); const b = document.createElement("div"); document.body.append(a, b);
    const e = hub.acquire("t1");
    e.attach(a); emit("terminal.data", { terminalId: "t1", data: "1" });
    e.detach();
    expect(e.host.parentElement).toBeNull();
    emit("terminal.data", { terminalId: "t1", data: "2" }); // still streams into the live xterm while detached
    e.attach(b);
    expect(e.host.parentElement).toBe(b);
    expect(terms).toHaveLength(1);
    expect(terms[0]!.writes).toEqual(["1", "2"]);
    // StrictMode-style double mount: attach twice into the same container is idempotent
    e.attach(b); e.attach(b);
    expect(b.querySelectorAll(".terminal-host")).toHaveLength(1);
  });

  it("forwards typed input to terminals.write and announces exit", () => {
    const { hub, emit, calls, terms } = setup();
    const c = document.createElement("div"); document.body.appendChild(c);
    hub.acquire("t1").attach(c);
    terms[0]!.typed("ls\r");
    expect(calls.some((x) => x.method === "terminals.write" && (x.params as { data: string }).data === "ls\r")).toBe(true);
    expect(calls.some((x) => x.method === "terminals.resize")).toBe(true);
    emit("terminal.exit", { terminalId: "t1", exitCode: 0 });
    expect(terms[0]!.writes.at(-1)).toContain("exited with code 0");
  });

  it("announces a dead terminal once when the server answers NOT_FOUND", async () => {
    const t = fakeTransport();
    const err = Object.assign(new Error("terminal x not found"), { code: "NOT_FOUND" });
    t.transport.call = async () => { throw err; };
    const terms: ReturnType<typeof fakeTerm>[] = [];
    const hub = new TerminalHub(t.transport, () => { const term = fakeTerm(); terms.push(term); return { term, fit: { fit() {} } }; });
    const c = document.createElement("div"); document.body.appendChild(c);
    hub.acquire("dead").attach(c); // initial resize rejects
    await new Promise((r) => setTimeout(r, 0));
    expect(terms[0]!.writes.filter((w) => w.includes("[terminal is not running]"))).toHaveLength(1);
    terms[0]!.typed("ls\r"); // write rejects too — no second banner
    await new Promise((r) => setTimeout(r, 0));
    expect(terms[0]!.writes.filter((w) => w.includes("[terminal is not running]"))).toHaveLength(1);
  });

  it("hasData/onFirstData: false until the first output, listeners fire exactly once, late subscribers see hasData", () => {
    const { hub, emit } = setup();
    hub.acquire("t1");
    expect(hub.hasData("t1")).toBe(false);
    let fired = 0;
    hub.onFirstData("t1", () => fired++);
    emit("terminal.data", { terminalId: "t1", data: "boot" });
    expect(hub.hasData("t1")).toBe(true);
    expect(fired).toBe(1);
    emit("terminal.data", { terminalId: "t1", data: "more" });
    expect(fired).toBe(1); // first data only — never again
    // Late subscription after data exists is inert; the caller checks hasData first.
    hub.onFirstData("t1", () => fired++);
    emit("terminal.data", { terminalId: "t1", data: "even more" });
    expect(fired).toBe(1);
  });

  it("onFirstData unsubscribe stops the notification; a terminal.exit also counts as first output", () => {
    const { hub, emit } = setup();
    hub.acquire("t1"); hub.acquire("t2");
    let fired = 0;
    const off = hub.onFirstData("t1", () => fired++);
    off();
    emit("terminal.data", { terminalId: "t1", data: "x" });
    expect(fired).toBe(0);
    // The exit banner is output too: the empty-pane hint must not sit on top of it.
    expect(hub.hasData("t2")).toBe(false);
    emit("terminal.exit", { terminalId: "t2", exitCode: 1 });
    expect(hub.hasData("t2")).toBe(true);
  });

  it("dispose clears the hasData flag with the buffer", () => {
    const { hub, emit } = setup();
    const c = document.createElement("div"); document.body.appendChild(c);
    hub.acquire("t1").attach(c);
    emit("terminal.data", { terminalId: "t1", data: "x" });
    expect(hub.hasData("t1")).toBe(true);
    hub.dispose("t1");
    expect(hub.hasData("t1")).toBe(false);
  });

  it("dispose tears down xterm, host and buffer; re-acquire starts from a fresh instance", () => {
    const { hub, emit, terms } = setup();
    const c = document.createElement("div"); document.body.appendChild(c);
    const e = hub.acquire("t1"); e.attach(c);
    hub.dispose("t1");
    expect(terms[0]!.disposed()).toBe(true);
    expect(c.children).toHaveLength(0);
    expect(hub.has("t1")).toBe(false);
    emit("terminal.data", { terminalId: "t1", data: "ghost" });
    // acquiring again yields a fresh instance with the post-dispose data only
    hub.acquire("t1").attach(c);
    expect(terms[1]!.writes).toEqual(["ghost"]);
  });
});

describe("terminalBackground", () => {
  it("reads --rl-terminal-bg from :root, defaulting to #17181b", () => {
    expect(terminalBackground()).toBe("#17181b");
    document.documentElement.style.setProperty("--rl-terminal-bg", "#101010");
    expect(terminalBackground()).toBe("#101010");
    document.documentElement.style.removeProperty("--rl-terminal-bg");
  });
});
