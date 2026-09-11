import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { EventName, EventPayload, MethodName, MethodParams, MethodResult } from "@realm/contracts";
import { rpc } from "../rpc/client";
import { TerminalBuffer } from "./terminal-buffer";
import { replayString, terminalStateWord, type TerminalStateWord } from "./terminal-replay";

/** The subset of xterm's Terminal the hub relies on; tests inject a fake. */
export type TerminalLike = {
  open(parent: HTMLElement): void;
  write(data: string): void;
  dispose(): void;
  focus(): void;
  onData(fn: (data: string) => void): { dispose(): void };
  onResize(fn: (size: { cols: number; rows: number }) => void): { dispose(): void };
  readonly cols: number; readonly rows: number;
  /** xterm's live options bag. Optional because the only thing the hub writes back into it is the
   *  code face, and a fake that does not care about fonts should not have to carry one. */
  options?: { fontFamily?: string };
};
export type FitLike = { fit(): void };
export type TerminalFactory = () => { term: TerminalLike; fit: FitLike };

/** What the hub needs from the RPC layer: subscribe to events and issue calls. */
export type HubTransport = {
  on<E extends EventName>(event: E, fn: (payload: EventPayload<E>) => void): () => void;
  call<M extends MethodName>(method: M, params: MethodParams<M>): Promise<unknown>;
};

export type HubEntry = {
  readonly terminalId: string;
  readonly host: HTMLDivElement;
  readonly term: TerminalLike;
  readonly fit: FitLike;
  /** Mount into `container` (moves the host element; opens xterm on first attach). */
  attach(container: HTMLElement): void;
  /** Take the host out of the DOM without disposing anything — the buffer/scrollback survive. */
  detach(): void;
};

/** A `:root` custom property, or the fallback for a renderer whose stylesheet has not loaded. */
const rootVar = (name: string, fallback: string, doc: Document): string =>
  doc.defaultView?.getComputedStyle(doc.documentElement).getPropertyValue(name).trim() || fallback;

/** Terminal background from the `--rl-terminal-bg` token. */
export function terminalBackground(doc: Document = document): string {
  return rootVar("--rl-terminal-bg", "#17181b", doc);
}

/** The code face, from the same `--font-mono` the rest of the app's code surfaces read — so the
 *  Settings preference reaches a terminal instead of leaving it on a hardcoded stack that happens to
 *  match the default. */
export function terminalFont(doc: Document = document): string {
  return rootVar("--font-mono", '"JetBrains Mono", ui-monospace, Menlo, monospace', doc);
}

const defaultFactory: TerminalFactory = () => {
  const term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: terminalFont(), theme: { background: terminalBackground() }, allowProposedApi: true });
  const fit = new FitAddon(); term.loadAddon(fit);
  return { term, fit };
};

/** Where this client got to in one terminal's output. */
type Cursor = { runId: string; seq: number };

/**
 * Owns one xterm instance (+ FitAddon + pre-open buffer) per terminalId, and the single
 * `terminal.data` / `terminal.exit` subscription. Panes only attach/detach the host element,
 * so tree reshapes, space switches and StrictMode double-mounts never lose scrollback.
 *
 * It also owns the CURSOR into each terminal's output. `terminal.data` is the app's one true delta
 * stream — every other event carries whole current state that a refetch repairs — so a client that
 * missed some has no way back without asking. That mattered little while the server died with the
 * app; with a daemon, output arriving while nobody is listening is the ordinary case.
 */
export class TerminalHub {
  private entries = new Map<string, HubEntry & { opened: boolean; subs: { dispose(): void }[] }>();
  private buffers = new Map<string, TerminalBuffer>();
  private unsubscribe: (() => void) | null = null;
  /**
   * The cursor per terminal, and the catch-up bookkeeping around it — deliberately the exact shape
   * `openSession` uses for session events, so a reader recognises it: while a read is in flight,
   * arriving chunks are held rather than written, and on resolve the read is applied first and then
   * the held chunks that are newer than it.
   */
  private cursors = new Map<string, Cursor>();
  private catchingUp = new Map<string, { runId: string; seq: number; data: string }[]>();
  /** Terminals whose pane is currently showing a replayed screen and nothing since. */
  private replayed = new Set<string>();
  private notRunning = new Set<string>();
  private stateListeners = new Set<(terminalId: string) => void>();
  /** Terminals that have produced any output (data, exit banner, dead-terminal notice) — drives the
   *  empty-pane hint (V-F3). */
  private hasDataIds = new Set<string>();
  private firstDataListeners = new Map<string, Set<() => void>>();

  constructor(private transport: HubTransport, private factory: TerminalFactory = defaultFactory,
    private doc: Document = document) {}

  private buffer(id: string): TerminalBuffer {
    let b = this.buffers.get(id);
    if (!b) { b = new TerminalBuffer(); this.buffers.set(id, b); }
    return b;
  }

