import { afterEach, describe, expect, it } from "vitest";
import { terminalColors, terminalFont, TerminalHub, type HubTransport, type TerminalLike } from "./terminal-hub";

type Listener = (payload: unknown) => void;

/** A server that answers `terminals.read` from its own record of what each terminal has printed —
 *  the least a fake can be now that the hub holds a cursor and catches up through a real call. */
function fakeTransport() {
  const listeners = new Map<string, Set<Listener>>();
  const calls: { method: string; params: unknown }[] = [];
  const printed = new Map<string, { runId: string; seq: number; chunks: { seq: number; data: string }[] }>();
  const reads: { read?: Partial<ReadResult> } = {};
  /** What `terminals.programs` answers: every terminal running something other than its shell. */
  const programs: Record<string, unknown> = {};
  const transport: HubTransport = {
    on: (event, fn) => { const s = listeners.get(event) ?? new Set(); s.add(fn as Listener); listeners.set(event, s); return () => s.delete(fn as Listener); },
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === "terminals.programs") return { ...programs };
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
  return { transport, emit, emitData, calls, count, reads, programs };
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
  /** The CSI handlers registered on it, by their final byte — what a program's escape would reach. */
  const csi = new Map<string, (params: (number | number[])[]) => boolean>();
  const term: TerminalLike & { writes: string[]; csi: typeof csi; typed(d: string): void; disposed(): boolean; openedIn(): HTMLElement | null } = {
    cols: 80, rows: 24, writes, csi, options: { fontFamily: "start" },
    parser: { registerCsiHandler: (id, fn) => { csi.set(`${id.intermediates ?? ""}${id.final}`, fn); return { dispose() { csi.delete(`${id.intermediates ?? ""}${id.final}`); } }; } },
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

describe("a terminal's colours", () => {
  const root = document.documentElement;
  /* Realm's light tokens, as tokens.css states them — jsdom loads no stylesheet, so a test that wants
     the light face has to say what its ground and inks are. */
  const LIGHT = { "--canvas": "oklch(0.985 0.002 264)", "--ink": "oklch(0.235 0.006 264)", "--ink-2": "oklch(0.459 0.01 264)", "--accent": "oklch(0.6 0.2 256)" };
  const light = () => { root.setAttribute("data-mode", "light"); for (const [k, v] of Object.entries(LIGHT)) root.style.setProperty(k, v); };
  afterEach(() => {
    root.removeAttribute("data-mode"); root.removeAttribute("data-theme");
    for (const k of Object.keys(LIGHT)) root.style.removeProperty(k);
  });

  it("draws Realm's sixteen on a transparent ground that carries the canvas's own colour", () => {
    // THE MUTANT: the old transparent BLACK. xterm draws inverse video in it, measures its contrast
    // floor against it and answers a program's OSC 11 with it — a TUI that asked was told black.
    const { theme, minimumContrastRatio, vars } = terminalColors();
    expect(theme.background).toBe("#1c1d1f00");
    expect(theme.blue).toBe("#5293e9");
    expect(theme.brightBlack).toBe("#8f9299");
    expect(theme.foreground).toBe("#f2f3f4");
    // Low in the dark face: a prompt's own colours were picked for a dark ground.
    expect(minimumContrastRatio).toBe(3);
    expect(vars["--term-dim"]).toBe("65%");
    expect(vars["--term-ansi-4"]).toBe("#5293e9");
  });

  it("draws the light face in the app's ink, and holds a program's own colours to AA there", () => {
    // xterm's defaults are light-on-black. THE MUTANTS: leave the ink to xterm, and the light face's
    // near-white ground carries white text; drop the contrast floor, and a yellow picked for a black
    // ground is printed on a white one.
    light();
    const { theme, minimumContrastRatio } = terminalColors();
    expect(theme.foreground).toBe("#1d1e21");
    expect(theme.cursor).toBe("#1d1e21");
    expect(theme.background).toBe("#f9fafb00");
    expect(theme.blue).toBe("#1364ce");
    expect(minimumContrastRatio).toBe(4.5);
  });

  it("hands back xterm's own palette for My shell's, with no floor on the dark face", () => {
    const { theme, minimumContrastRatio } = terminalColors(document, "shell");
    expect(theme.blue).toBe("#3465a4");
    expect(theme.foreground).toBe("#ffffff");
    expect(minimumContrastRatio).toBe(1);
  });

  it("wears a themed palette's own port, read off the theme the face is wearing", () => {
    root.setAttribute("data-theme", "dracula");
    expect(terminalColors().theme.green).toBe("#50fa7b");
  });

  it("are a terminal's from the moment it is acquired, and follow the face into the ones already open", () => {
    // THE MUTANT: set them only at construction. A terminal opened before a switch to light keeps
    // white ink on the light face's ground — the setting changes everything but the shell in front of
    // you.
    const { hub, terms } = setup();
    hub.acquire("a");
    expect(terms[0]!.options!.theme!.background).toBe("#1c1d1f00");
    light();
    hub.refreshColors();
    expect(terms[0]!.options!.theme!.background).toBe("#f9fafb00");
    expect(terms[0]!.options!.minimumContrastRatio).toBe(4.5);
    hub.acquire("b");
    expect(terms[1]!.options!.theme!.background).toBe("#f9fafb00");
  });

  it("gives every host the colours faint text is mixed from, and carries the scheme into open terminals", () => {
    // THE next-terminal-only mutant again, for the Settings pair: a terminal open when "My shell's" is
    // chosen has to change too, palette and the faint text drawn from it both.
    const { hub, terms } = setup();
    const e = hub.acquire("a");
    expect(e.host.style.getPropertyValue("--term-dim")).toBe("65%");
    expect(e.host.style.getPropertyValue("--term-ansi-1")).toBe("#ed7471");
    hub.setColorScheme("shell");
    expect(terms[0]!.options!.theme!.red).toBe("#cc0000");
    expect(e.host.style.getPropertyValue("--term-ansi-1")).toBe("#cc0000");
    hub.acquire("b");
    expect(terms[1]!.options!.theme!.red).toBe("#cc0000");
  });
});

describe("what a terminal is running", () => {
  const claude = { id: "claude", label: "claude", mark: "claude", agent: true };
  const settle = () => new Promise<void>((r) => setTimeout(r, 0));

  it("is read once, when something first asks, then kept by terminal.program", async () => {
    // A tab that is not showing may name a terminal whose agent started before this window listened,
    // so the first listener reads where every terminal already is.
    const { hub, programs, emit, calls, count } = setup();
    programs.t1 = claude;
    expect(count("terminal.program")).toBe(0); // nothing asked yet: nothing subscribed
    let told = 0;
    hub.onProgramChange(() => { told++; });
    hub.onProgramChange(() => {});
    expect(hub.programsKnown).toBe(false);
    await settle();
    expect(calls.filter((c) => c.method === "terminals.programs")).toHaveLength(1);
    expect(count("terminal.program")).toBe(1);
    expect(hub.program("t1")).toEqual(claude);
    expect(hub.programsKnown).toBe(true);
    expect(told).toBe(2); // t1's program, and the read landing
    emit("terminal.program", { terminalId: "t1", program: null });
    expect(hub.program("t1")).toBeNull();
    emit("terminal.program", { terminalId: "t2", program: { id: "python", label: "python3", mark: "python", agent: false } });
    expect(hub.program("t2")).toMatchObject({ label: "python3" });
    emit("terminal.program", { terminalId: "t2", program: { id: "python", label: "python3", mark: "python", agent: false } });
    expect(told).toBe(4); // the same program said twice is one change
  });

  it("drops what a terminal was running when it exits, and when it is disposed", async () => {
    const { hub, programs, emit } = setup();
    programs.t1 = claude; programs.t2 = claude;
    hub.onProgramChange(() => {});
    hub.acquire("t1");
    await settle();
    emit("terminal.exit", { terminalId: "t1", exitCode: 0 });
    expect(hub.program("t1")).toBeNull();
    hub.dispose("t2");
    expect(hub.program("t2")).toBeNull();
  });

  it("re-reads on reconnect, taking back what changed while the socket was down", async () => {
    const { hub, programs } = setup();
    programs.t1 = claude;
    hub.onProgramChange(() => {});
    await settle();
    delete programs.t1;
    programs.t3 = claude;
    hub.resyncAll();
    await settle();
    expect(hub.program("t1")).toBeNull();
    expect(hub.program("t3")).toEqual(claude);
  });

  it("asks nothing and throws nothing where the transport cannot subscribe — a component test", () => {
    const hub = new TerminalHub({ on: () => { throw new Error("rpc() called outside the app"); }, call: async () => ({}) });
    expect(() => hub.onProgramChange(() => {})).not.toThrow();
    expect(hub.program("t1")).toBeNull();
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
    expect(terminalFont().startsWith("ui-monospace, Menlo, monospace,")).toBe(true);
    document.documentElement.style.removeProperty("--font-mono");
  });

  it("keeps the prompt-icon faces behind the code face, whichever face that is", () => {
    // A p10k prompt in a nerdfont mode draws its branch and folder in private-use codepoints, which
    // no code face carries: without these the icons are empty boxes. THE mutant: put them first, and
    // they become the face every letter is measured and drawn in.
    for (const face of ['"JetBrains Mono", monospace', "ui-monospace, Menlo, monospace"]) {
      document.documentElement.style.setProperty("--font-mono", face);
      expect(terminalFont().startsWith(face)).toBe(true);
      expect(terminalFont()).toMatch(/"MesloLGS NF"$/);
    }
    document.documentElement.style.removeProperty("--font-mono");
  });

  it("pushes the cursor-blink preference into live terminals, and into the next one opened", () => {
    /* Same mutant as the face below, and the same reason it matters: xterm takes `cursorBlink` at
       construction, so a preference that only reached the NEXT terminal is one the user watches do
       nothing to the terminal they were looking at. The second half — a terminal acquired AFTER the
       switch — is the half a live push alone would miss. */
    const { hub, terms } = setup();
    hub.acquire("a");
    hub.acquire("b");
    hub.setCursorBlink(false);
    expect(terms.map((t) => t.options!.cursorBlink)).toEqual([false, false]);

    hub.acquire("c");
    expect(terms.at(-1)!.options!.cursorBlink).toBe(false);
    hub.setCursorBlink(true);
    expect(terms.map((t) => t.options!.cursorBlink)).toEqual([true, true, true]);
  });

  it("pushes the cursor's SHAPE the same way, and keeps it independent of the blink", () => {
    /* THE folded-control mutant lives in Settings, but its consequence would land here: a shape and
       a blink that could not disagree. A line that holds still is a pair somebody wants. */
    const { hub, terms } = setup();
    hub.acquire("a");
    hub.setCursorStyle("line");
    hub.setCursorBlink(false);
    expect(terms.map((t) => t.options!.cursorStyle)).toEqual(["bar"]);
    expect(terms.map((t) => t.options!.cursorBlink)).toEqual([false]);

    // A terminal opened after the change agrees with the one opened before it — the half a live
    // push alone would miss, and the half a construction-only write would be all of.
    hub.acquire("b");
    expect(terms.at(-1)!.options!.cursorStyle).toBe("bar");
    expect(terms.at(-1)!.options!.cursorBlink).toBe(false);
  });

  it("hands xterm the nearest of its three shapes and the stylesheet the shape itself", () => {
    /* THE nearest-only mutant: tell xterm "bar" and stop there, and a pill, a beam, a soft block and an
       outline all come out as the same two-pixel line. The host carries the shape so the stylesheet can
       draw the rest of it on the cell xterm marks. A soft block and an outline are a BAR to xterm, the
       one of its three that leaves the character under it in its own colour. */
    const { hub, terms } = setup();
    const a = hub.acquire("a");
    const seen = (shape: Parameters<typeof hub.setCursorStyle>[0]) => {
      hub.setCursorStyle(shape);
      return [terms[0]!.options!.cursorStyle, terms[0]!.options!.cursorWidth, a.host.dataset.caret];
    };
    expect(seen("pill")).toEqual(["bar", 3, "pill"]);
    expect(seen("line-thin")).toEqual(["bar", 1, "line-thin"]);
    expect(seen("block-soft")).toEqual(["bar", 1, "block-soft"]);
    expect(seen("block-outline")).toEqual(["bar", 1, "block-outline"]);
    expect(seen("block")).toEqual(["block", 1, "block"]);
    expect(seen("underline-thin")).toEqual(["underline", 1, "underline-thin"]);
    // And a terminal opened after the change starts out marked, not only the ones already open.
    hub.setCursorStyle("beam");
    expect(hub.acquire("b").host.dataset.caret).toBe("beam");
    expect(terms[1]!.options!.cursorWidth).toBe(3);
  });

  it("lets a program set its own cursor, and gives back the setting when it asks for the default", () => {
    /* xterm writes a program's DECSCUSR over the preference, and its answer to "the default" (0) is a
       blinking block — so a vim that tidies up on exit left every terminal a blinking block, whatever
       Settings said. THE xterm-default mutant: return false for 0, and xterm's block comes back. */
    const { hub, terms } = setup();
    const container = document.createElement("div"); document.body.appendChild(container);
    const e = hub.acquire("a");
    e.attach(container);
    hub.setCursorStyle("pill");
    hub.setCursorBlink(false);
    const decscusr = terms[0]!.csi.get(" q")!;
    expect(decscusr).toBeTypeOf("function");

    // A bar asked for: xterm applies it (the handler declines), and the stylesheet draws it plainly.
    expect(decscusr([6])).toBe(false);
    expect(e.host.dataset.caretProgram).toBe("");
    // xterm would now have written its own answer over ours — say so, then ask for the default back.
    Object.assign(terms[0]!.options!, { cursorStyle: "block", cursorBlink: true });
    expect(decscusr([0])).toBe(true);
    expect([terms[0]!.options!.cursorStyle, terms[0]!.options!.cursorWidth, terms[0]!.options!.cursorBlink]).toEqual(["bar", 3, false]);
    expect(e.host.dataset.caretProgram).toBeUndefined();
    container.remove();
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
    expect(terms.map((t) => t.options!.fontFamily?.split(",").slice(0, 3).join(","))).toEqual(["ui-monospace, Menlo, monospace", "ui-monospace, Menlo, monospace"]);
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

  it("pushes a changed code size into every live terminal too, and re-fits the opened ones", () => {
    // "Code font size" is the size of everything in the code face, terminals included. THE
    // face-only mutant: refresh the family and leave the size, and the largest code surface in the
    // app is the one the setting does not reach.
    const { hub, terms, fits } = setup();
    const container = document.createElement("div"); document.body.appendChild(container);
    hub.acquire("open").attach(container);
    hub.acquire("detached");
    hub.refreshFont();
    fits.length = 0;

    document.documentElement.style.setProperty("--code-text-scale", "1.25");
    hub.refreshFont();
    expect(terms.map((t) => t.options!.fontSize)).toEqual([16.25, 16.25]);
    // A cell's size is the font's size: the opened terminal re-measures, the detached one waits.
    expect(fits).toEqual([0]);
    document.documentElement.style.removeProperty("--code-text-scale");
    container.remove();
  });
});

