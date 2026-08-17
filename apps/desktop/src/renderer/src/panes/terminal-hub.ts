import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { EventName, EventPayload, MethodName, MethodParams } from "@realm/contracts";
import { rpc } from "../rpc/client";
import { TerminalBuffer } from "./terminal-buffer";

/** The subset of xterm's Terminal the hub relies on; tests inject a fake. */
export type TerminalLike = {
  open(parent: HTMLElement): void;
  write(data: string): void;
  dispose(): void;
  focus(): void;
  onData(fn: (data: string) => void): { dispose(): void };
  onResize(fn: (size: { cols: number; rows: number }) => void): { dispose(): void };
  readonly cols: number; readonly rows: number;
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

/** Terminal background from the `--rl-terminal-bg` token (read once, at hub creation). */
export function terminalBackground(doc: Document = document): string {
  const v = doc.defaultView?.getComputedStyle(doc.documentElement).getPropertyValue("--rl-terminal-bg").trim();
  return v || "#17181b";
}

const defaultFactory: TerminalFactory = () => {
  const term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: "ui-monospace, Menlo, monospace", theme: { background: terminalBackground() }, allowProposedApi: true });
  const fit = new FitAddon(); term.loadAddon(fit);
  return { term, fit };
};

/**
 * Owns one xterm instance (+ FitAddon + pre-open buffer) per terminalId, and the single
 * `terminal.data` / `terminal.exit` subscription. Panes only attach/detach the host element,
 * so tree reshapes, space switches and StrictMode double-mounts never lose scrollback.
 */
export class TerminalHub {
  private entries = new Map<string, HubEntry & { opened: boolean; subs: { dispose(): void }[] }>();
  private buffers = new Map<string, TerminalBuffer>();
  private unsubscribe: (() => void) | null = null;

  constructor(private transport: HubTransport, private factory: TerminalFactory = defaultFactory,
    private doc: Document = document) {}

  private buffer(id: string): TerminalBuffer {
    let b = this.buffers.get(id);
    if (!b) { b = new TerminalBuffer(); this.buffers.set(id, b); }
    return b;
  }

  private ensureSubscription() {
    if (this.unsubscribe) return;
    const offData = this.transport.on("terminal.data", ({ terminalId, data }) => this.buffer(terminalId).push(data));
    const offExit = this.transport.on("terminal.exit", ({ terminalId, exitCode }) =>
      this.buffer(terminalId).push(`\r\n[process exited with code ${exitCode}]\r\n`));
    this.unsubscribe = () => { offData(); offExit(); };
  }

  has(terminalId: string): boolean { return this.entries.has(terminalId); }

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
          if (!announcedDead) { announcedDead = true; buf.push("\r\n[terminal is not running]\r\n"); }
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
  }

  disposeAll() {
    for (const id of [...this.entries.keys()]) this.dispose(id);
    this.buffers.clear();
    this.unsubscribe?.(); this.unsubscribe = null;
  }
}

let singleton: TerminalHub | null = null;
/** App-wide hub bound to the live RPC client (created lazily so tests never touch window.realm). */
export function getTerminalHub(): TerminalHub {
  return (singleton ??= new TerminalHub(rpc()));
}
