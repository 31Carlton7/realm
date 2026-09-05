import { spawn, type ChildProcess } from "node:child_process";
import {
  AGENT_INSTALL_ROUTES, installCommand, newId, updateCommand,
  type AgentKind, type CliJobEnd, type CliJobOutput, type CliJobStart, type InstallRoute,
} from "@realm/contracts";

export type InstallAction = "install" | "update";

/** A command in both the forms this feature needs at once: the string the user reads before clicking,
 *  and the argv Realm spawns. They are produced together so the second can never be something other
 *  than the first — the whole promise of showing a command is that it is the one that runs. */
export type CommandSpec = { display: string; file: string; args: string[] };

/**
 * The shell used for install routes that are a pipeline (`curl … | bash`), and nothing else.
 *
 * Deliberately `-c` alone: NOT `-l` and NOT `-i`. A login/interactive shell re-runs the user's rc
 * files, can block on a prompt, and would give the child a PATH assembled by a second, different
 * mechanism than the one the server was started with. The server already inherits the merged login
 * PATH from the desktop main (see login-shell-path.ts), so a plain `-c` shell — which exists only to
 * interpret the pipe — is the smallest thing that can run these commands.
 */
const PIPELINE_SHELL = "/bin/bash";

/**
 * Turn a route into something runnable, or null when Realm must not run anything.
 *
 * npm and brew are argv-shaped and get no shell at all: a package name never reaches a command line
 * where quoting or globbing could reinterpret it. Only the vendor script routes need a shell, and
 * only because the command the vendor publishes is a pipeline.
 */
export function commandSpec(route: InstallRoute | null, action: InstallAction, latest: string | null): CommandSpec | null {
  const display = action === "install" ? installCommand(route) : updateCommand(route, latest ?? "");
  if (!route || !display) return null;
  if (route.method === "npm") {
    const pkg = action === "install" ? route.pkg : `${route.pkg}@${latest}`;
    return { display, file: "npm", args: ["install", "-g", pkg] };
  }
  if (route.method === "brew") {
    return { display, file: "brew", args: [action === "install" ? "install" : "upgrade", route.formula] };
  }
  return { display, file: PIPELINE_SHELL, args: ["-c", route.command] };
}

/** The spec for `kind`, resolved through the route table. Null when that kind has no such action. */
export function specFor(kind: AgentKind, action: InstallAction, latest: string | null): CommandSpec | null {
  return commandSpec(AGENT_INSTALL_ROUTES[kind], action, latest);
}

/** A package manager on a cold cache is slow; a package manager waiting for something is forever.
 *  Ten minutes is past the first and well short of the second. */
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

/** Installer output is meant to be read, not archived. Past this many bytes the job keeps running
 *  and stops narrating, so a runaway build log cannot flood the socket or the renderer's state. */
const MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * Runs one install or update command, streaming what it says.
 *
 * Every guard here answers "what if this is the wrong command, or the right one misbehaves":
 *
 *  - **stdin is closed.** A package manager that decides to ask something gets EOF and fails fast,
 *    rather than blocking forever on a TTY that a background child process does not have.
 *  - **One job per kind.** A second click while npm is mid-install would race two writers into the
 *    same global prefix.
 *  - **Colour off.** The renderer shows this text in a plain block; ANSI escapes would render as
 *    punctuation. NO_COLOR and FORCE_COLOR=0 are the two spellings npm and brew respectively honour.
 *  - **A re-probe afterwards, always** — including after a failure, because a failed install can
 *    still have changed the machine, and the UI must show what is there rather than what was asked
 *    for.
 */
export class CliInstaller {
  private jobs = new Map<AgentKind, { id: string; child: ChildProcess }>();

  constructor(private readonly d: {
    onOutput: (e: CliJobOutput) => void;
    onDone: (e: CliJobEnd) => void;
    /** Re-runs the probe and version check with their caches bypassed. */
    afterRun: () => Promise<unknown>;
    spawnImpl?: typeof spawn;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  }) {}

  /** True while a command is running for this kind. */
  running(kind: AgentKind): boolean {
    return this.jobs.has(kind);
  }

  /**
   * Start `spec` for `kind`. The returned job carries the exact command that is now running, so a
   * caller that showed the user one string and got a different one back would be able to tell.
   *
   * Throws rather than queuing when a job for this kind is already running: a second run is a
   * double-click, and answering it with "already running" is the truth.
   */
  start(kind: AgentKind, action: InstallAction, spec: CommandSpec): CliJobStart {
    if (this.jobs.has(kind)) throw new Error(`${kind} is already installing`);
    const id = newId();
    const spawnImpl = this.d.spawnImpl ?? spawn;
    const child = spawnImpl(spec.file, spec.args, {
      env: { ...(this.d.env ?? process.env), NO_COLOR: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    this.jobs.set(kind, { id, child });

    let sent = 0;
    let truncated = false;
    const emit = (chunk: string): void => {
      if (truncated) return;
      if (sent + chunk.length > MAX_OUTPUT_BYTES) {
        truncated = true;
        this.d.onOutput({ id, kind, chunk: "\n… output truncated; the command is still running.\n" });
        return;
      }
      sent += chunk.length;
      this.d.onOutput({ id, kind, chunk });
    };
    // stderr is merged into the same stream because a package manager's progress, warnings and
    // errors are one narrative and splitting them loses the order the user needs to read them in.
    child.stdout?.on("data", (b: Buffer) => emit(b.toString()));
    child.stderr?.on("data", (b: Buffer) => emit(b.toString()));

    const timer = setTimeout(() => child.kill("SIGTERM"), this.d.timeoutMs ?? RUN_TIMEOUT_MS);
    let settled = false;
    const finish = (end: Omit<CliJobEnd, "id" | "kind">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.jobs.delete(kind);
      // The re-probe is awaited before the done event so a client that refetches on `done` reads the
      // new truth, not the cache the install just invalidated.
      void this.d.afterRun().catch(() => {}).then(() => this.d.onDone({ id, kind, ...end }));
    };
    // "error" fires instead of "close" when the binary itself is missing (no npm, no brew) — the one
    // failure a user is most likely to hit, and the one with the most useful message.
    child.on("error", (e: Error) => finish({ ok: false, code: null, error: e.message }));
    child.on("close", (code) => finish({ ok: code === 0, code, error: code === 0 ? null : `exited with code ${code ?? "unknown"}` }));
    return { id, kind, action, command: spec.display };
  }

  /** Stop everything on shutdown; a package manager outliving the app would keep writing to a global
   *  prefix with nobody watching. */
  disposeAll(): void {
    for (const { child } of this.jobs.values()) child.kill("SIGTERM");
    this.jobs.clear();
  }
}
