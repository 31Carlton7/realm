import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Environment, PairingWindow, PairRequest, Project, RemoteStatus, Space, TerminalStatus } from "@realm/contracts";
import { checkListen, classifyAddress, parseListenAddress, type ListenConfig } from "../access/listen";
import { createToken, listTokens, revokeToken } from "../access/tokens";
import { checkServerUrl, CtlError, type CtlClient, type Target } from "./client";
import { findProfile, profilesFile, readProfiles, removeProfile, saveProfile } from "./profiles";
import { terminalQr } from "./qr";
import { installService, serviceStatus, servicePlatform, uninstallService, type ServiceDeps } from "./service";
import { tailnetName, tailscaleServe, type Exec } from "./tailscale";

/**
 * `realm`: Realm's server, driven from a shell.
 *
 * Everything here is a thin composition of RPC methods the app itself uses — `projects.open`,
 * `environments.createWorktree`, `terminals.create`/`list`/`read`/`close` — so a script and the window
 * see the same spaces, worktrees and terminals. A command started with `realm run` shows up in
 * Realm's sidebar as a terminal, and a worktree made here is one the Changes pane can review.
 *
 * The server can be this machine's or another's: `--server` dials one elsewhere, at the listener
 * `realm serve --listen` opens, with an access token `realm token create` made there.
 *
 * Output is for people by default and for scripts with `--json`: one JSON document on stdout, errors
 * as `{ "error": { code, message } }`, and the exit code saying which it was.
 */
export const USAGE = `usage: realm <command> [options]

  serve [--port N] [--listen ADDR:PORT] [--tls-cert FILE --tls-key FILE] [--allow-plaintext]
        [--tailscale [--tailscale-port N]]
                                         run Realm's server here, without a window; --listen also
                                         takes clients on other machines, with an access token
  status                                 is a server running, and where
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
  pair                                   pair an iPhone with this server: a code to scan
  phones [list] | phones remove <id|name>
                                         the phones paired with it; remove one to revoke it
  token create <name> | list | revoke <id|name>
                                         access tokens for clients on other machines (made on
                                         the server itself; shown once)
  remote add <name> <url> [--ca FILE] [--allow-plaintext]
                                         save a server on another machine (the token is read
                                         from --token or stdin)
  remote list | remove <name>
  service install [serve options] | uninstall | status
                                         run realm serve in the background: a systemd user
                                         unit on Linux, a launchd agent on macOS

options: --home DIR (default $REALM_HOME, then ~/Realm)  --json
         --server URL|NAME (or $REALM_SERVER)  --token T (or $REALM_TOKEN)  --ca FILE (or $REALM_CA)
         --allow-plaintext  send the token over ws:// to another machine (a tailnet only)
With --server, paths are the server's and must be absolute.
After --, a single argument is a shell command line as written; several are quoted and joined.`;

/** What `realm serve` boots: the port of the loopback socket, and the remote listener if asked for. */
export type ServeOptions = { port: number | null; listen: ListenConfig | null };

export type CtlIo = {
  out: (s: string) => void;
  err: (s: string) => void;
  env: NodeJS.ProcessEnv;
  cwd: string;
  connect: (target: Target) => Promise<CtlClient>;
  /** Boot the server in this process. Resolves once it is listening; the process then stays up. */
  serve: (home: string, o: ServeOptions) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  /** A question for the person at the terminal, and their answer — null when there is nobody to ask
   *  (no terminal, end of input). */
  prompt?: (question: string) => Promise<string | null>;
  /** A secret read without echoing it (an access token). Null when there is none to read. */
  readSecret?: (question: string) => Promise<string | null>;
  /** Fires on Ctrl-C, so a command that waits can tidy up before it goes. */
  signal?: AbortSignal;
  /** The terminal's width, and whether it is one: the pairing code is drawn to fit, in black on white. */
  columns?: number;
  tty?: boolean;
  now?: () => number;
  /** Runs `tailscale` and the service managers. */
  exec?: Exec;
  /** Runs `command args` once as the process exits, synchronously (`serve --tailscale` takes Serve
   *  down again that way: an exiting process runs nothing asynchronous). */
  atExit?: (command: string, args: string[]) => void;
  /** How `realm service install` starts this `realm` again: the binary, and the script it runs. */
  self?: { execPath: string; script: string; runAsNode: boolean };
  /** The service manager's surroundings, for a test to stand in for; `platform` as `process.platform`
   *  names it. */
  service?: Partial<Omit<ServiceDeps, "platform">> & { platform?: string };
};

