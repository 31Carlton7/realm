import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { oklchToHex, parseOklch, sameProgram, TERMINALS_COLORS_DEFAULT, TERMINALS_CURSOR_BLINK_DEFAULT, TERMINALS_CURSOR_STYLE_DEFAULT, type Oklch, type TerminalColorScheme, type TerminalCursorStyle, type TerminalProgram, type EventName, type EventPayload, type MethodName, type MethodParams, type MethodResult } from "@realm/contracts";
import { ANSI_NAMES, terminalPalette } from "@realm/ui";
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
  /** xterm's live options bag. Optional because the only things the hub writes back into it are the
   *  code face, the cursor and the colours, and a fake that cares about none of them should not have
   *  to carry one. */
  options?: { fontFamily?: string; fontSize?: number; cursorBlink?: boolean; cursorStyle?: TerminalCursorStyle; theme?: ITheme; minimumContrastRatio?: number };
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

/** The four tokens a terminal's palette is drawn from, as tokens.css states them for each face — the
 *  answer for a renderer whose stylesheet has not loaded (a component test). */
const TOKEN_FALLBACK = {
  dark: { "--canvas": "oklch(0.231 0.004 264.487)", "--ink": "oklch(0.964 0.002 247.839)", "--ink-2": "oklch(0.731 0.008 260.731)", "--accent": "oklch(0.68 0.173 253.301)" },
  light: { "--canvas": "oklch(0.985 0.002 264)", "--ink": "oklch(0.235 0.006 264)", "--ink-2": "oklch(0.459 0.01 264)", "--accent": "oklch(0.6 0.2 256)" },
} as const;

/** A colour token off `:root`, as OKLCH — the form tokens.css and every derived theme write. */
const rootColor = (name: keyof (typeof TOKEN_FALLBACK)["dark"], mode: "dark" | "light", doc: Document): Oklch => {
  const fallback = TOKEN_FALLBACK[mode][name];
  try { return parseOklch(rootVar(name, fallback, doc)); } catch { return parseOklch(fallback); }
};

/**
 * What a terminal is drawn in: no ground of its own, and the palette for the ground it shows.
 *
 * The background is transparent, so a terminal shows the pane's ground — the one translucent sheet
 * `.main` lays under every pane, the transcript included — and reads as the same surface as the chat
 * beside it. Any colour named here would be painted OVER that sheet at full strength, a darker slab
 * of the same token. The colour behind the zero alpha is that ground's own, because three things read
 * it: xterm draws inverse video in it, measures `minimumContrastRatio` against it, and answers a
 * program's OSC 11 query with it — so a TUI that blends its own panels off the terminal's background
 * (Codex shades its user messages that way) blends them off Realm's.
 *
 * The sixteen and the ink are `terminal-palette.ts`'s, for the face and theme on `:root` and the
 * Settings choice between Realm's and the shell's. `vars` carries what xterm has no option for — the
 * colours faint text is mixed from, which the stylesheet reads (`.terminal-host .xterm-dim`).
 */
export function terminalColors(doc: Document = document, scheme: TerminalColorScheme = TERMINALS_COLORS_DEFAULT): {
  theme: ITheme; minimumContrastRatio: number; vars: Record<string, string>;
} {
  const root = doc.documentElement;
  const mode = root.getAttribute("data-mode") === "light" ? "light" : "dark";
  const ground = rootColor("--canvas", mode, doc);
  const p = terminalPalette({
    theme: root.getAttribute("data-theme") || "realm", mode, scheme, ground,
    ink: rootColor("--ink", mode, doc), ink2: rootColor("--ink-2", mode, doc), accent: rootColor("--accent", mode, doc),
  });
  const ansi = Object.fromEntries(ANSI_NAMES.map((name, i) => [name, p.ansi[i]!]));
  const vars: Record<string, string> = { "--term-fg": p.foreground, "--term-dim": `${Math.round(p.dim * 100)}%` };
  p.ansi.forEach((hex, i) => { vars[`--term-ansi-${i}`] = hex; });
  return {
    theme: {
      background: `${oklchToHex(ground)}00`, foreground: p.foreground, cursor: p.cursor, cursorAccent: p.cursorAccent,
      selectionBackground: p.selection, selectionInactiveBackground: p.selectionInactive, ...ansi,
    },
    minimumContrastRatio: p.minimumContrastRatio,
    vars,
  };
}

