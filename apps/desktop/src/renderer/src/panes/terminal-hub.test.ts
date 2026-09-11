import { describe, expect, it } from "vitest";
import { terminalBackground, terminalFont, TerminalHub, type HubTransport, type TerminalLike } from "./terminal-hub";

type Listener = (payload: unknown) => void;

/** A server that answers `terminals.read` from its own record of what each terminal has printed —
 *  the least a fake can be now that the hub holds a cursor and catches up through a real call. */
function fakeTransport() {
  const listeners = new Map<string, Set<Listener>>();
  const calls: { method: string; params: unknown }[] = [];
  const printed = new Map<string, { runId: string; seq: number; chunks: { seq: number; data: string }[] }>();
  const reads: { read?: Partial<ReadResult> } = {};
  const transport: HubTransport = {
    on: (event, fn) => { const s = listeners.get(event) ?? new Set(); s.add(fn as Listener); listeners.set(event, s); return () => s.delete(fn as Listener); },
    call: async (method, params) => {
      calls.push({ method, params });
      if (method !== "terminals.read") return { ok: true };
      const p = params as { terminalId: string; cursor: { runId: string; seq: number } | null };
      const rec = printed.get(p.terminalId) ?? { runId: "r1", seq: 0, chunks: [] };
      const usable = p.cursor !== null && p.cursor.runId === rec.runId;
      const live = rec.chunks.filter((c) => !usable || c.seq > p.cursor!.seq).map((c) => c.data).join("");
      return { runId: rec.runId, seq: rec.seq, live, truncated: false, running: true, history: null, ...reads.read };
    },
  };
  /** Emit a chunk, and record it so a later `terminals.read` can hand it back. */
  const emitData = (terminalId: string, data: string, over: { runId?: string; seq?: number } = {}) => {
    const rec = printed.get(terminalId) ?? { runId: "r1", seq: 0, chunks: [] };
    rec.runId = over.runId ?? rec.runId;
    rec.seq = over.seq ?? rec.seq + 1;
    rec.chunks.push({ seq: rec.seq, data });
    printed.set(terminalId, rec);
    emit("terminal.data", { terminalId, data, runId: rec.runId, seq: rec.seq });
  };
  const emit = (event: string, payload: unknown) => { for (const fn of listeners.get(event) ?? []) fn(payload); };
  const count = (event: string) => listeners.get(event)?.size ?? 0;
  return { transport, emit, emitData, calls, count, reads };
}

type ReadResult = { runId: string; seq: number; live: string; truncated: boolean; running: boolean; history: { data: string; cols: number; rows: number } | null };

/**
 * Let the catch-up settle.
 *
 * Acquiring a terminal now ASKS the server what this client missed, because with a daemon the client
 * may have been away since before the server booted. Output that arrives while that read is in flight
 * is held rather than written, so a synchronous assertion sees an empty pane.
 */
const settled = () => new Promise<void>((r) => setTimeout(r, 0));

