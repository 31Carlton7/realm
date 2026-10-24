import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Environment, Project, Space, TerminalStatus } from "@realm/contracts";
import { CtlError, type CtlClient } from "./client";

/**
 * `realm`: Realm's server, driven from a shell.
 *
 * Everything here is a thin composition of RPC methods the app itself uses — `projects.open`,
 * `environments.createWorktree`, `terminals.create`/`list`/`read`/`close` — so a script and the window
 * see the same spaces, worktrees and terminals. A command started with `realm run` shows up in
 * Realm's sidebar as a terminal, and a worktree made here is one the Changes pane can review.
 *
 * Output is for people by default and for scripts with `--json`: one JSON document on stdout, errors
 * as `{ "error": { code, message } }`, and the exit code saying which it was.
 */
export const USAGE = `usage: realm <command> [options]

  serve [--port N]                       run Realm's server here, without a window
  status                                 is a server running on this home
  repo add <path>                        open a git checkout as a project (idempotent)
  worktree create <repo> <name> [--base REF]
                                         a new worktree of <repo> on branch realm/<name>
  worktree list <repo>                   the worktrees Realm made of <repo>
  worktree remove <id> [--force]         remove one; --force also drops uncommitted work
  run <repo> [--worktree NAME] [--base REF] -- <command...>
                                         run a command (an agent CLI, a script) in a terminal,
                                         in a new worktree when --worktree is given
  ps                                     every terminal and how it ended
  wait [<terminal>...] [--timeout S]     block until they exit (default: every terminal)
  logs <terminal>                        what a terminal printed
  kill <terminal>                        stop a terminal and close it

options: --home DIR (default $REALM_HOME, then ~/Realm)  --json
After --, a single argument is a shell command line as written; several are quoted and joined.`;

export type CtlIo = {
  out: (s: string) => void;
  err: (s: string) => void;
  env: NodeJS.ProcessEnv;
  cwd: string;
  connect: (home: string) => Promise<CtlClient>;
  /** Boot the server in this process. Resolves once it is listening; the process then stays up. */
  serve: (home: string, port: number | null) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
};

type Parsed = { positionals: string[]; flags: Map<string, string | true>; command: string[] | null };

/** Flags that take a value; every other `--flag` is a switch. */
const VALUED = new Set(["home", "base", "worktree", "timeout", "port"]);

export function parseArgs(argv: string[]): Parsed {
  const dash = argv.indexOf("--");
  const head = dash === -1 ? argv : argv.slice(0, dash);
  const command = dash === -1 ? null : argv.slice(dash + 1);
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < head.length; i++) {
    const a = head[i]!;
    if (!a.startsWith("--")) { positionals.push(a); continue; }
    const eq = a.indexOf("=");
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (eq !== -1) { flags.set(name, a.slice(eq + 1)); continue; }
    if (VALUED.has(name)) {
      const v = head[i + 1];
      if (v === undefined) throw new CtlError("USAGE", `--${name} needs a value`);
      flags.set(name, v); i++;
    } else flags.set(name, true);
  }
  return { positionals, flags, command };
}

/** POSIX single-quoting, skipped for words that need none so `ps` reads the way it was typed. */
export const shellQuote = (word: string): string => (/^[A-Za-z0-9_\-.,/:=@%+]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);

/** What runs after `--`. One argument is already a command line (`-- "env X=1 agent 'fix it'"`), and
 *  re-quoting it would turn it into one long program name; several are argv, quoted back into one. */
export function commandLine(words: string[]): string {
  if (words.length === 0) throw new CtlError("USAGE", "nothing to run after --");
  return words.length === 1 ? words[0]! : words.map(shellQuote).join(" ");
}

/** How a terminal ended, the way `ps` prints it. */
export function describeState(t: TerminalStatus): string {
  if (t.running) return "running";
  if (t.signal !== null) return `killed (signal ${t.signal})`;
  return `exited ${t.exitCode}`;
}

const succeeded = (t: TerminalStatus): boolean => !t.running && t.exitCode === 0 && t.signal === null;

type Opened = { space: Space; project: Project; environment: Environment };

/** Run one `realm` invocation. Resolves to the exit code, or null when the process should stay up
 *  (`serve`). */
