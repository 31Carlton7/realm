import { execFile } from "node:child_process";
import { identifyProgram, isInterpreterName, isShellName, sameProgram, type TerminalProgram } from "@realm/contracts";

/**
 * What each terminal is running, kept current for the tabs that name it.
 *
 * Two reads, of very different cost. The kernel's name for the foreground process group's leader is
 * node-pty's `process` — `tcgetpgrp` on the pty and one sysctl, no process spawned — so it can be
 * asked often. The leader's argv takes `ps`, a process per read, so it is read only when that name
 * CHANGES: a shell giving way to `claude`, `claude` exiting back to the prompt. The name alone cannot
 * be trusted to say what is running (see `ForegroundProcess.comm`), which is why the argv is read at
 * all, and the name is what makes reading it rare.
 *
 * WHEN to look follows the output rather than the clock. A program starting or stopping is almost
 * always heard: the shell echoes the Return that started it and redraws its prompt when it is done,
 * and a shell or an agent that titles the window says so in an OSC on the same stream. So output
 * schedules a look a moment after it settles. The clock is the backstop for the program that starts
 * silently — `sleep 30` prints nothing — and that look is the cheap one.
 *
 * It runs for every live terminal, not only the tabs on screen, because a tab that is NOT showing is
 * exactly where "the agent in the other terminal" has to be said, and the look a visible pane could
 * ask for is the same syscall pair this timer already makes.
 */

/** How long after output settles the foreground is looked at. Long enough that a shell has forked
 *  and exec'd the command whose Return it just echoed; short enough that a tab follows the person. */
export const FOREGROUND_SETTLE_MS = 300;
/** The backstop look, for a program that starts without printing anything. */
export const FOREGROUND_POLL_MS = 3_000;
/** How long an interpreter's argv stands for it. `node a.js; node b.js` changes the program without
 *  ever changing the kernel's name, so a name that is an interpreter is re-read this often. */
export const FOREGROUND_REFRESH_MS = 15_000;

export type ForegroundSource = {
  /** The foreground group leader's short name, or null when the pty is gone. Cheap. */
  name(terminalId: string): string | null;
  /** The leader's argv, or null when it could not be read. Spawns `ps`. */
  argv(terminalId: string): Promise<string[] | null>;
};

type Tracked = {
  /** The name the current `program` was resolved from, and when — null until the first look. */
  name: string | null;
  resolvedAt: number;
  program: TerminalProgram | null;
  settle: ReturnType<typeof setTimeout> | null;
  /** A look is reading `ps`; a second one asked for meanwhile runs after it rather than beside it. */
  reading: boolean;
  again: boolean;
};

export class ForegroundWatcher {
  private tracked = new Map<string, Tracked>();
  private poll: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private d: {
    source: ForegroundSource;
    onChange: (terminalId: string, program: TerminalProgram | null) => void;
    now?: () => number;
    setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  }) {
    this.now = d.now ?? Date.now;
  }

  /** Start looking at this terminal. It starts at its shell, which is a program of null. */
  watch(terminalId: string): void {
    if (this.tracked.has(terminalId)) return;
    this.tracked.set(terminalId, { name: null, resolvedAt: 0, program: null, settle: null, reading: false, again: false });
    if (!this.poll) {
      this.poll = (this.d.setInterval ?? setInterval)(() => { for (const id of this.tracked.keys()) void this.look(id); }, FOREGROUND_POLL_MS);
      // Like the scrollback flush: this timer must never be the reason an idle daemon stays up.
      this.poll.unref?.();
    }
  }

  forget(terminalId: string): void {
    const t = this.tracked.get(terminalId);
    if (t?.settle) clearTimeout(t.settle);
    this.tracked.delete(terminalId);
  }

  /** The terminal printed something: look once it settles. A stream of output looks once per
   *  `FOREGROUND_SETTLE_MS`, not once per chunk — an agent redrawing its spinner is a lot of chunks. */
  poke(terminalId: string): void {
    const t = this.tracked.get(terminalId);
    if (!t || t.settle) return;
    t.settle = (this.d.setTimeout ?? setTimeout)(() => { t.settle = null; void this.look(terminalId); }, FOREGROUND_SETTLE_MS);
  }

  program(terminalId: string): TerminalProgram | null {
    return this.tracked.get(terminalId)?.program ?? null;
  }

  /** Every terminal running something other than its shell. */
  programs(): Record<string, TerminalProgram> {
    const out: Record<string, TerminalProgram> = {};
    for (const [id, t] of this.tracked) if (t.program) out[id] = t.program;
    return out;
  }

  /** Read the foreground, and announce the program if it changed. */
  async look(terminalId: string): Promise<void> {
    const t = this.tracked.get(terminalId);
    if (!t) return;
    if (t.reading) { t.again = true; return; }
    const name = this.d.source.name(terminalId);
    if (name === null) return;
    const stale = isInterpreterName(name) && this.now() - t.resolvedAt >= FOREGROUND_REFRESH_MS;
    if (name === t.name && !stale) return;
    t.reading = true;
    try {
      // A shell is the prompt: its argv would say nothing the name has not, so `ps` is not run.
      const next = isShellName(name) ? null : identifyProgram({ comm: name, argv: await this.d.source.argv(terminalId) });
      // Closed while `ps` ran: there is no tab left to tell.
      if (this.tracked.get(terminalId) !== t) return;
      t.name = name;
      t.resolvedAt = this.now();
      if (!sameProgram(t.program, next)) {
        t.program = next;
        this.d.onChange(terminalId, next);
      }
    } finally {
      t.reading = false;
      if (t.again) { t.again = false; void this.look(terminalId); }
    }
  }

  stop(): void {
    if (this.poll) { clearInterval(this.poll); this.poll = null; }
    for (const id of [...this.tracked.keys()]) this.forget(id);
  }
}

/**
 * The argv of the leader of a tty's foreground process group, read with `ps`.
 *
 * Every process on the tty, in one call, rather than asking for the foreground group first: `tpgid`
 * on each row IS the foreground group, so one spawn answers both questions. The leader is the row
 * whose pid is that group; when the leader has exited and its group lingers, any member of the group
 * stands in for it. Split on spaces, because `ps` cannot print an argv any other way — a path with a
 * space in it reads as two words, and the cost of that is a script named after half its directory.
 */
export async function readForegroundArgv(tty: string,
  run: (file: string, args: string[]) => Promise<string> = execText): Promise<string[] | null> {
  let out: string;
  try {
    out = await run("ps", ["-ww", "-o", "pid=,pgid=,tpgid=,args=", "-t", tty.replace(/^\/dev\//, "")]);
  } catch {
    return null;
  }
  const rows = out.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), pgid: Number(m[2]), tpgid: Number(m[3]), args: m[4]!.trim() }] : [];
  });
  const fg = rows.find((r) => r.pid === r.tpgid) ?? rows.find((r) => r.pgid === r.tpgid);
  return fg && fg.args ? fg.args.split(/\s+/) : null;
}

const execText = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 2_000, encoding: "utf8" }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
