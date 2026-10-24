/**
 * The remote runtime, live (pnpm --filter @realm/server exec tsx scripts/remote-runtime-live.ts [evidence-dir])
 *
 * Two scratch homes on this Mac stand in for two machines, each served by the BUILT `realm serve` with
 * the fake agent: "the server" (loopback 8802, remote listener wss://127.0.0.1:9242 with a self-signed
 * certificate) and "the client" (8812, its own loopback listener on 9252). The client's `realm` saves
 * the server as a remote and drives it — a worktree, a command, its exit and its output — over TLS with
 * an access token, while its own home stays its own. Then every refusal: no token, a wrong one, the
 * server's own daemon token, an untrusted certificate, a browser page, plain ws:// across a network,
 * a listener on every address or a private one without TLS, a revoked token (and the connection it
 * held), and the address that keeps failing.
 *
 * Last, `realm pair` on the server, in a pseudo-terminal: a stand-in phone pairs through a relay on
 * loopback with the code the terminal printed, the owner's yes is typed at the prompt, and the server
 * is restarted with no window to show its phone still reaches it. The terminal's bytes are saved for
 * rendering. Needs `pnpm --filter @realm/server build` first. Touches only scratch homes, kills only
 * what it started, and never pairs a real phone or dials a real relay.
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import * as pty from "node-pty";
import WebSocket from "ws";
import { REMOTE_RELAY_KEY } from "@realm/contracts";
import { startLocalRelay } from "@realm/relay/src/node";
import { finish, ok, sleep } from "./harness";
import { refuseRealHome, repoRoot } from "./lib/mobile-rig";
import { loopbackRpc } from "../src/remote/rpc-port";
import { TestPhone } from "../src/remote/test-phone";

const REALM_JS = join(repoRoot, "apps/server/dist/realm.js");
if (!existsSync(REALM_JS)) { console.error("build first: pnpm --filter @realm/server build"); process.exit(2); }

const evidence = process.argv[2] ?? mkdtempSync(join(tmpdir(), "realm-remote-evidence-"));
mkdirSync(evidence, { recursive: true });
const transcript: string[] = [];
const note = (line: string) => { transcript.push(line); console.log(line); };

const serverHome = mkdtempSync(join(tmpdir(), "realm-remote-server-"));
const clientHome = mkdtempSync(join(tmpdir(), "realm-remote-client-"));
const clientConfig = mkdtempSync(join(tmpdir(), "realm-remote-client-config-"));
const scratch = mkdtempSync(join(tmpdir(), "realm-remote-scratch-"));
for (const h of [serverHome, clientHome]) refuseRealHome(h);

const PORTS = { server: 8802, serverRemote: 9242, client: 8812, clientRemote: 9252, refused: 9262 };
const children: ChildProcess[] = [];

/** One `realm` run to completion, its exit code and both streams kept. */
function realm(env: NodeJS.ProcessEnv, args: string[], input?: string): { code: number; out: string; err: string } {
  const r = spawnSync(process.execPath, [REALM_JS, ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, input, encoding: "utf8", timeout: 60_000 });
  note(`$ realm ${args.map((a) => (/\s/.test(a) ? `'${a}'` : a)).join(" ")}\n${(r.stdout + r.stderr).trim()}\n[exit ${r.status}]`);
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

/** `realm serve` in the background, ready once `realm status` answers on its home. */
async function serve(home: string, port: number, args: string[]): Promise<ChildProcess> {
  const child = spawn(process.execPath, [REALM_JS, "serve", "--home", home, "--port", String(port), ...args], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, REALM_ENABLE_FAKE_AGENT: "1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const logPath = join(evidence, `serve-${port}.log`);
  const log = createWriteStream(logPath, { flags: "a" });
  child.stdout!.pipe(log); child.stderr!.pipe(log);
  for (let i = 0; i < 300; i++) {
    if (existsSync(join(home, "daemon.json")) && spawnSync(process.execPath, [REALM_JS, "status", "--home", home], { encoding: "utf8" }).status === 0) return child;
    if (child.exitCode !== null) throw new Error(`realm serve exited ${child.exitCode}; see ${logPath}`);
    await sleep(100);
  }
  throw new Error(`realm serve did not come up; see ${logPath}`);
}

const stop = (child: ChildProcess): Promise<void> => new Promise((done) => {
  if (child.exitCode !== null || child.signalCode !== null) return done();
  const hard = setTimeout(() => child.kill("SIGKILL"), 10_000);
  child.once("exit", () => { clearTimeout(hard); done(); });
  child.kill("SIGTERM");
});

/** A raw handshake, for the answers the CLI turns into words: the HTTP status, or the open socket. */
function handshake(url: string, protocols: string[], o: WebSocket.ClientOptions = {}): Promise<{ status: number | null; ws: WebSocket | null; error: string | null }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, protocols, o);
    ws.once("open", () => resolve({ status: 101, ws, error: null }));
    ws.once("unexpected-response", (_q, res) => { res.resume(); ws.terminate(); resolve({ status: res.statusCode ?? null, ws: null, error: null }); });
    ws.once("error", (e) => resolve({ status: null, ws: null, error: (e as NodeJS.ErrnoException).code ?? e.message }));
  });
}

