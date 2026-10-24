/**
 * The remote runtime on Linux, live (pnpm --filter @realm/server exec tsx scripts/remote-runtime-linux-live.ts [evidence-dir])
 *
 * A Debian container with Node 22 stands in for a Linux server: this checkout mounted read-only, the
 * BUILT `realm` linked onto its PATH, and `realm serve --listen 0.0.0.0:9272` with TLS — every address
 * of the container, published to this Mac's loopback only. From this Mac, the built `realm` drives it
 * over `wss://` with a token made inside it: a worktree, a command, its exit and its Linux output.
 *
 * Then a phone pairs with that headless Linux server: `realm pair` runs in the container under a real
 * pseudo-terminal, a relay on this Mac's loopback carries the handshake (the container reaches it as
 * host.docker.internal; the stand-in phone, on this Mac, dials the same relay at 127.0.0.1), the yes is
 * typed at the prompt, and the server is restarted with nobody to hand it a key to show the phone
 * still reaches it. Last, `realm service install` writes its systemd unit there, and systemd's own
 * `systemd-analyze verify` checks it.
 *
 * Needs Docker running, the node:22-bookworm-slim image, and `pnpm --filter @realm/server build`.
 * Makes and removes one container; the fake agent only; no real phone, no deployed relay.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pty from "node-pty";
import { REMOTE_RELAY_KEY } from "@realm/contracts";
import { encodeLink, parseLink } from "@realm/remote";
import { startLocalRelay } from "@realm/relay/src/node";
import { finish, ok, sleep } from "./harness";
import { repoRoot } from "./lib/mobile-rig";
import { connect } from "../src/ctl/client";
import { TestPhone } from "../src/remote/test-phone";

const REALM_JS = join(repoRoot, "apps/server/dist/realm.js");
if (!existsSync(REALM_JS)) { console.error("build first: pnpm --filter @realm/server build"); process.exit(2); }
const IMAGE = "node:22-bookworm-slim";
const NAME = "realm-linux-live";
const PORT = 9272;
const evidence = process.argv[2] ?? mkdtempSync(join(tmpdir(), "realm-linux-evidence-"));
mkdirSync(evidence, { recursive: true });
const certs = mkdtempSync(join(tmpdir(), "realm-linux-certs-"));
const transcript: string[] = [];
const note = (line: string) => { transcript.push(line); console.log(line); };

const docker = (args: string[], input?: string) => {
  const r = spawnSync("docker", args, { encoding: "utf8", input, timeout: 300_000 });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
};
/** A shell command in the container, as root with the image's PATH. */
const inside = (cmd: string) => {
  const r = docker(["exec", NAME, "sh", "-c", cmd]);
  note(`linux# ${cmd}\n${(r.out + r.err).trim()}\n[exit ${r.code}]`);
  return r;
};
/** This Mac's `realm`, aimed at the Linux server. */
const realm = (args: string[], o: { token?: string; ca?: boolean } = {}) => {
  const full = ["--server", `wss://127.0.0.1:${PORT}`, ...(o.ca === false ? [] : ["--ca", join(certs, "cert.pem")]), ...(o.token ? ["--token", o.token] : []), ...args];
  const r = spawnSync(process.execPath, [REALM_JS, ...full], { encoding: "utf8", timeout: 120_000, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  note(`mac$ realm ${full.map((a) => (a.startsWith("rlm_") ? "rlm_…" : a)).join(" ")}\n${(r.stdout + r.stderr).trim()}\n[exit ${r.status}]`);
  return { code: r.status ?? -1, out: r.stdout };
};
const errorCode = (r: { out: string }): string | null => { try { return JSON.parse(r.out).error.code as string; } catch { return null; } };
const startServer = () => docker(["exec", "-d", "-e", "REALM_ENABLE_FAKE_AGENT=1", NAME, "sh", "-c",
  `realm serve --home /root/Realm --listen 0.0.0.0:${PORT} --tls-cert /certs/cert.pem --tls-key /certs/key.pem >> /root/serve.log 2>&1`]);
async function untilUp(token?: string): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    const r = token
      ? spawnSync(process.execPath, [REALM_JS, "--server", `wss://127.0.0.1:${PORT}`, "--ca", join(certs, "cert.pem"), "--token", token, "status"], { encoding: "utf8" })
      : spawnSync("docker", ["exec", NAME, "realm", "status", "--home", "/root/Realm"], { encoding: "utf8" });
    if (r.status === 0) return true;
    await sleep(200);
  }
  return false;
}

