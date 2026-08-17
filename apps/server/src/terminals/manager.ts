import * as pty from "node-pty";
import { newId } from "@realm/contracts";
import { NotFoundError } from "../store/rows";

export type TerminalCallbacks = { onData: (id: string, data: string) => void; onExit: (id: string, exitCode: number) => void };
export const MAX_COLS = 500;
export const MAX_ROWS = 500;

export class TerminalManager {
  private terms = new Map<string, pty.IPty>();
  constructor(private cb: TerminalCallbacks) {}

  create(opts: { id?: string; cwd: string; cols: number; rows: number; shell?: string; env?: Record<string, string> }): { id: string; shell: string } {
    const id = opts.id ?? newId();
    const shell = opts.shell ?? process.env.SHELL ?? "/bin/zsh";
    const p = pty.spawn(shell, [], {
      name: "xterm-256color", cwd: opts.cwd, cols: clamp(opts.cols, 2, MAX_COLS), rows: clamp(opts.rows, 1, MAX_ROWS),
      env: { ...process.env, ...opts.env, TERM_PROGRAM: "Realm" } as Record<string, string>,
    });
    p.onData((d) => this.cb.onData(id, d));
    p.onExit(({ exitCode }) => {
      // Only spontaneous exits notify; after an explicit close() the id is already gone and callers
      // (and possibly the DB) have moved on.
      if (!this.terms.delete(id)) return;
      this.cb.onExit(id, exitCode);
    });
    this.terms.set(id, p);
    return { id, shell };
  }
  has(id: string): boolean { return this.terms.has(id); }
  write(id: string, data: string): void { this.get(id).write(data); }
  resize(id: string, cols: number, rows: number): void { this.get(id).resize(clamp(cols, 2, MAX_COLS), clamp(rows, 1, MAX_ROWS)); }
  close(id: string): void { const p = this.get(id); p.kill(); this.terms.delete(id); }
  closeAll(): void { for (const id of [...this.terms.keys()]) this.close(id); }
  private get(id: string): pty.IPty { const p = this.terms.get(id); if (!p) throw new NotFoundError("terminal", id); return p; }
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.floor(n)));