type Parsed = { positionals: string[]; flags: Map<string, string | true>; command: string[] | null };

/** Flags that take a value; every other `--flag` is a switch. */
const VALUED = new Set(["home", "base", "worktree", "timeout", "port", "server", "token", "ca", "listen", "tls-cert", "tls-key", "tailscale-port"]);

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

/** The default port a remote listener takes when `--tailscale` is given no `--listen`. */
const TAILSCALE_BACKEND_PORT = 7420;

/** A certificate file for a client to trust, read now so a typo fails before anything is dialled. */
function readCa(path: string): string {
  try { return readFileSync(path, "utf8"); } catch (e) {
    throw new CtlError("USAGE", `can't read the certificate ${path}: ${(e as Error).message}`);
  }
}

/** `realm serve`'s listener options, checked by the same rules the server applies (`access/listen.ts`). */
function serveListen(p: Parsed, flag: (n: string) => string | undefined, cwd: string): ListenConfig | null {
  const tailscale = p.flags.has("tailscale");
  const listen = flag("listen");
  const cert = flag("tls-cert"); const key = flag("tls-key");
  if ((cert === undefined) !== (key === undefined)) throw new CtlError("USAGE", "TLS needs both a certificate (--tls-cert) and its key (--tls-key)");
  if (listen === undefined && !tailscale) {
    if (cert || p.flags.has("allow-plaintext")) throw new CtlError("USAGE", "--tls-cert, --tls-key and --allow-plaintext go with --listen");
    return null;
  }
  const address = listen === undefined ? { host: "127.0.0.1", port: TAILSCALE_BACKEND_PORT } : parseListenAddress(listen);
  // Tailscale Serve is what reaches this listener from the tailnet; nothing else should.
  if (tailscale && classifyAddress(address.host) !== "loopback") throw new CtlError("USAGE", "with --tailscale, --listen takes a loopback address (127.0.0.1:PORT): Tailscale Serve is the way in");
  const config: ListenConfig = { ...address, tls: cert && key ? { cert: resolve(cwd, cert), key: resolve(cwd, key) } : null, allowPlaintext: p.flags.has("allow-plaintext") };
  checkListen(config);
  return config;
}