  private ensureSubscription() {
    if (this.unsubscribe) return;
    const offData = this.transport.on("terminal.data", (p) => this.onData(p));
    const offExit = this.transport.on("terminal.exit", ({ terminalId, exitCode }) => {
      this.buffer(terminalId).push(`\r\n[process exited with code ${exitCode}]\r\n`);
      this.notRunning.add(terminalId);
      this.markData(terminalId);
      this.announceState(terminalId);
    });
    this.unsubscribe = () => { offData(); offExit(); };
  }

  /**
   * One chunk off the wire.
   *
   * Three things can be true of it, and each has one answer. A read is in flight: hold it, because
   * writing it now would put it ahead of output the read is about to deliver. Its `runId` is new, or
   * its `seq` does not follow the one we hold: read, because between our cursor and this chunk is
   * output we will never see again. Otherwise: write it and advance.
   */
  private onData({ terminalId, data, runId, seq }: EventPayload<"terminal.data">) {
    const pendingFor = this.catchingUp.get(terminalId);
    if (pendingFor) { pendingFor.push({ runId, seq, data }); return; }
    const cursor = this.cursors.get(terminalId);
    if (!cursor || cursor.runId !== runId || seq !== cursor.seq + 1) { void this.resync(terminalId); return; }
    this.cursors.set(terminalId, { runId, seq });
    this.buffer(terminalId).push(data);
    this.markData(terminalId);
    if (this.replayed.delete(terminalId)) this.announceState(terminalId);
  }

  /**
   * Ask the server what this client is missing, and apply it.
   *
   * Called on first acquire, on a `runId` change, on a gap in `seq`, and when the socket comes back —
   * every case where the bytes between our cursor and now went somewhere we cannot reach. Idempotent
   * while one is in flight: the second caller's chunks join the same pending list.
   */
  async resync(terminalId: string): Promise<void> {
    if (this.catchingUp.has(terminalId)) return;
    this.catchingUp.set(terminalId, []);
    const cursor = this.cursors.get(terminalId) ?? null;
    let read: MethodResult<"terminals.read">;
    try {
      read = await this.transport.call("terminals.read", { terminalId, cursor }) as MethodResult<"terminals.read">;
    } catch {
      // A read that failed is a socket that is down; the reconnect will call us again. Releasing the
      // hold is the important part — chunks must not pile up behind a catch-up that is never coming.
      this.catchingUp.delete(terminalId);
      return;
    }
    const pending = this.catchingUp.get(terminalId) ?? [];
    this.catchingUp.delete(terminalId);

    const buf = this.buffer(terminalId);
    // A hole in the middle of an escape sequence is a state xterm cannot correct on its own, so the
    // pane starts clean rather than replaying over whatever it was left in.
    if (read.truncated) buf.reset();
    const replay = replayString(read, { running: read.running, labelled: read.history !== null });
    if (replay !== "") { buf.push(replay); this.markData(terminalId); }

    let seq = read.seq;
    for (const chunk of pending) {
      // Chunks from the run we just read, newer than it. Anything older is already in `live`, and
      // anything from another run means a respawn we will hear about on the next gap.
      if (chunk.runId !== read.runId || chunk.seq <= seq) continue;
      buf.push(chunk.data);
      this.markData(terminalId);
      seq = chunk.seq;
    }
    if (read.runId !== "") this.cursors.set(terminalId, { runId: read.runId, seq });

    const live = seq > read.seq || read.live !== "";
    if (read.running) this.notRunning.delete(terminalId); else this.notRunning.add(terminalId);
    if (read.history !== null && !live) this.replayed.add(terminalId); else this.replayed.delete(terminalId);
    this.announceState(terminalId);
  }

  /** Re-read every terminal this client is holding. The reconnect path — `terminal.data` is the app's
   *  one true delta stream, and every other event carries whole current state a refetch repairs. */
  resyncAll(): void {
    for (const id of this.entries.keys()) void this.resync(id);
  }

  /** `Replayed`, `Not running`, or nothing at all while the pane is live. */
  stateWord(terminalId: string): TerminalStateWord {
    return terminalStateWord({
      running: !this.notRunning.has(terminalId),
      replayed: this.replayed.has(terminalId),
      liveSinceReplay: !this.replayed.has(terminalId),
    });
  }