/** The code face, from the same `--font-mono` the rest of the app's code surfaces read — so the
 *  Settings preference reaches a terminal instead of leaving it on a hardcoded stack that happens to
 *  match the default. */
export function terminalFont(doc: Document = document): string {
  return rootVar("--font-mono", '"JetBrains Mono", ui-monospace, Menlo, monospace', doc);
}

/** The terminal's text size: 13px at the default, times the code scale every other code surface is
 *  set at — "Code font size" is the size of everything in the code face, and a terminal is the
 *  largest thing in it. A scale that does not read as a positive number leaves the default. */
export const TERMINAL_FONT_SIZE = 13;
export function terminalFontSize(doc: Document = document): number {
  const scale = Number(rootVar("--code-text-scale", "1", doc));
  return Number.isFinite(scale) && scale > 0 ? +(TERMINAL_FONT_SIZE * scale).toFixed(2) : TERMINAL_FONT_SIZE;
}

const defaultFactory: TerminalFactory = () => {
  /* `cursorBlink` is the hub's to set — it is a preference, and the hub is what knows the current
     answer for a terminal opened at any moment. Constructed on, then corrected in `acquire`, so a
     terminal opened while the switch is off never blinks even once. */
  /* `allowTransparency`, because its background is see-through — see `terminalColors`, which
     `acquire` applies before the terminal is opened. */
  const term = new Terminal({ cursorBlink: true, fontSize: terminalFontSize(), fontFamily: terminalFont(), allowTransparency: true, allowProposedApi: true });
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
  /** Whether a terminal's cursor blinks (Settings ▸ General). Held here rather than read at construction
   *  because it has to reach the terminals that are ALREADY open — see `setCursorBlink`. */
  private cursorBlink = TERMINALS_CURSOR_BLINK_DEFAULT;
  private cursorStyle: TerminalCursorStyle = TERMINALS_CURSOR_STYLE_DEFAULT;
  /** Realm's sixteen or the shell's (Settings ▸ General ▸ Terminals) — held for the next terminal
   *  as the cursor is, and pushed into the open ones by `setColorScheme`. */
  private colorScheme: TerminalColorScheme = TERMINALS_COLORS_DEFAULT;
  /**
   * What each terminal is running, for the tabs that name it (`terminal.program`). Held here rather
   * than on the item because it is the pty's state, not the layout's: it changes every time a program
   * starts, persists nowhere, and a tab that is not showing must know it as well as one that is.
   */
  private programs = new Map<string, TerminalProgram>();
  private programListeners = new Set<() => void>();
  private programsVersion = 0;
  /** Whether the first `terminals.programs` read has landed — until it has, a terminal with no
   *  program is one this window has not heard about yet, not one running its shell. */
  private programsRead = false;
  /** The `terminal.program` subscription, once something has asked for a program. */
  private offPrograms: (() => void) | null = null;
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
      // A terminal that is not running is running nothing, whatever it said last.
      this.setProgram(terminalId, null);
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
    if (this.offPrograms) void this.readPrograms();
  }

  /** The program a terminal's tab names — null for its shell, and for a terminal this client has
   *  heard nothing about. */
  program(terminalId: string): TerminalProgram | null {
    return this.programs.get(terminalId) ?? null;
  }

  /** Told whenever any terminal's program changes, and once when the first read lands; `programsSeen`
   *  is the snapshot a hook compares. The first listener starts the following, so a window that never
   *  shows a terminal's tab never subscribes to one. */
  onProgramChange(fn: () => void): () => void {
    this.wirePrograms();
    this.programListeners.add(fn);
    return () => this.programListeners.delete(fn);
  }

  get programsSeen(): number { return this.programsVersion; }

  /** Whether what `program` answers is known rather than not yet heard (see `programsRead`). */
  get programsKnown(): boolean { return this.programsRead; }

  /**
   * Follow `terminal.program`, and read where every terminal already is — a tab in a strip may name a
   * terminal whose program started before this window was listening.
   *
   * Lazy and forgiving: a component test renders a terminal's tab with no preload behind the
   * transport, and `on` throws there. Nothing can be followed then, so nothing is, and the tab keeps
   * the terminal glyph; the next read tries again.
   */
  private wirePrograms(): void {
    if (this.offPrograms) return;
    try {
      this.offPrograms = this.transport.on("terminal.program", ({ terminalId, program }) => this.setProgram(terminalId, program));
    } catch { return; }
    void this.readPrograms();
  }

  private async readPrograms(): Promise<void> {
    let all: MethodResult<"terminals.programs">;
    try { all = await this.transport.call("terminals.programs", {}) as MethodResult<"terminals.programs">; } catch { return; }
    const ids = new Set([...this.programs.keys(), ...Object.keys(all)]);
    for (const id of ids) this.setProgram(id, all[id] ?? null);
    if (!this.programsRead) { this.programsRead = true; this.announcePrograms(); }
  }

  private setProgram(terminalId: string, program: TerminalProgram | null): void {
    if (sameProgram(this.programs.get(terminalId) ?? null, program)) return;
    if (program) this.programs.set(terminalId, program); else this.programs.delete(terminalId);
    this.announcePrograms();
  }

  private announcePrograms(): void {
    this.programsVersion++;
    for (const fn of this.programListeners) fn();
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
    const { vars, ...colors } = terminalColors(this.doc, this.colorScheme);
    if (term.options) { term.options.cursorBlink = this.cursorBlink; term.options.cursorStyle = this.cursorStyle; Object.assign(term.options, colors); }
    const host = this.doc.createElement("div");
    host.className = "terminal-host";
    for (const [name, value] of Object.entries(vars)) host.style.setProperty(name, value);
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
    this.setProgram(terminalId, null);
  }

  /** Re-reads the code face from `--font-mono` and pushes it into every live terminal.
   *
   *  Without this the preference would only reach terminals opened AFTER it changed — xterm reads
   *  its font once, at construction, exactly as it reads its background. A setting that takes effect
   *  on the next terminal is a setting the user tries, sees nothing from, and moves on from. Each
   *  one is re-fit afterwards because the cell size is measured off the face: changing it without
   *  re-measuring leaves the grid the wrong shape and the pty resized to a lie. */
  /** The cursor-blink preference, pushed into every live terminal and remembered for the next one.
   *
   *  Live, for `refreshFont`'s reason: a setting that only reaches terminals opened afterwards is a
   *  setting the user tries, sees nothing from, and gives up on. No re-fit — unlike the face, a
   *  blinking cursor is not part of the cell metrics. */
  setCursorBlink(on: boolean) {
    this.cursorBlink = on;
    for (const e of this.entries.values()) if (e.term.options) e.term.options.cursorBlink = on;
  }

  /** Live for the same reason the blink is — and no re-fit for the same reason either: a cursor's
   *  shape is drawn inside one cell and changes none of the grid's metrics. */
  setCursorStyle(style: TerminalCursorStyle) {
    this.cursorStyle = style;
    for (const e of this.entries.values()) if (e.term.options) e.term.options.cursorStyle = style;
  }

  /** The colours, re-read off the theme and pushed into every live terminal: a terminal opened in the
   *  dark face would otherwise keep light-on-black ink on the light face's near-white ground. */
  refreshColors() {
    const { vars, ...colors } = terminalColors(this.doc, this.colorScheme);
    for (const e of this.entries.values()) {
      if (e.term.options) Object.assign(e.term.options, colors);
      for (const [name, value] of Object.entries(vars)) e.host.style.setProperty(name, value);
    }
  }

  /** Realm's sixteen or the shell's, into every live terminal and the next one — live for the reason
   *  the cursor's preferences are. */
  setColorScheme(scheme: TerminalColorScheme) {
    if (scheme === this.colorScheme) return;
    this.colorScheme = scheme;
    this.refreshColors();
  }

  refreshFont() {
    const font = terminalFont(this.doc);
    const size = terminalFontSize(this.doc);
    for (const e of this.entries.values()) {
      if (!e.term.options || (e.term.options.fontFamily === font && e.term.options.fontSize === size)) continue;
      e.term.options.fontFamily = font;
      e.term.options.fontSize = size;
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
    this.programs.clear();
    this.programListeners.clear();
    this.programsRead = false;
    this.offPrograms?.(); this.offPrograms = null;
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
