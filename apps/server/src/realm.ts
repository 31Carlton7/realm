// `realm`: the command line for Realm's server (ctl/commands.ts). Built beside main.js, so `serve`
// can boot the very server bundle it was shipped with.
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { connect } from "./ctl/client";
import { runCtl } from "./ctl/commands";

const interrupted = new AbortController();
/** A question on stderr, so stdout stays the command's answer; the reply from stdin. A hidden one (a
 *  token) is read with the terminal in raw mode and no output stream, so nothing typed is echoed — and
 *  the mode is set before the question is shown, so not even a paste that beats the prompt is. */
const ask = (question: string, hidden = false): Promise<string | null> => new Promise((resolve) => {
  const rl = createInterface({ input: process.stdin, terminal: Boolean(process.stdin.isTTY && hidden) });
  process.stderr.write(question);
  let answered = false;
  rl.once("line", (line) => { answered = true; rl.close(); if (hidden) process.stderr.write("\n"); resolve(line); });
  rl.once("close", () => { if (!answered) resolve(null); });
  interrupted.signal.addEventListener("abort", () => rl.close(), { once: true });
});
const script = fileURLToPath(import.meta.url);
// Ctrl-C while a command waits (realm pair) lets it tidy up first — close the pairing window — and a
// second one stops it outright. A server installs its own handler instead, and leaves through that.
const onInterrupt = () => {
  if (interrupted.signal.aborted) process.exit(130);
  interrupted.abort();
};
process.on("SIGINT", onInterrupt);

const code = await runCtl(process.argv.slice(2), {
  out: (s) => process.stdout.write(s + "\n"),
  err: (s) => process.stderr.write(s + "\n"),
  env: process.env, cwd: process.cwd(), connect,
  serve: async (home, o) => {
    process.env.REALM_HOME = home;
    if (o.port !== null) process.env.REALM_PORT = String(o.port);
    // The listener goes over in the environment, every variable set or cleared here: one inherited from
    // the shell must never widen what was asked for on the command line.
    const set = (k: string, v: string | null) => { if (v === null) delete process.env[k]; else process.env[k] = v; };
    set("REALM_LISTEN", o.listen ? (o.listen.host.includes(":") ? `[${o.listen.host}]:${o.listen.port}` : `${o.listen.host}:${o.listen.port}`) : null);
    set("REALM_TLS_CERT", o.listen?.tls?.cert ?? null);
    set("REALM_TLS_KEY", o.listen?.tls?.key ?? null);
    set("REALM_ALLOW_PLAINTEXT", o.listen?.allowPlaintext ? "1" : null);
    process.off("SIGINT", onInterrupt);
    // A server started from here has no Realm window to hand it the keychain's keys, so Realm Mobile
    // keeps its own in this home (remote/service.ts).
    process.env.REALM_HEADLESS = "1";
    // main.js names its bundle from argv[1] (the state file's `bundleId`, which a launcher compares
    // against the app it ships with), so it must read as itself, not as this file.
    const main = new URL("./main.js", import.meta.url);
    process.argv[1] = fileURLToPath(main);
    await import(main.href);
  },
  prompt: (q) => ask(q),
  readSecret: (q) => ask(q, true),
  signal: interrupted.signal,
  columns: process.stdout.columns,
  tty: Boolean(process.stdout.isTTY),
  exec: (command, args) => new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 60_000 }, (err, stdout, stderr) => {
      if (err && typeof (err as NodeJS.ErrnoException).code === "string") { reject(err); return; } // not found, not runnable
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  }),
  atExit: (command, args) => process.on("exit", () => { try { execFileSync(command, args, { stdio: "ignore", timeout: 10_000 }); } catch { /* best effort on the way out */ } }),
  self: { execPath: process.execPath, script, runAsNode: Boolean(process.versions.electron) },
  service: {
    writeFile: (path, text) => writeFileSync(path, text, { mode: 0o644 }),
    removeFile: (path) => { try { rmSync(path); return true; } catch { return false; } },
    mkdir: (path) => mkdirSync(path, { recursive: true }),
  },
});
if (code !== null) process.exit(code);