  /** Told whenever a terminal's state word may have changed, so a pane can re-render its meta. */
  onStateChange(fn: (terminalId: string) => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  private announceState(terminalId: string) {
    for (const fn of this.stateListeners) fn(terminalId);
  }

  private markData(id: string) {
    if (this.hasDataIds.has(id)) return;
    this.hasDataIds.add(id);
    const fns = this.firstDataListeners.get(id);
    this.firstDataListeners.delete(id);
    if (fns) for (const fn of fns) fn();
  }

  has(terminalId: string): boolean { return this.entries.has(terminalId); }

  /** True once this terminal has produced any output. */
  hasData(terminalId: string): boolean { return this.hasDataIds.has(terminalId); }

  /** Fires `fn` once, on the FIRST output for this terminal. Already has output? Never fires —
   *  check hasData() first. Returns an unsubscribe. */
  onFirstData(terminalId: string, fn: () => void): () => void {
    if (this.hasDataIds.has(terminalId)) return () => {};
    const s = this.firstDataListeners.get(terminalId) ?? new Set();
    s.add(fn); this.firstDataListeners.set(terminalId, s);
    return () => s.delete(fn);
  }

  acquire(terminalId: string): HubEntry {
    this.ensureSubscription();
    const existing = this.entries.get(terminalId);
    if (existing) return existing;
    const { term, fit } = this.factory();
    const host = this.doc.createElement("div");
    host.className = "terminal-host";
    const buf = this.buffer(terminalId);
    let announcedDead = false;
    const call = (method: MethodName, params: MethodParams<MethodName>) => {
      void this.transport.call(method, params).catch((e: unknown) => {
        if ((e as { code?: string })?.code === "NOT_FOUND") {
          // The server has no pty for this id (e.g. exited or not restored) — say so once, in the pane.
          if (!announcedDead) { announcedDead = true; buf.push("\r\n[terminal is not running]\r\n"); this.markData(terminalId); }
          return;
        }
        console.warn(`[terminal ${terminalId}] ${method} failed:`, e);
      });
    };
    const entry = {
      terminalId, host, term, fit, opened: false,
      subs: [] as { dispose(): void }[],
      attach: (container: HTMLElement) => {
        if (host.parentElement !== container) container.appendChild(host);
        if (!entry.opened) {
          // Open only once the host is in the DOM so xterm can measure cell size.
          entry.opened = true;
          term.open(host);
          entry.subs.push(
            term.onData((d) => call("terminals.write", { terminalId, data: d })),
            term.onResize(({ cols, rows }) => call("terminals.resize", { terminalId, cols, rows })),
          );
          buf.attach((d) => term.write(d));
          try { fit.fit(); } catch { /* not measurable yet */ }
          call("terminals.resize", { terminalId, cols: term.cols, rows: term.rows });
        } else {
          try { fit.fit(); } catch { /* ignore */ }
        }
      },
      detach: () => { host.remove(); },
    };
    this.entries.set(terminalId, entry);
    // Every acquire reads, because this client may have been away for any length of time — including
    // "since before this server booted", which is the ordinary case once the server outlives the app.
    void this.resync(terminalId);
    return entry;
  }

  dispose(terminalId: string) {
    const e = this.entries.get(terminalId);
    if (e) {
      for (const s of e.subs) s.dispose();
      e.host.remove();
      e.term.dispose();
      this.entries.delete(terminalId);
    }
    this.buffers.get(terminalId)?.detach();
    this.buffers.delete(terminalId);
    this.hasDataIds.delete(terminalId);
    this.firstDataListeners.delete(terminalId);
    this.cursors.delete(terminalId);
    this.catchingUp.delete(terminalId);
    this.replayed.delete(terminalId);
    this.notRunning.delete(terminalId);
  }

  /** Re-reads the code face from `--font-mono` and pushes it into every live terminal.
   *
   *  Without this the preference would only reach terminals opened AFTER it changed — xterm reads
   *  its font once, at construction, exactly as it reads its background. A setting that takes effect
   *  on the next terminal is a setting the user tries, sees nothing from, and moves on from. Each
   *  one is re-fit afterwards because the cell size is measured off the face: changing it without
   *  re-measuring leaves the grid the wrong shape and the pty resized to a lie. */
  refreshFont() {
    const font = terminalFont(this.doc);
    for (const e of this.entries.values()) {
      if (!e.term.options || e.term.options.fontFamily === font) continue;
      e.term.options.fontFamily = font;
      if (e.opened) try { e.fit.fit(); } catch { /* not measurable while detached */ }
    }
  }

  disposeAll() {
    for (const id of [...this.entries.keys()]) this.dispose(id);
    this.buffers.clear();
    this.hasDataIds.clear();
    this.firstDataListeners.clear();
    this.cursors.clear();
    this.catchingUp.clear();
    this.replayed.clear();
    this.notRunning.clear();
    this.stateListeners.clear();
    this.unsubscribe?.(); this.unsubscribe = null;
  }
}

let singleton: TerminalHub | null = null;
/**
 * App-wide hub bound to the live RPC client.
 *
 * The transport is resolved per call rather than captured, so merely GETTING the hub never touches
 * `window.realm`. The pane bar's state word asks for it on every render — including in jsdom, where
 * there is no preload and `rpc()` throws — and a terminal that has never been acquired has nothing to
 * subscribe to anyway.
 */
export function getTerminalHub(): TerminalHub {
  return (singleton ??= new TerminalHub({
    on: (event, fn) => rpc().on(event, fn),
    call: (method, params) => rpc().call(method, params),
  }));
}
/** Test seam: substitute a fake-backed hub (pass null to reset). */
export function setTerminalHubForTests(hub: TerminalHub | null): void { singleton = hub; }
