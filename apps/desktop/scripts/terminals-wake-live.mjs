/**
 * Live check: a restored terminal's shell starts when it is first used, not at boot
 * (run with: pnpm --filter @realm/server build && node apps/desktop/scripts/terminals-wake-live.mjs)
 *
 * Boots the BUILT server (no window) on a scratch REALM_HOME, opens three terminals, and counts the
 * real shells under the server and on their ttys — the login shell and whatever its prompt forks.
 * Stops the server, boots it again on the same home, and counts again: nothing until one is read,
 * then exactly that one. Prints the resource report's terminal parts both times, from real `ps` and
 * `footprint` readings.
 *
 * Ports: LIVE_SERVER_PORT (8795). Touches only a scratch dir under LIVE_SCRATCH_ROOT. Bills nothing:
 * no session is sent a message.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PORT = Number(process.env.LIVE_SERVER_PORT ?? 8795);
const root = process.env.LIVE_SCRATCH_ROOT ?? path.join(repoRoot, "..", ".verify", "oct28", "r-live");
fs.mkdirSync(root, { recursive: true });
const scratch = fs.mkdtempSync(path.join(root, "realm-terminals-wake-live-"));
const home = path.join(scratch, "home");
const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@45.0.0/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, cond, detail) => { if (!cond) process.exitCode = 1; console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`); };
const seen = [];
let server = null;

async function boot() {
  server = spawn(electronBin, [path.join(repoRoot, "apps/server/dist/main.js")], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", REALM_HOME: home, REALM_PORT: String(PORT), REALM_ENABLE_FAKE_AGENT: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  server.stdout.on("data", (b) => { out += b; });
  server.stderr.on("data", () => {});
  for (let i = 0; i < 150 && !out.includes('"ready"'); i++) await sleep(100);
  if (!out.includes('"ready"')) throw new Error(`server did not come up: ${out.slice(0, 400)}`);
  seen.push(server.pid);
  const token = await daemonToken(home);
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, tokenProtocols(token));
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  let n = 0;
  const pending = new Map();
  ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.id !== undefined) pending.get(msg.id)?.(msg); });
  const call = (method, params) => new Promise((res, rej) => {
    const id = String(++n);
    pending.set(id, (msg) => (msg.ok === false || msg.error ? rej(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : res(msg.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { pid: server.pid, call, close: () => ws.close() };
}

/** Every process on the server's terminals: its children, and whatever else sits on their ttys. */
function shells(serverPid) {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,tty=,command="], { encoding: "utf8" }).trim().split("\n")
    .map((l) => { const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l); return m && { pid: +m[1], ppid: +m[2], tty: m[3], command: m[4] }; }).filter(Boolean);
  const leaders = rows.filter((r) => r.ppid === serverPid && /zsh|bash|fish|\bsh\b/.test(r.command));
  const ttys = new Set(leaders.map((r) => r.tty).filter((t) => t && t !== "??"));
  return { leaders: leaders.length, onTtys: rows.filter((r) => ttys.has(r.tty)).length };
}

async function stop(s) {
  try { await s.call("daemon.stop", {}); } catch { /* going anyway */ }
  s.close();
  for (let i = 0; i < 50; i++) { try { process.kill(s.pid, 0); } catch { return; } await sleep(100); }
  try { process.kill(s.pid, "SIGKILL"); } catch { /* gone */ }
}

const terminalParts = (r) => r.parts.filter((p) => p.category === "terminals").map((p) => ({ label: p.label, processes: p.processes, footprintMB: Math.round((p.footprintBytes ?? 0) / 1024 ** 2) }));

async function main() {
  let s = await boot();
  const profile = (await s.call("profiles.list", {}))[0];
  const space = await s.call("spaces.create", { profileId: profile.id, name: "Live" });
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await s.call("terminals.create", { spaceId: space.id })).terminalId);
  await sleep(4000); // let each login shell finish starting, prompt helpers and all
  const before = shells(s.pid);
  console.log(`INFO first boot: ${JSON.stringify(before)}`);
  check("three terminals opened are three running shells", before.leaders === 3, before);
  const r1 = await s.call("resources.snapshot", { fresh: true });
  console.log(`INFO report (first boot): realm ${Math.round((r1.realm.footprintBytes ?? 0) / 1024 ** 2)} MB in ${r1.realm.processes} processes; terminals ${JSON.stringify(terminalParts(r1))}; pressure ${r1.machine.pressure}; swap ${JSON.stringify(r1.machine.swap)}`);
  check("the report counts each terminal with what is on its tty", terminalParts(r1).length === 3 && terminalParts(r1).reduce((n, p) => n + p.processes, 0) === before.onTtys, { parts: terminalParts(r1), onTtys: before.onTtys });
  await stop(s);

  s = await boot();
  await sleep(3000);
  const asleep = shells(s.pid);
  console.log(`INFO second boot, nothing opened: ${JSON.stringify(asleep)}`);
  check("a server booted on the same home starts no shell for terminals nobody has opened", asleep.leaders === 0 && asleep.onTtys === 0, asleep);
  const listed = await s.call("terminals.list", { spaceId: space.id });
  check("all three are still there, restorable", listed.length === 3 && listed.every((t) => t.running), listed.map((t) => t.running));
  const read = await s.call("terminals.read", { terminalId: ids[0], cursor: null });
  await sleep(3000);
  const woke = shells(s.pid);
  console.log(`INFO after reading one: ${JSON.stringify(woke)}`);
  check("reading one starts that one, and only that one", read.running && woke.leaders === 1, woke);
  const r2 = await s.call("resources.snapshot", { fresh: true });
  console.log(`INFO report (second boot): terminals ${JSON.stringify(terminalParts(r2))}`);
  await stop(s);
}

async function teardown() {
  server?.kill("SIGKILL");
  await stopDaemons(home, seen);
  fs.rmSync(scratch, { recursive: true, force: true });
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
