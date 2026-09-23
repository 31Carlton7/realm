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

  create(opts: {
    id?: string; cwd: string; cols: number; rows: number; shell?: string; env?: Record<string, string>;
    /**
     * Last look at the argv before it becomes a process — the execution sandbox's hook (see
     * `TerminalService.wrapFor`). Given the shell and its arguments, it returns what to spawn
     * instead, which for a sandboxed space is `sandbox-exec` with the shell behind a `--`.
     *
     * It **may throw**, and a throw must reach the caller: that is the fail-closed gate, and
     * swallowing it here would spawn an unconfined shell in a space whose Settings say otherwise.
     * Absent means spawn exactly what this function has always spawned.
     */
    wrap?: (command: string, args: string[]) => { command: string; args: string[] };
  }): { id: string; shell: string } {
    const id = opts.id ?? newId();
    const shell = opts.shell ?? process.env.SHELL ?? "/bin/zsh";
    // Login shell (`-l`): a non-login zsh never reads /etc/zprofile, so path_helper's PATH (and the
    // user's ~/.zprofile additions) are missing — visible in a packaged app, where the inherited env
    // is launchd's, not a terminal's. bash/zsh/fish/sh all accept -l; Windows shells do not.
    const args = process.platform === "win32" ? [] : ["-l"];
    const spawned = opts.wrap ? opts.wrap(shell, args) : { command: shell, args };
    const p = pty.spawn(spawned.command, spawned.args, {
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
    // The LOGICAL shell, not `spawned.command`. The caller stores this in the terminals row, and a
    // row that said `/usr/bin/sandbox-exec` would come back from `restoreAll` doubly wrapped — and
    // would keep the old policy frozen into the DB after the user changed it.
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
    if (!(await this.quietFor(id, quietMs, timeoutMs))) return; // the shell died while we waited
    if (this.terms.has(id)) this.write(id, data);
  }

  /**
   * Resolve once the shell has produced nothing for `quietMs`, or `timeoutMs` elapses.
   *
   * The waiting half of `writeWhenQuiet`, extracted because an agent needs it on its own: having
   * typed something, the useful next move is "wait for the program to finish reacting, then read the
   * screen", and that is this without a write on the end of it.
   *
   * False means the pty is gone — the caller's terminal exited while it waited, which is a different
   * outcome from "it went quiet" and must not be reported as one. Reaching the timeout is still
   * true: a shell that is still talking after `timeoutMs` has told the caller something real, and
   * the screen is worth reading either way.
   */
  async quietFor(id: string, quietMs = 250, timeoutMs = 4000): Promise<boolean> {
    const deadline = this.now() + timeoutMs;
    for (;;) {
      if (!this.terms.has(id)) return false;
      const since = this.now() - (this.lastDataAt.get(id) ?? 0);
      if (since >= quietMs || this.now() >= deadline) return true;
      await new Promise((r) => setTimeout(r, Math.min(quietMs - since, 50)));
    }
  }
  resize(id: string, cols: number, rows: number): void { this.get(id).resize(clamp(cols, 2, MAX_COLS), clamp(rows, 1, MAX_ROWS)); }
  close(id: string): void { const p = this.get(id); p.kill(); this.terms.delete(id); this.lastDataAt.delete(id); }
  closeAll(): void { for (const id of [...this.terms.keys()]) this.close(id); }
  private get(id: string): pty.IPty { const p = this.terms.get(id); if (!p) throw new NotFoundError("terminal", id); return p; }
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.floor(n)));