const errorCode = (r: { out: string }): string | null => { try { return JSON.parse(r.out).error.code as string; } catch { return null; } };

let relay: Awaited<ReturnType<typeof startLocalRelay>> | null = null;
try {
  // A certificate for 127.0.0.1, made now: the server's, which the client trusts with --ca.
  const cert = join(scratch, "cert.pem"); const key = join(scratch, "key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", key, "-out", cert, "-days", "2",
    "-subj", "/CN=realm-live-server", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"], { stdio: "ignore" });

  note("\n== two machines: the server, and the client with a Realm of its own ==");
  let server = await serve(serverHome, PORTS.server, ["--listen", `127.0.0.1:${PORTS.serverRemote}`, "--tls-cert", cert, "--tls-key", key]);
  const client = await serve(clientHome, PORTS.client, ["--listen", `127.0.0.1:${PORTS.clientRemote}`]);
  const serverEnv = { REALM_HOME: serverHome };
  const clientEnv = { REALM_HOME: clientHome, XDG_CONFIG_HOME: clientConfig };
  ok("the server listens on loopback and, over TLS, for clients elsewhere", /listening for clients on other machines at wss:\/\/127\.0\.0\.1:9242/.test(realm(serverEnv, ["status"]).out));

  note("\n== an access token, made on the server ==");
  const made = realm(serverEnv, ["token", "create", "laptop", "--json"]);
  const token = JSON.parse(made.out).token as string;
  ok("a token is made once, on the server, and only its hash is kept", token.startsWith("rlm_") && !readFileSync(join(serverHome, "access-tokens.json"), "utf8").includes(token));
  ok("the token file is 0600", (statSync(join(serverHome, "access-tokens.json")).mode & 0o777) === 0o600);

  note("\n== the client saves the server and drives it ==");
  const added = realm(clientEnv, ["remote", "add", "server", `wss://127.0.0.1:${PORTS.serverRemote}`, "--ca", cert], `${token}\n`);
  ok("realm remote add dials before it saves, and reads the token from stdin", added.code === 0 && added.out.includes(serverHome));
  const remotes = join(clientConfig, "realm", "remotes.json");
  ok("the saved remote is 0600 and listing it shows no token", (statSync(remotes).mode & 0o777) === 0o600 && !realm(clientEnv, ["remote", "list", "--json"]).out.includes(token));
  ok("realm status with --server is the server's home; without it, the client's own", realm(clientEnv, ["--server", "server", "status"]).out.includes(serverHome) && realm(clientEnv, ["status"]).out.includes(clientHome));

  const repo = join(scratch, "app");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "app\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "init"], { cwd: repo });
  const run = realm(clientEnv, ["--server", "server", "run", repo, "--worktree", "remote-1", "--json", "--", "echo built on the server > out.txt; git branch --show-current"]);
  const started = JSON.parse(run.out) as { terminalId: string; path: string; branch: string };
  ok("realm run makes a worktree on the server and starts the command there", run.code === 0 && started.branch === "realm/remote-1");
  const waited = realm(clientEnv, ["--server", "server", "wait", started.terminalId, "--timeout", "30"]);
  ok("realm wait reports it exited 0", waited.code === 0 && waited.out.includes("exited 0"));
  ok("the work landed in the server's worktree", readFileSync(join(started.path, "out.txt"), "utf8") === "built on the server\n");
  ok("realm logs reads what it printed", realm(clientEnv, ["--server", "server", "logs", started.terminalId]).out.includes("realm/remote-1"));
  ok("realm ps lists it, and realm worktree list the worktree", realm(clientEnv, ["--server", "server", "ps"]).out.includes(started.terminalId)
    && realm(clientEnv, ["--server", "server", "worktree", "list", repo]).out.includes("realm/remote-1"));
  ok("realm kill closes it", realm(clientEnv, ["--server", "server", "kill", started.terminalId]).code === 0);
  ok("the client's own home ran nothing", JSON.parse(realm(clientEnv, ["ps", "--json"]).out).length === 0);

  note("\n== refusals ==");
  const url = `wss://127.0.0.1:${PORTS.serverRemote}`;
  const daemonToken = JSON.parse(readFileSync(join(serverHome, "daemon.json"), "utf8")).token as string;
  const noToken = realm(clientEnv, ["--server", url, "--ca", cert, "status", "--json"]);
  ok("no token: refused before dialling (exit 2)", noToken.code === 2 && errorCode(noToken) === "USAGE");
  const wrong = realm(clientEnv, ["--server", url, "--ca", cert, "--token", `rlm_${"x".repeat(43)}`, "status", "--json"]);
  ok("a wrong token: the server says 401 (exit 1)", wrong.code === 1 && errorCode(wrong) === "UNAUTHORIZED");
  const daemon = realm(clientEnv, ["--server", url, "--ca", cert, "--token", daemonToken, "status", "--json"]);
  ok("the server's own daemon token opens nothing remotely", errorCode(daemon) === "UNAUTHORIZED");
  const untrusted = realm(clientEnv, ["--server", url, "--token", token, "status", "--json"]);
  ok("a certificate the client does not trust: no token is sent", errorCode(untrusted) === "TLS_UNTRUSTED");
  const raw401 = await handshake(url, [], { ca: readFileSync(cert) });
  ok("a raw handshake with no token gets 401", raw401.status === 401, `status ${raw401.status}`);
  const browser = await handshake(url, [`realm.${token}`], { ca: readFileSync(cert), origin: "https://evil.example" });
  ok("a browser page holding the token gets 403", browser.status === 403, `status ${browser.status}`);
  const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address ?? "192.0.2.10";
  const plain = realm(clientEnv, ["--server", `ws://${lan}:${PORTS.serverRemote}`, "--token", token, "status", "--json"]);
  ok(`plain ws:// to ${lan} is refused by the client`, errorCode(plain) === "PLAINTEXT_REFUSED");
  const scratchHome = mkdtempSync(join(tmpdir(), "realm-remote-refused-"));
  const everywhere = realm({ REALM_HOME: scratchHome }, ["serve", "--listen", `0.0.0.0:${PORTS.refused}`, "--allow-plaintext", "--json"]);
  ok("serve --listen 0.0.0.0 without TLS is refused, flag or no flag", everywhere.code === 1 && errorCode(everywhere) === "LISTEN_REFUSED");
  const onLan = realm({ REALM_HOME: scratchHome }, ["serve", "--listen", `${lan}:${PORTS.refused}`, "--json"]);
  ok(`serve --listen ${lan} (private) without TLS is refused`, errorCode(onLan) === "LISTEN_REFUSED");
  ok("…and nothing was bound", spawnSync("lsof", ["-nP", `-iTCP:${PORTS.refused}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout.trim() === "" && !existsSync(join(scratchHome, "daemon.json")));

  // A connected client, then its token revoked under it.
  const held = await handshake(url, [`realm.${token}`], { ca: readFileSync(cert) });
  const dropped = new Promise<number>((res) => held.ws?.once("close", () => res(Date.now())));
  const revokedAt = Date.now();
  realm(serverEnv, ["token", "revoke", "laptop"]);
  const closedAt = await Promise.race([dropped, sleep(8_000).then(() => -1)]);
  ok("revoking a token closes the connection it held", closedAt > 0, `${closedAt - revokedAt} ms`);
  ok("…and the saved remote is refused from then on", errorCode(realm(clientEnv, ["--server", "server", "status", "--json"])) === "UNAUTHORIZED");

  // Ten wrong tokens from one address, then the right one: refused for a minute. On the client's own
  // listener, so the server above keeps its budget.
  const clientToken = JSON.parse(realm(clientEnv, ["token", "create", "self", "--json"]).out).token as string;
  const clientUrl = `ws://127.0.0.1:${PORTS.clientRemote}`;
  const statuses: (number | null)[] = [];
  for (let i = 0; i < 10; i++) statuses.push((await handshake(clientUrl, ["realm.rlm_wrong"])).status);
  const limited = await handshake(clientUrl, [`realm.${clientToken}`]);
  ok("ten refused handshakes, then the right token from the same address: 429", statuses.every((s) => s === 401) && limited.status === 429, `then ${limited.status}`);

  note("\n== realm pair on a server with no Realm window ==");
  relay = await startLocalRelay({ port: 0 });
  // Its relay, as a self-hoster would set it; the default is Realm's own, which a live check never dials.
  const mac = await loopbackRpc({ port: PORTS.server, token: daemonToken });
  await mac.call("settings.set", { key: REMOTE_RELAY_KEY, value: relay.url });
  mac.close();
  const term = pty.spawn(process.execPath, [REALM_JS, "pair", "--home", serverHome], {
    name: "xterm-256color", cols: 100, rows: 72, cwd: scratch, env: { PATH: process.env.PATH!, HOME: process.env.HOME!, TERM: "xterm-256color" },
  });
  let screen = "";
  const phone = new TestPhone();
  let paired: Promise<{ ok: boolean }> | null = null;
  let answered = false;
  const exit = new Promise<number>((res) => term.onExit(({ exitCode }) => res(exitCode)));
  term.onData((d) => {
    screen += d;
    const link = /https:\/\/realm\.computer\/pair#[A-Za-z0-9._-]+/.exec(screen)?.[0];
    if (link && !paired) paired = phone.pair(link, { name: "Live iPhone", model: "iPhone18,1" });
    if (!answered && /\[y\/N\]/.test(screen)) { answered = true; term.write("y\r"); }
  });
  const code = await Promise.race([exit, sleep(60_000).then(() => -1)]);
  writeFileSync(join(evidence, "pair-terminal.ansi"), screen);
  ok("realm pair printed a code and its link, asked, and paired on a yes", code === 0 && answered && (await paired!)?.ok === true, `exit ${code}`);
  ok("…keeping the identity's key in the home, 0600", (statSync(join(serverHome, "keys", "remote.key")).mode & 0o777) === 0o600);
  ok("realm phones lists it", realm(serverEnv, ["phones"]).out.includes("Live iPhone"));

  note("\n== the server restarts with nobody to hand it a key ==");
  await stop(server);
  server = await serve(serverHome, PORTS.server, ["--listen", `127.0.0.1:${PORTS.serverRemote}`, "--tls-cert", cert, "--tls-key", key]);
  const back = await phone.connect().catch((e: Error) => ({ macOnline: false, error: e.message }));
  ok("its phone reaches it again through the relay", back.macOnline === true);

  void client;
} catch (e) {
  ok("the run finished", false, e instanceof Error ? e.stack ?? e.message : String(e));
} finally {
  writeFileSync(join(evidence, "transcript.txt"), transcript.join("\n") + "\n");
  for (const c of children) await stop(c);
  await relay?.close();
  console.log(`\nevidence: ${evidence}\nhomes: ${serverHome} ${clientHome}`);
}
finish();
