import * as pty from "node-pty";
import { newId } from "@realm/contracts";
import { NotFoundError } from "../store/rows";

export type TerminalCallbacks = { onData: (id: string, data: string) => void; onExit: (id: string, exitCode: number) => void };
export const MAX_COLS = 500;
export const MAX_ROWS = 500;

export class TerminalManager {
  private terms = new Map<string, pty.IPty>();
  /** When each pty last produced output, so a prefill can wait for the shell to stop talking. */
  private lastDataAt = new Map<string, number>();
  constructor(private cb: TerminalCallbacks, private now: () => number = Date.now) {}

  create(opts: { id?: string; cwd: string; cols: number; rows: number; shell?: string; env?: Record<string, string> }): { id: string; shell: string } {
    const id = opts.id ?? newId();
    const shell = opts.shell ?? process.env.SHELL ?? "/bin/zsh";
    const p = pty.spawn(shell, [], {
      name: "xterm-256color", cwd: opts.cwd, cols: clamp(opts.cols, 2, MAX_COLS), rows: clamp(opts.rows, 1, MAX_ROWS),
      env: { ...process.env, ...opts.env, TERM_PROGRAM: "Realm" } as Record<string, string>,
    });
    p.onData((d) => { this.lastDataAt.set(id, this.now()); this.cb.onData(id, d); });
    p.onExit(({ exitCode }) => {
      // Only spontaneous exits notify; after an explicit close() the id is already gone and callers
      // (and possibly the DB) have moved on.
      this.lastDataAt.delete(id);
      if (!this.terms.delete(id)) return;
      this.cb.onExit(id, exitCode);
    });
    this.terms.set(id, p);
    // Seed from spawn, not from first output: a shell that has not printed *yet* is the one case a
    // prefill must wait for, and an unset timestamp would read as "quiet since the epoch".
    this.lastDataAt.set(id, this.now());
    return { id, shell };
  }
  has(id: string): boolean { return this.terms.has(id); }
  write(id: string, data: string): void { this.get(id).write(data); }
  /**
   * Write once the shell has stopped producing output for `quietMs` (or `timeoutMs` elapses).
   *
   * A freshly spawned shell is still printing its startup when a prefill arrives, and characters written
   * into that stream get mangled — the leading one especially. Waiting for quiet costs a moment and makes
   * the typed command land whole.
   *
   * It cannot help when the shell is *asking something* (an oh-my-zsh update prompt, say): a shell waiting
   * on an answer is indistinguishable from one waiting at its own prompt, and the first character answers
   * the question instead. Nothing here can tell those apart, which is why the command is only ever typed,
   * never run — a mangled line sits visible at the prompt rather than executing.
   */
  async writeWhenQuiet(id: string, data: string, quietMs = 250, timeoutMs = 4000): Promise<void> {
    this.get(id); // reject an unknown id up front, not after the wait
    const deadline = this.now() + timeoutMs;
    for (;;) {
      const since = this.now() - (this.lastDataAt.get(id) ?? 0);
      if (since >= quietMs || this.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, Math.min(quietMs - since, 50)));
      if (!this.terms.has(id)) return; // the shell died while we waited
    }
    if (this.terms.has(id)) this.write(id, data);
  }
  resize(id: string, cols: number, rows: number): void { this.get(id).resize(clamp(cols, 2, MAX_COLS), clamp(rows, 1, MAX_ROWS)); }
  close(id: string): void { const p = this.get(id); p.kill(); this.terms.delete(id); this.lastDataAt.delete(id); }
  closeAll(): void { for (const id of [...this.terms.keys()]) this.close(id); }
  private get(id: string): pty.IPty { const p = this.terms.get(id); if (!p) throw new NotFoundError("terminal", id); return p; }
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.floor(n)));