/** The serve flags again, absolute, for a service file that runs `realm serve` later from nowhere. */
function serveArgs(home: string, p: Parsed, flag: (n: string) => string | undefined, listen: ListenConfig | null): string[] {
  const args = ["serve", "--home", home];
  if (flag("port") !== undefined) args.push("--port", flag("port")!);
  if (listen && !(p.flags.has("tailscale") && flag("listen") === undefined)) {
    args.push("--listen", listen.host.includes(":") ? `[${listen.host}]:${listen.port}` : `${listen.host}:${listen.port}`);
  }
  if (listen?.tls) args.push("--tls-cert", listen.tls.cert, "--tls-key", listen.tls.key);
  if (listen?.allowPlaintext) args.push("--allow-plaintext");
  if (p.flags.has("tailscale")) args.push("--tailscale");
  if (flag("tailscale-port") !== undefined) args.push("--tailscale-port", flag("tailscale-port")!);
  return args;
}

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
  const remoteServer = flag("server") ?? io.env.REALM_SERVER;

  if (verb === "serve") {
    const port = flag("port");
    const tsPort = flag("tailscale-port");
    try {
      if (remoteServer) throw new CtlError("USAGE", "serve runs a server here; --server names one somewhere else");
      if (port !== undefined && !/^\d+$/.test(port)) throw new CtlError("USAGE", "--port takes a number");
      if (tsPort !== undefined && !/^\d+$/.test(tsPort)) throw new CtlError("USAGE", "--tailscale-port takes a number");
      const listen = serveListen(p, flag, io.cwd);
      const tailscale = p.flags.has("tailscale") && listen ? { exec: io.exec, httpsPort: tsPort === undefined ? 443 : Number(tsPort) } : null;
      if (tailscale && !tailscale.exec) throw new CtlError("TAILSCALE", "this realm cannot run tailscale");
      // Asked first: a machine that is not on a tailnet hears so before a server starts that nobody
      // could reach.
      const name = tailscale ? await tailnetName(tailscale.exec!) : null;
      await io.serve(home, { port: port === undefined ? null : Number(port), listen });
      if (tailscale && listen && name) {
        // The server is up from here on. A Serve that will not start leaves it up on loopback — the
        // sessions already resuming are not stopped over a proxy — and says what to run by hand.
        try {
          const ts = await tailscaleServe(tailscale.exec!, { name, port: listen.port, httpsPort: tailscale.httpsPort });
          io.atExit?.("tailscale", ts.off);
          io.err(`realm: reachable on your tailnet at ${ts.url} (make an access token with realm token create <name>)`);
        } catch (e) {
          io.err(`realm: the server is up on 127.0.0.1:${listen.port}, but Tailscale Serve is not: ${(e as Error).message}. Run tailscale serve --bg --https=${tailscale.httpsPort} http://127.0.0.1:${listen.port}`);
        }
      }
    } catch (e) { return fail(e); }
    return null;
  }

  // Commands that never talk to a server: access tokens and saved remotes are files on this machine.
  try {
    if (verb === "token") {
      if (remoteServer) throw new CtlError("USAGE", "access tokens are made on the server itself, by someone who can read its home; run realm token there");
      const sub = need(0, "a subcommand (create, list, revoke)");
      if (sub === "create") {
        const t = createToken(home, need(1, "<name>"));
        print(t, `${t.token}\n\nThat is the only time this token is shown. On the client:\n  realm remote add <name> <url>   (paste it when asked)\nor set REALM_TOKEN. Revoke it with: realm token revoke ${t.name}`);
        return 0;
      }
      if (sub === "list") {
        const all = listTokens(home);
        print(all, all.length === 0 ? "no access tokens (realm token create <name>)" : all.map((t) => `${t.id}  ${t.name}  made ${new Date(t.createdAt).toISOString()}`).join("\n"));
        return 0;
      }
      if (sub === "revoke") {
        const which = need(1, "<id|name>");
        if (!revokeToken(home, which)) throw new CtlError("NOT_FOUND", `no access token ${which} (realm token list)`);
        print({ ok: true }, `revoked ${which}; a client using it is disconnected within seconds`);
        return 0;
      }
      throw new CtlError("USAGE", USAGE);
    }
    if (verb === "remote") {
      const file = profilesFile(io.env);
      const sub = need(0, "a subcommand (add, list, remove)");
      if (sub === "add") {
        const name = need(1, "<name>");
        const url = need(2, "<url>");
        const allowPlaintext = p.flags.has("allow-plaintext");
        checkServerUrl(url, allowPlaintext);
        const caPath = flag("ca");
        const ca = caPath ? readCa(resolve(io.cwd, caPath)) : null;
        const token = (flag("token") ?? (await io.readSecret?.("Access token (from realm token create on the server): ")) ?? "").trim();
        if (!token) throw new CtlError("USAGE", "remote add needs the access token: paste it when asked, or pass --token");
        // Dialled before it is saved, so a typo in the URL or the token is found now, not at 2 a.m.
        const c = await io.connect({ kind: "url", url, token, ca, allowPlaintext });
        let info: { version: string; machineName: string; realmHome: string };
        try { info = await c.call("system.info"); } finally { c.close(); }
        saveProfile(file, { name, url, token, ca, allowPlaintext });
        print({ name, url, version: info.version, machineName: info.machineName, realmHome: info.realmHome },
          `saved ${name}: Realm ${info.version} on ${info.machineName} (${info.realmHome}). Use it with: realm --server ${name} <command>`);
        return 0;
      }
      if (sub === "list") {
        const all = readProfiles(file).map(({ name, url, ca, allowPlaintext }) => ({ name, url, ca: ca !== null, allowPlaintext }));
        print(all, all.length === 0 ? "no saved remotes (realm remote add <name> <url>)" : all.map((r) => `${r.name}  ${r.url}${r.ca ? "  (own certificate)" : ""}`).join("\n"));
        return 0;
      }
      if (sub === "remove") {
        const name = need(1, "<name>");
        if (!removeProfile(file, name)) throw new CtlError("NOT_FOUND", `no saved remote named ${name}`);
        print({ ok: true }, `removed ${name}`);
        return 0;
      }
      throw new CtlError("USAGE", USAGE);
    }
    if (verb === "service") {
      const sub = need(0, "a subcommand (install, uninstall, status)");
      const platform = servicePlatform(io.service?.platform ?? process.platform);
      const exec = io.exec;
      if (!exec) throw new CtlError("SERVICE", "this realm cannot run the service manager");
      const deps: ServiceDeps = {
        platform, exec, userHome: io.service?.userHome ?? homedir(), env: io.env, uid: io.service?.uid ?? process.getuid?.() ?? 0,
        writeFile: io.service?.writeFile ?? (() => { throw new Error("no file writer"); }),
        removeFile: io.service?.removeFile ?? (() => false),
        mkdir: io.service?.mkdir ?? (() => {}),
      };
      if (sub === "install") {
        if (remoteServer) throw new CtlError("USAGE", "a service runs on this machine; run realm service install on the server");
        if (!io.self) throw new CtlError("SERVICE", "this realm does not know how it was started");
        const listen = serveListen(p, flag, io.cwd);
        const argv = [io.self.execPath, io.self.script, ...serveArgs(home, p, flag, listen)];
        const r = await installService(deps, { argv, path: io.env.PATH ?? "/usr/bin:/bin", runAsNode: io.self.runAsNode, home });
        print({ file: r.file, argv }, `installed ${r.file}\nruns: ${argv.map(shellQuoteForShow).join(" ")}${r.advice ? `\n${r.advice}` : ""}`);
        return 0;
      }
      if (sub === "uninstall") {
        const r = await uninstallService(deps);
        print(r, r.removed ? `stopped it and removed ${r.file}` : `nothing installed at ${r.file}`);
        return 0;
      }
      if (sub === "status") {
        const r = await serviceStatus(deps);
        print(r, `${r.running ? "running" : "not running"} (${r.file})`);
        return r.running ? 0 : 1;
      }
      throw new CtlError("USAGE", USAGE);
    }
  } catch (e) {
    return fail(e);
  }

  let client: CtlClient | null = null;
  try {
    const target = resolveTarget(remoteServer, flag, p, io, home);
    client = await io.connect(target);
    const c = client;
    // A path names a file on the server. Here that is this machine; elsewhere it is that machine's, and
    // a relative path or a `~` this shell expanded would mean something else there.
    const serverPath = (path: string): string => {
      if (target.kind === "home") return resolve(io.cwd, path);
      if (!isAbsolute(path)) throw new CtlError("USAGE", `with --server, paths are the server's: give ${path} as an absolute path`);
      return path;
    };
    const open = (repo: string) => c.call<Opened>("projects.open", { path: serverPath(repo) });
    const worktree = (o: Opened, name: string) =>
      c.call<Environment>("environments.createWorktree", { spaceId: o.space.id, from: o.environment.id, title: name, base: flag("base") ?? null });

    switch (verb) {
      case "status": {
        const info = await c.call<{ realmHome: string; version: string; bootId: string; machineName: string; remoteUrl?: string | null }>("system.info");
        const where = target.kind === "home" ? info.realmHome : `${info.machineName}, ${info.realmHome}`;
        print({ running: true, ...info }, `Realm ${info.version} is running on ${where}${info.remoteUrl ? `\nlistening for clients on other machines at ${info.remoteUrl}` : ""}`);
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
        // A server elsewhere is asked less often: every round trip crosses a network.
        const every = target.kind === "home" ? 100 : 500;
        let all = await c.call<TerminalStatus[]>("terminals.list", {});
        // Every listed terminal by default, ended ones included: a command that finished before the
        // wait began is still one the caller is waiting to hear about.
        const ids = rest.length > 0 ? rest : all.map((t) => t.terminalId);
        for (const id of ids) if (!all.some((t) => t.terminalId === id)) throw new CtlError("NOT_FOUND", `terminal ${id} not found`);
        const mine = () => all.filter((t) => ids.includes(t.terminalId));
        while (mine().some((t) => t.running) && Date.now() < deadline) {
          await sleep(every);
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
      case "pair":
        return await pair(c, io, json, print);
      case "phones": {
        const sub = rest[0] ?? "list";
        const s = await c.call<RemoteStatus>("remote.status");
        if (sub === "list") {
          print(s.phones, s.phones.length === 0 ? "no phones paired (realm pair)" : s.phones.map((ph) =>
            `${ph.phoneId}  ${ph.name}  ${ph.model}  ${ph.lastSeen === null ? "never connected" : `last seen ${new Date(ph.lastSeen).toISOString()}`}`).join("\n"));
          return 0;
        }
        if (sub === "remove") {
          const which = need(1, "<id|name>");
          const matches = s.phones.filter((ph) => ph.phoneId === which || ph.name === which);
          if (matches.length === 0) throw new CtlError("NOT_FOUND", `no paired phone ${which} (realm phones)`);
          if (matches.length > 1) throw new CtlError("AMBIGUOUS", `${matches.length} phones are named ${which}; remove one by its id (realm phones)`);
          await c.call("remote.phones.remove", { phoneId: matches[0]!.phoneId });
          print({ ok: true, phoneId: matches[0]!.phoneId }, `removed ${matches[0]!.name}: it can no longer reach this server`);
          return 0;
        }
        throw new CtlError("USAGE", USAGE);
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

/** A word of a command line, quoted for reading when it needs it. */
const shellQuoteForShow = (w: string): string => (/^[A-Za-z0-9_\-.,/:=@%+[\]]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);

/**
 * The server a command goes to. With no `--server` (and no $REALM_SERVER) it is the one on this
 * machine's home. A URL needs a token beside it; a name is a remote saved with `realm remote add`,
 * whose token and certificate come with it.
 */
function resolveTarget(server: string | undefined, flag: (n: string) => string | undefined, p: Parsed, io: CtlIo, home: string): Target {
  if (!server) return { kind: "home", home };
  const caPath = flag("ca") ?? io.env.REALM_CA;
  const ca = caPath ? readCa(resolve(io.cwd, caPath)) : null;
  const allowPlaintext = p.flags.has("allow-plaintext");
  const token = flag("token") ?? io.env.REALM_TOKEN;
  if (/^wss?:\/\//i.test(server)) {
    if (!token) throw new CtlError("USAGE", "--server needs an access token: --token, $REALM_TOKEN, or a saved remote (realm remote add)");
    return { kind: "url", url: server, token, ca, allowPlaintext };
  }
  const profile = findProfile(profilesFile(io.env), server);
  if (!profile) throw new CtlError("NOT_FOUND", `no saved remote named ${server} (realm remote list)`);
  return { kind: "url", url: profile.url, token: token ?? profile.token, ca: ca ?? profile.ca, allowPlaintext: allowPlaintext || profile.allowPlaintext };
}

/** `5:00` for five minutes, as Settings ▸ Devices counts down. */
const clock = (ms: number): string => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

/**
 * `realm pair`: Settings ▸ Devices ▸ Pair an iPhone, in a terminal — for a server with no window
 * (a Linux box, a Mac running `realm serve`), or one on another machine (`--server`).
 *
 * It opens the same pairing window the sheet does and draws the same link as a code; a phone that
 * scans it and proves the code's secret is put to the person here, by name, and only a yes pairs it.
 * Ctrl-C closes the window, so a code left on a screen stops working when the command does.
 */
async function pair(c: CtlClient, io: CtlIo, json: boolean, print: (value: unknown, human: string) => void): Promise<number> {
  const now = io.now ?? Date.now;
  const say = (s: string) => (json ? io.err(s) : io.out(s));
  const requests: PairRequest[] = [];
  let wake: (() => void) | null = null;
  let dropped = false;
  const off = c.onEvent((event, payload) => {
    if (event === "remote.pairRequest") { requests.push(payload as PairRequest); wake?.(); }
  });
  c.onClose(() => { dropped = true; wake?.(); });
  const onAbort = () => wake?.();
  io.signal?.addEventListener("abort", onAbort);
  try {
    const started = now();
    const win = await c.call<PairingWindow>("remote.pair.start");
    const status = await c.call<RemoteStatus>("remote.status");
    say(`Open Realm on your iPhone and scan this, or paste the link below into Pair with your Mac.\n`);
    say(terminalQr(win.url, { columns: io.columns, color: io.tty !== false && !json }));
    say(`\n${win.url}\n`);
    say(`The code works once, for ${clock(win.expiresAt - now())}. Waiting for a phone… (Ctrl-C to stop)`);
    // One request at a time, the way the sheet asks them: a code that has been scanned twice is put
    // to the person twice, and each answer is that phone's alone.
    for (;;) {
      while (requests.length === 0) {
        if (dropped) throw new CtlError("DISCONNECTED", "the Realm server closed the connection");
        if (io.signal?.aborted) {
          await c.call("remote.pair.cancel").catch(() => {});
          say("Stopped. The code no longer works.");
          return 130;
        }
        const left = win.expiresAt - now();
        if (left <= 0) throw new CtlError("EXPIRED", "the code expired before a phone used it; run realm pair again for a new one");
        await new Promise<void>((resolveWait) => {
          const timer = setTimeout(resolveWait, Math.min(left, 1_000));
          wake = () => { clearTimeout(timer); resolveWait(); };
        });
        wake = null;
      }
      const r = requests.shift()!;
      if (r.windowId !== win.windowId) continue;
      const answer = await (io.prompt?.(`\nPair "${r.name}" (${r.model || "iPhone"})? It can read every session on ${status.macName} and answer for you. [y/N] `) ?? Promise.resolve(null));
      const accept = answer !== null && /^\s*y(es)?\s*$/i.test(answer);
      await c.call("remote.pair.answer", { requestId: r.requestId, accept });
      if (!accept) throw new CtlError("DECLINED", `did not pair ${r.name}`);
      // The phone is added once it has heard the answer; the status says so.
      const deadline = now() + 15_000;
      for (;;) {
        const s = await c.call<RemoteStatus>("remote.status");
        const phone = s.phones.find((ph) => ph.name === r.name && ph.addedAt >= started);
        if (phone) {
          print({ paired: true, phoneId: phone.phoneId, name: phone.name, model: phone.model, relay: s.relay },
            `Paired ${phone.name}. It reaches ${s.macName} through ${s.relay}. To take it back: realm phones remove ${phone.phoneId}`);
          return 0;
        }
        if (now() > deadline) throw new CtlError("PAIR_FAILED", `${r.name} did not finish pairing`);
        await (io.sleep ?? ((ms: number) => new Promise((res) => setTimeout(res, ms))))(200);
      }
    }
  } finally {
    off();
    io.signal?.removeEventListener("abort", onAbort);
  }
}