export async function runCtl(argv: string[], io: CtlIo): Promise<number | null> {
  // Only a --json before `--`: one after it is the command's own.
  const dash = argv.indexOf("--");
  const json = (dash === -1 ? argv : argv.slice(0, dash)).includes("--json");
  const fail = (e: unknown): number => {
    const code = e instanceof CtlError ? e.code : "ERROR";
    const message = e instanceof Error ? e.message : String(e);
    if (json) io.out(JSON.stringify({ error: { code, message } }));
    else io.err(`realm: ${message}`);
    return code === "USAGE" ? 2 : 1;
  };
  let p: Parsed;
  try { p = parseArgs(argv); } catch (e) { return fail(e); }
  const [verb, ...rest] = p.positionals;
  if (!verb || verb === "help" || p.flags.has("help")) { io.out(USAGE); return verb ? 0 : 2; }
  const flag = (name: string): string | undefined => { const v = p.flags.get(name); return typeof v === "string" ? v : undefined; };
  const home = resolve(io.cwd, flag("home") ?? io.env.REALM_HOME ?? join(homedir(), "Realm"));
  const print = (value: unknown, human: string) => io.out(json ? JSON.stringify(value) : human);
  const need = (i: number, what: string): string => {
    const v = rest[i];
    if (v === undefined) throw new CtlError("USAGE", `${verb}: missing ${what}\n\n${USAGE}`);
    return v;
  };

  if (verb === "serve") {
    const port = flag("port");
    if (port !== undefined && !/^\d+$/.test(port)) return fail(new CtlError("USAGE", "--port takes a number"));
    try { await io.serve(home, port === undefined ? null : Number(port)); } catch (e) { return fail(e); }
    return null;
  }

  let client: CtlClient | null = null;
  try {
    client = await io.connect(home);
    const c = client;
    const open = (repo: string) => c.call<Opened>("projects.open", { path: resolve(io.cwd, repo) });
    const worktree = (o: Opened, name: string) =>
      c.call<Environment>("environments.createWorktree", { spaceId: o.space.id, from: o.environment.id, title: name, base: flag("base") ?? null });

    switch (verb) {
      case "status": {
        const info = await c.call<{ realmHome: string; version: string; bootId: string }>("system.info");
        print({ running: true, ...info }, `Realm ${info.version} is running on ${info.realmHome}`);
        return 0;
      }
      case "repo": {
        if (need(0, "a subcommand (add)") !== "add") throw new CtlError("USAGE", USAGE);
        const o = await open(need(1, "<path>"));
        print({ spaceId: o.space.id, projectId: o.project.id, environmentId: o.environment.id, path: o.environment.path },
          `${o.environment.path} is project ${o.project.name} in space ${o.space.name}`);
        return 0;
      }
      case "worktree": {
        const sub = need(0, "a subcommand (create, list, remove)");
        if (sub === "create") {
          const o = await open(need(1, "<repo>"));
          const env = await worktree(o, need(2, "<name>"));
          print({ environmentId: env.id, spaceId: env.spaceId, path: env.path, branch: env.branch }, `${env.branch}  ${env.path}`);
          return 0;
        }
        if (sub === "list") {
          const o = await open(need(1, "<repo>"));
          const envs = (await c.call<Environment[]>("environments.list", { spaceId: o.space.id })).filter((e) => e.kind === "worktree");
          print(envs.map((e) => ({ environmentId: e.id, path: e.path, branch: e.branch })), envs.map((e) => `${e.id}  ${e.branch}  ${e.path}`).join("\n"));
          return 0;
        }
        if (sub === "remove") {
          const id = need(1, "<id>");
          let acknowledge = null;
          if (p.flags.has("force")) {
            const st = await c.call<{ dirtyFiles: number; unpushedCommits: number }>("environments.worktreeStatus", { id });
            acknowledge = { dirtyFiles: st.dirtyFiles, unpushedCommits: st.unpushedCommits };
          }
          await c.call("environments.removeWorktree", { id, acknowledge });
          print({ ok: true }, `removed ${id}`);
          return 0;
        }
        throw new CtlError("USAGE", USAGE);
      }
      case "run": {
        if (!p.command) throw new CtlError("USAGE", `run: put the command after --\n\n${USAGE}`);
        const command = commandLine(p.command);
        const o = await open(need(0, "<repo>"));
        const name = flag("worktree");
        const env = name ? await worktree(o, name) : o.environment;
        const t = await c.call<{ terminalId: string }>("terminals.create", { spaceId: o.space.id, cwd: env.path, command });
        print({ terminalId: t.terminalId, spaceId: o.space.id, environmentId: env.id, path: env.path, branch: env.branch },
          `${t.terminalId}  ${env.branch ?? ""}  ${env.path}`);
        return 0;
      }
      case "ps": {
        const all = await c.call<TerminalStatus[]>("terminals.list", {});
        print(all, all.map((t) => `${t.terminalId}  ${describeState(t).padEnd(18)}  ${t.cwd}${t.command ? `  ${t.command}` : ""}`).join("\n"));
        return 0;
      }
      case "wait": {
        const timeoutS = flag("timeout");
        const deadline = timeoutS === undefined ? Infinity : Date.now() + Number(timeoutS) * 1000;
        const sleep = io.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
        let all = await c.call<TerminalStatus[]>("terminals.list", {});
        // Every listed terminal by default, ended ones included: a command that finished before the
        // wait began is still one the caller is waiting to hear about.
        const ids = rest.length > 0 ? rest : all.map((t) => t.terminalId);
        for (const id of ids) if (!all.some((t) => t.terminalId === id)) throw new CtlError("NOT_FOUND", `terminal ${id} not found`);
        const mine = () => all.filter((t) => ids.includes(t.terminalId));
        while (mine().some((t) => t.running) && Date.now() < deadline) {
          await sleep(100);
          all = await c.call<TerminalStatus[]>("terminals.list", {});
        }
        const done = mine();
        print(done, done.map((t) => `${t.terminalId}  ${describeState(t)}`).join("\n"));
        if (done.some((t) => t.running)) return 124;
        return done.every(succeeded) ? 0 : 1;
      }
      case "logs": {
        const r = await c.call<{ live: string; history: { data: string } | null }>("terminals.read", { terminalId: need(0, "<terminal>"), cursor: null });
        const text = (r.history?.data ?? "") + r.live;
        print({ output: text }, text);
        return 0;
      }
      case "kill": {
        const id = need(0, "<terminal>");
        await c.call("terminals.close", { terminalId: id });
        print({ ok: true }, `closed ${id}`);
        return 0;
      }
      default:
        throw new CtlError("USAGE", `unknown command ${verb}\n\n${USAGE}`);
    }
  } catch (e) {
    return fail(e);
  } finally {
    client?.close();
  }
}
