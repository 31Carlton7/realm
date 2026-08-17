import * as pty from "node-pty";
import { newId } from "@realm/contracts";
import { NotFoundError } from "../store/rows";

export type TerminalCallbacks = { onData: (id: string, data: string) => void; onExit: (id: string, exitCode: number) => void };

export class TerminalManager {
  private terms = new Map<string, pty.IPty>();
  constructor(private cb: TerminalCallbacks) {}

  create(opts: { cwd: string; cols: number; rows: number; shell?: string; env?: Record<string, string> }): string {
    const id = newId();
    const shell = opts.shell ?? process.env.SHELL ?? "/bin/zsh";
    const p = pty.spawn(shell, [], {
      name: "xterm-256color", cwd: opts.cwd, cols: opts.cols, rows: opts.rows,
      env: { ...process.env, ...opts.env, TERM_PROGRAM: "Realm" } as Record<string, string>,
    });
    p.onData((d) => this.cb.onData(id, d));
    p.onExit(({ exitCode }) => { this.terms.delete(id); this.cb.onExit(id, exitCode); });
    this.terms.set(id, p);
    return id;
  }
  has(id: string): boolean { return this.terms.has(id); }
  write(id: string, data: string): void { this.get(id).write(data); }
  resize(id: string, cols: number, rows: number): void { this.get(id).resize(Math.max(2, cols), Math.max(1, rows)); }
  close(id: string): void { const p = this.terms.get(id); if (p) { p.kill(); this.terms.delete(id); } }
  closeAll(): void { for (const id of [...this.terms.keys()]) this.close(id); }
  private get(id: string): pty.IPty { const p = this.terms.get(id); if (!p) throw new NotFoundError("terminal", id); return p; }
}