let relay: Awaited<ReturnType<typeof startLocalRelay>> | null = null;
try {
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", join(certs, "key.pem"), "-out", join(certs, "cert.pem"),
    "-days", "2", "-subj", "/CN=realm-linux-live", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"], { stdio: "ignore" });
  execFileSync("chmod", ["644", join(certs, "key.pem")]); // read by root in the container through a read-only mount
  docker(["rm", "-f", NAME]);
  const made = docker(["run", "-d", "--name", NAME, "-v", `${repoRoot}:/realm:ro`, "-v", `${certs}:/certs:ro`, "-p", `127.0.0.1:${PORT}:${PORT}`, IMAGE, "sleep", "3600"]);
  if (made.code !== 0) throw new Error(`docker run failed: ${made.err}`);
  inside("apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq --no-install-recommends git ca-certificates procps systemd >/dev/null 2>&1; git --version; ln -sf /realm/apps/server/bin/realm /usr/local/bin/realm; uname -sm; node --version");

  note("\n== a headless Linux server, listening on every address over TLS ==");
  const refused = inside(`realm serve --home /root/Refused --listen 0.0.0.0:${PORT + 1} --json`);
  ok("on Linux too, every address without TLS is refused", refused.code === 1 && refused.out.includes("LISTEN_REFUSED"));
  startServer();
  ok("realm serve comes up in the container", await untilUp());
  const token = JSON.parse(inside("realm token create mac --home /root/Realm --json").out).token as string;
  ok("an access token is made inside it", token?.startsWith("rlm_"));
  ok("this Mac reaches it at the published port, over TLS, with the token", await untilUp(token));

  note("\n== driving it from this Mac ==");
  const status = realm(["status", "--json"], { token });
  const info = JSON.parse(status.out) as { realmHome: string; machineName: string; remoteUrl: string };
  ok("realm status is the Linux server's", info.realmHome === "/root/Realm" && info.remoteUrl === `wss://0.0.0.0:${PORT}`, `${info.machineName} ${info.realmHome}`);
  inside("mkdir -p /root/app && cd /root/app && git init -q -b main && echo app > README.md && git add . && git -c user.email=t@e -c user.name=t commit -qm init");
  const run = realm(["run", "/root/app", "--worktree", "linux-1", "--json", "--", "uname -sm > out.txt; cat out.txt"], { token });
  const started = JSON.parse(run.out) as { terminalId: string; path: string; branch: string };
  ok("realm run makes a worktree on the Linux server", run.code === 0 && started.branch === "realm/linux-1" && started.path.startsWith("/root/Realm/"));
  ok("realm wait sees it exit 0", realm(["wait", started.terminalId, "--timeout", "60"], { token }).code === 0);
  ok("realm logs reads Linux's answer", /Linux (aarch64|x86_64)/.test(realm(["logs", started.terminalId], { token }).out));
  ok("the file is in the Linux worktree", inside(`cat ${started.path}/out.txt`).out.startsWith("Linux"));
  ok("no token, a wrong token, an untrusted certificate: refused", errorCode(realm(["status", "--json"])) === "USAGE"
    && errorCode(realm(["status", "--json"], { token: `rlm_${"z".repeat(43)}` })) === "UNAUTHORIZED"
    && errorCode(realm(["status", "--json"], { token, ca: false })) === "TLS_UNTRUSTED");

  note("\n== pairing a phone with the headless Linux server ==");
  relay = await startLocalRelay({ port: 0 });
  const relayPort = new URL(relay.url).port;
  const c = await connect({ kind: "url", url: `wss://127.0.0.1:${PORT}`, token, ca: readFileSync(join(certs, "cert.pem"), "utf8"), allowPlaintext: false });
  await c.call("settings.set", { key: REMOTE_RELAY_KEY, value: `ws://host.docker.internal:${relayPort}` });
  c.close();
  const term = pty.spawn("docker", ["exec", "-it", NAME, "realm", "pair", "--home", "/root/Realm"], { name: "xterm-256color", cols: 100, rows: 72, env: { PATH: process.env.PATH!, HOME: process.env.HOME! } });
  let screen = "";
  const phone = new TestPhone();
  let paired: Promise<{ ok: boolean }> | null = null;
  let answered = false;
  const exit = new Promise<number>((res) => term.onExit(({ exitCode }) => res(exitCode)));
  term.onData((d) => {
    screen += d;
    // Only a whole line: the terminal hands its bytes over in pieces, and half a link is no link.
    const link = /(https:\/\/realm\.computer\/pair#[A-Za-z0-9._-]+)\r?\n/.exec(screen)?.[1];
    // The container reaches the relay as host.docker.internal; the stand-in phone, on this Mac, dials
    // the very same relay at 127.0.0.1.
    if (link && !paired) paired = phone.pair(encodeLink({ ...parseLink(link), relay: relay!.url }), { name: "Linux iPhone", model: "iPhone18,1" });
    if (!answered && /\[y\/N\]/.test(screen)) { answered = true; term.write("y\r"); }
  });
  const code = await Promise.race([exit, sleep(90_000).then(() => -1)]);
  writeFileSync(join(evidence, "linux-pair-terminal.ansi"), screen);
  ok("realm pair on Linux drew the code, asked, and paired on a yes", code === 0 && answered && (await paired!)?.ok === true, `exit ${code}`);
  ok("…with a key of its own, 0600, in the home", inside("stat -c '%a %n' /root/Realm/keys/remote.key").out.startsWith("600 "));
  ok("realm phones, from this Mac, lists it", realm(["phones"], { token }).out.includes("Linux iPhone"));
  inside("pkill -TERM -f 'realm.js serve' ; sleep 2; pgrep -f 'realm.js serve' || echo stopped");
  startServer();
  ok("the server comes back with nobody to hand it a key", await untilUp(token));
  const back = await phone.connect().catch((e: Error) => ({ macOnline: false, error: e.message }));
  ok("…and the phone reaches it again through the relay", back.macOnline === true);

  note("\n== realm service install, checked by systemd ==");
  // No systemd runs in the container, so the unit is written and enabling it fails; systemd-analyze
  // still judges the file the way systemd would load it.
  const install = inside(`USER=root realm service install --home /root/Realm --listen 0.0.0.0:${PORT} --tls-cert /certs/cert.pem --tls-key /certs/key.pem`);
  const unit = inside("cat /root/.config/systemd/user/realm.service");
  writeFileSync(join(evidence, "linux-realm.service"), unit.out);
  ok("it writes a unit that runs this very node on this very realm.js", unit.out.includes(`ExecStart="/usr/local/bin/node" "/realm/apps/server/dist/realm.js" "serve" "--home" "/root/Realm" "--listen" "0.0.0.0:${PORT}"`), install.out);
  const verify = inside("systemd-analyze verify /root/.config/systemd/user/realm.service && echo VERIFIED");
  ok("systemd-analyze verify accepts it", verify.out.includes("VERIFIED"));
  writeFileSync(join(evidence, "linux-serve.log"), inside("cat /root/serve.log").out);
} catch (e) {
  ok("the run finished", false, e instanceof Error ? e.stack ?? e.message : String(e));
} finally {
  writeFileSync(join(evidence, "linux-transcript.txt"), transcript.join("\n") + "\n");
  docker(["rm", "-f", NAME]);
  await relay?.close();
  console.log(`\nevidence: ${evidence}`);
}
finish();