function fakeTerm() {
  const writes: string[] = []; let dataFn: ((d: string) => void) | null = null; let disposed = false; let opened: HTMLElement | null = null;
  const term: TerminalLike & { writes: string[]; typed(d: string): void; disposed(): boolean; openedIn(): HTMLElement | null } = {
    cols: 80, rows: 24, writes, options: { fontFamily: "start" },
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
  const fits: number[] = [];
  const hub = new TerminalHub(t.transport, () => { const term = fakeTerm(); terms.push(term); return { term, fit: { fit() { fits.push(terms.indexOf(term)); } } }; });
  return { ...t, hub, terms, fits };
}

describe("TerminalHub", () => {
  it("subscribes once and buffers data that arrives before a pane attaches, then flushes into xterm on attach", async () => {
    const { hub, emitData, count, terms } = setup();
    hub.acquire("t1"); hub.acquire("t1"); hub.acquire("t2");
    expect(count("terminal.data")).toBe(1);
    expect(count("terminal.exit")).toBe(1);
    emitData("t1", "hello ");
    emitData("t1", "world");
    await settled();
    expect(terms[0]!.writes).toEqual([]); // not opened yet
    const container = document.createElement("div"); document.body.appendChild(container);
    hub.acquire("t1").attach(container);
    expect(terms[0]!.openedIn()).toBe(hub.acquire("t1").host);
    expect(hub.acquire("t1").host.parentElement).toBe(container);
    expect(terms[0]!.writes).toEqual(["hello world"]);
    emitData("t1", "!");
    expect(terms[0]!.writes).toEqual(["hello world", "!"]);
  });

  it("buffers data for terminals nobody has acquired yet", async () => {
    const { hub, emitData, terms } = setup();
    hub.acquire("other"); // creates the subscription
    emitData("late", "early bird");
    const c = document.createElement("div"); document.body.appendChild(c);
    hub.acquire("late").attach(c);
    // The first acquire ASKS what it missed, and that answer is where "early bird" comes back from —
    // a chunk broadcast before this client held a cursor is one it can only learn about by reading.
    await settled();
    expect(terms[1]!.writes.join("")).toContain("early bird");
  });

  it("detach/re-attach moves the same host and keeps the same xterm (no data lost, opened once)", async () => {
    const { hub, emitData, terms } = setup();
    const a = document.createElement("div"); const b = document.createElement("div"); document.body.append(a, b);
    const e = hub.acquire("t1");
    await settled(); // the acquire's catch-up, so the chunks below stream rather than being held
    e.attach(a); emitData("t1", "1");
    e.detach();
    expect(e.host.parentElement).toBeNull();
    emitData("t1", "2"); // still streams into the live xterm while detached
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

  it("hasData/onFirstData: false until the first output, listeners fire exactly once, late subscribers see hasData", async () => {
    const { hub, emitData } = setup();
    hub.acquire("t1");
    await settled();
    expect(hub.hasData("t1")).toBe(false);
    let fired = 0;
    hub.onFirstData("t1", () => fired++);
    emitData("t1", "boot");
    expect(hub.hasData("t1")).toBe(true);
    expect(fired).toBe(1);
    emitData("t1", "more");
    expect(fired).toBe(1); // first data only — never again
    // Late subscription after data exists is inert; the caller checks hasData first.
    hub.onFirstData("t1", () => fired++);
    emitData("t1", "even more");
    expect(fired).toBe(1);
  });

  it("onFirstData unsubscribe stops the notification; a terminal.exit also counts as first output", async () => {
    const { hub, emit, emitData } = setup();
    hub.acquire("t1"); hub.acquire("t2");
    await settled();
    let fired = 0;
    const off = hub.onFirstData("t1", () => fired++);
    off();
    emitData("t1", "x");
    expect(fired).toBe(0);
    // The exit banner is output too: the empty-pane hint must not sit on top of it.
    expect(hub.hasData("t2")).toBe(false);
    emit("terminal.exit", { terminalId: "t2", exitCode: 1 });
    expect(hub.hasData("t2")).toBe(true);
  });

  it("dispose clears the hasData flag with the buffer", async () => {
    const { hub, emitData } = setup();
    const c = document.createElement("div"); document.body.appendChild(c);
    hub.acquire("t1").attach(c);
    await settled();
    emitData("t1", "x");
    expect(hub.hasData("t1")).toBe(true);
    hub.dispose("t1");
    expect(hub.hasData("t1")).toBe(false);
  });

  it("dispose tears down xterm, host and buffer; re-acquire starts from a fresh instance", async () => {
    const { hub, emitData, terms } = setup();
    const c = document.createElement("div"); document.body.appendChild(c);
    const e = hub.acquire("t1"); e.attach(c);
    await settled();
    hub.dispose("t1");
    expect(terms[0]!.disposed()).toBe(true);
    expect(c.children).toHaveLength(0);
    expect(hub.has("t1")).toBe(false);
    emitData("t1", "ghost");
    // Acquiring again yields a fresh instance, and the catch-up is what puts the output on it — the
    // cursor went with the dispose, so this client is a first-time reader again.
    hub.acquire("t1").attach(c);
    await settled();
    expect(terms[1]!.writes.join("")).toContain("ghost");
  });
});

describe("catching up on output that arrived with nobody listening", () => {
  const mount = (hub: TerminalHub, id: string) => {
    const c = document.createElement("div"); document.body.appendChild(c);
    return hub.acquire(id).attach(c);
  };

  it("asks what it missed on the very first acquire, because it may have been away since before this server booted", async () => {
    const { hub, calls } = setup();
    hub.acquire("t1");
    await settled();
    const read = calls.find((c) => c.method === "terminals.read");
    expect(read).toBeDefined();
    expect(read!.params).toEqual({ terminalId: "t1", cursor: null });
  });

  it("holds chunks that arrive mid-read and applies them after it, in order and without doubling", async () => {
    const { hub, emitData, terms } = setup();
    mount(hub, "t1");
    emitData("t1", "one ");
    emitData("t1", "two ");
    await settled();
    emitData("t1", "three");
    // MUTANT: apply the pending chunks before the read, or fail to drop the ones the read already
    // covered, and the pane draws its own output twice.
    expect(terms[0]!.writes.join("")).toBe("one two three");
  });

  it("re-reads on a gap in seq rather than writing output with a hole in it", async () => {
    const { hub, emit, calls, terms } = setup();
    mount(hub, "t1");
    await settled();
    const before = calls.filter((c) => c.method === "terminals.read").length;
    // seq 7 when we hold seq 0: six chunks went somewhere we cannot reach.
    emit("terminal.data", { terminalId: "t1", data: "jumped", runId: "r1", seq: 7 });
    await settled();
    expect(calls.filter((c) => c.method === "terminals.read").length).toBe(before + 1);
    expect(terms[0]!.writes.join("")).not.toContain("jumped"); // not written blind
  });

  it("re-reads when the runId changes — the pty respawned and our seq means nothing", async () => {
    const { hub, emit, calls } = setup();
    mount(hub, "t1");
    await settled();
    const before = calls.filter((c) => c.method === "terminals.read").length;
    emit("terminal.data", { terminalId: "t1", data: "new shell", runId: "r2", seq: 1 });
    await settled();
    expect(calls.filter((c) => c.method === "terminals.read").length).toBe(before + 1);
  });

  it("resets the pane when the server says output was dropped", async () => {
    const { hub, reads, terms } = setup();
    reads.read = { truncated: true, live: "tail only" };
    mount(hub, "t1");
    await settled();
    // MUTANT: replay over the old screen instead of resetting, and a hole mid-escape-sequence leaves
    // xterm in a state nothing later corrects.
    expect(terms[0]!.writes.join("")).toContain("\x1bc");
  });

  it("draws the seam between a replayed screen and the live shell, and says which is which", async () => {
    const { hub, reads, terms } = setup();
    reads.read = { history: { data: "yesterday", cols: 132, rows: 44 }, live: "" };
    mount(hub, "t1");
    await settled();
    const written = terms[0]!.writes.join("");
    expect(written).toContain("yesterday");
    expect(written).toContain("earlier");
    // The replay must not read as live, and the state word is how the pane says so.
    expect(hub.stateWord("t1")).toBe("Replayed");
  });

  it("stops saying Replayed the moment the new shell prints something", async () => {
    const { hub, reads, emitData } = setup();
    reads.read = { history: { data: "yesterday", cols: 80, rows: 24 }, live: "", seq: 0 };
    mount(hub, "t1");
    await settled();
    expect(hub.stateWord("t1")).toBe("Replayed");
    emitData("t1", "$ ");
    expect(hub.stateWord("t1")).toBeNull();
  });

  it("says a pane with no pty is not running", async () => {
    const { hub, reads } = setup();
    reads.read = { running: false };
    mount(hub, "t1");
    await settled();
    expect(hub.stateWord("t1")).toBe("Not running");
  });

  it("resyncAll re-reads every held terminal — the reconnect path", async () => {
    const { hub, calls } = setup();
    mount(hub, "t1"); mount(hub, "t2");
    await settled();
    const before = calls.filter((c) => c.method === "terminals.read").length;
    hub.resyncAll();
    await settled();
    expect(calls.filter((c) => c.method === "terminals.read").length).toBe(before + 2);
  });

  it("releases the hold when a read fails, so chunks do not pile up behind a catch-up that never comes", async () => {
    const t = fakeTransport();
    const terms: ReturnType<typeof fakeTerm>[] = [];
    const hub = new TerminalHub(t.transport, () => { const term = fakeTerm(); terms.push(term); return { term, fit: { fit() {} } }; });
    const original = t.transport.call;
    let reads = 0;
    t.transport.call = async (method, params) => {
      if (method !== "terminals.read") return original(method, params);
      reads++;
      if (reads === 1) throw new Error("socket closed");
      return original(method, params);
    };
    const c = document.createElement("div"); document.body.appendChild(c);
    hub.acquire("t1").attach(c);
    await settled();
    // MUTANT: leave the terminal in `catchingUp` after a failed read and it is stuck there forever —
    // every chunk held, no second read ever allowed, and a pane that never updates again.
    hub.resyncAll();
    await settled();
    expect(reads).toBe(2);
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

describe("the code face reaches a terminal that is already open", () => {
  it("reads --font-mono rather than a stack of its own", () => {
    // THE hardcoded-stack mutant: keep the literal '"JetBrains Mono", ui-monospace, …' the factory
    // used to carry. It is the same value as the default preference, so every terminal looks right
    // until someone picks the system face — and then the one surface that is nothing but code is the
    // one surface that ignores the code font.
    expect(terminalFont()).toContain("JetBrains Mono");
    document.documentElement.style.setProperty("--font-mono", "ui-monospace, Menlo, monospace");
    expect(terminalFont()).toBe("ui-monospace, Menlo, monospace");
    document.documentElement.style.removeProperty("--font-mono");
  });

  it("pushes a changed face into every live terminal and re-fits the opened ones", () => {
    // xterm reads its font once, at construction. THE next-terminal-only mutant: leave it there. The
    // setting appears to do nothing to the terminal in front of you, which is the terminal you were
    // looking at when you changed it.
    const { hub, terms, fits } = setup();
    const container = document.createElement("div"); document.body.appendChild(container);
    hub.acquire("open").attach(container);
    hub.acquire("detached");
    fits.length = 0;

    document.documentElement.style.setProperty("--font-mono", "ui-monospace, Menlo, monospace");
    hub.refreshFont();
    expect(terms.map((t) => t.options!.fontFamily)).toEqual(["ui-monospace, Menlo, monospace", "ui-monospace, Menlo, monospace"]);
    // The cell size is measured off the face, so an opened terminal has to re-measure or the grid is
    // the wrong shape and the pty was resized to a lie. A detached one has nothing to measure yet.
    expect(fits).toEqual([0]);

    // THE unconditional-refit mutant: re-fit on every call. This runs on every theme apply, and a
    // re-fit that changes nothing still costs a reflow per terminal per repaint.
    fits.length = 0;
    hub.refreshFont();
    expect(fits).toEqual([]);
    document.documentElement.style.removeProperty("--font-mono");
    container.remove();
  });
});
