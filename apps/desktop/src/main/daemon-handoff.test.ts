/**
 * The launcher against real processes: fake realm-servers on a scratch home, in each of the states an
 * update left behind on 2026-10-26 — busy and running a Realm.app that was replaced under it, with a
 * shutdown that hangs; stuck; draining with nobody waiting; and left over with no state file at all.
 * Each must end with the old one gone and a new one adopted.
 *
 * The glue is index.ts's (`handOff`, `replaceServer`, `clearStrayServers`), rebuilt here from the same
 * modules, because index.ts is Electron's to load. Everything below it is the real thing: the state
 * file, the probe over a WebSocket, `ps` and `lsof`, SIGTERM, SIGKILL.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { tempDir } from "@realm/test-utils";
import { bundleIdOf, type DaemonState } from "@realm/contracts";
import { callDaemon, ensureDaemon, probeDaemon, type HandoffResult, type HandoffWhy } from "./daemon";
import { forgetDeadServer, readDaemonState } from "./daemon-state";
import { isAlive, realProcessOps, runsServer, stopServerProcess, stopStrayServers } from "./daemon-stop";
import { decideHandoff } from "./handoff-policy";

/**
 * A realm-server stand-in: writes `daemon.json`, holds `realm.db` open, answers `system.info` and
 * `daemon.info` over a hand-rolled WebSocket, and does what FAKE_MODE says with SIGTERM.
 */
const FAKE_SERVER = String.raw`
const http = require("node:http"), crypto = require("node:crypto"), fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const home = process.env.REALM_HOME, entry = process.argv[1], mode = process.env.FAKE_MODE || "normal";
const bootId = crypto.randomUUID(), token = crypto.randomBytes(16).toString("hex");
const db = fs.openSync(path.join(home, "realm.db"), "a");
if (process.env.FAKE_AGENT === "1") {
  const agent = cp.spawn("sleep", ["600"], { stdio: "ignore" });
  fs.writeFileSync(path.join(home, "agent-" + process.pid), String(agent.pid));
}
const stateFile = path.join(home, "daemon.json");
const clear = () => { try { if (JSON.parse(fs.readFileSync(stateFile, "utf8")).pid === process.pid) fs.rmSync(stateFile); } catch {} };
const frame = (text) => { const b = Buffer.from(text); return Buffer.concat([Buffer.from(b.length < 126 ? [0x81, b.length] : [0x81, 126, b.length >> 8, b.length & 255]), b]); };
const server = http.createServer();
server.on("upgrade", (req, socket) => {
  if (!String(req.headers["sec-websocket-protocol"] || "").split(",").map((s) => s.trim()).includes("realm." + token)) { socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n"); return; }
  const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\nSec-WebSocket-Protocol: realm." + token + "\r\n\r\n");
  let buf = Buffer.alloc(0);
  socket.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 6) {
      const op = buf[0] & 15; let len = buf[1] & 127, off = 2;
      if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4), body = Buffer.from(buf.subarray(off + 4, off + 4 + len)).map((b, i) => b ^ mask[i % 4]);
      buf = buf.subarray(off + 4 + len);
      if (op === 8) { socket.end(); return; }
      if (op !== 1) continue;
      const m = JSON.parse(body.toString());
      const result = m.method === "system.info" ? { bootId, protocol: 1 }
        : m.method === "daemon.info" ? { working: Number(process.env.FAKE_WORKING || 0), activeRuns: 0 } : null;
      socket.write(frame(JSON.stringify(result ? { id: m.id, ok: true, result } : { id: m.id, ok: false, error: { code: "NO", message: "no such method" } })));
    }
  });
  socket.on("error", () => {});
});
server.listen(0, "127.0.0.1", () => {
  if (process.env.FAKE_NO_STATE === "1") return;
  const st = fs.statSync(entry);
  const state = { version: 1, pid: process.pid, bootId, port: server.address().port, token, home, protocol: 1,
    bundleId: st.size + ":" + Math.trunc(st.mtimeMs), entry, startedAt: Date.now(), state: mode === "draining" ? "draining" : "running" };
  fs.writeFileSync(stateFile + ".tmp", JSON.stringify(state));
  fs.renameSync(stateFile + ".tmp", stateFile);
});
process.on("SIGTERM", () => { if (mode === "ignore-term") return; clear(); process.exit(0); });
void db;
`;

const started: number[] = [];
afterEach(() => {
  for (const pid of started.splice(0)) {
    for (const sig of ["SIGCONT", "SIGKILL"] as const) { try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch { /* gone */ } } }
  }
});

/** A home and a Realm.app with a server bundle in it, under a scratch folder. */
function scratch() {
  const root = tempDir("realm-handoff-");
  const home = join(root, "home");
  const entry = join(root, "Realm.app", "Contents", "Resources", "server", "dist", "main.js");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(entry, ".."), { recursive: true });
  writeFileSync(entry, FAKE_SERVER);
  const start = (env: Record<string, string> = {}): number => {
    // As `spawnDaemon` does: detached, so it leads a process group of its own.
    const child = spawn(process.execPath, [entry], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", REALM_HOME: home, ...env }, stdio: "ignore", detached: true });
    child.unref();
    started.push(child.pid!);
    return child.pid!;
  };
  return { home, entry, start };
}

async function until<T>(read: () => T | null | undefined | false, ms = 5_000): Promise<T> {
  const deadline = performance.now() + ms;
  for (;;) {
    const v = read();
    if (v) return v;
    if (performance.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** The launcher as index.ts wires it, on a clock five times fast so the patience it is testing is
 *  seconds rather than tens of them. */
function launch(s: ReturnType<typeof scratch>, asked: string[] = []) {
  const t0 = performance.now();
  const replace = async (state: DaemonState, _why?: "unresponsive" | "draining"): Promise<void> => {
    if (!runsServer(state.pid, state.entry, realProcessOps)) { forgetDeadServer(state); return; }
    await stopServerProcess(state.pid, realProcessOps, 500);
  };
  return ensureDaemon({
    home: s.home,
    ourBundleId: bundleIdOf(statSync(s.entry)),
    readState: readDaemonState,
    probe: (port, token) => probeDaemon({ port, token, timeoutMs: 300 }),
    spawn: () => { s.start(); },
    onHandoff: async (running: DaemonState, why: HandoffWhy): Promise<HandoffResult> => {
      const info = await callDaemon(running, "daemon.info", {}).catch(() => null) as { working: number; activeRuns: number } | null;
      const decision = decideHandoff({ why, work: info });
      if (decision.kind !== "restart") { asked.push(decision.kind); return { kind: "adopt", stale: "bundle" }; }
      await replace(running);
      return { kind: "replaced" };
    },
    replace,
    bundleOnDisk: (entry) => { try { return bundleIdOf(statSync(entry)); } catch { return "missing"; } },
    clearStrays: async () => { await stopStrayServers(s.home, [], realProcessOps); },
    now: () => (performance.now() - t0) * 5,
  });
}

describe("the launcher after an update, against real processes", () => {
  it("replaces a busy old server running a replaced bundle whose shutdown hangs — and the agent it started", async () => {
    const s = scratch();
    const old = s.start({ FAKE_MODE: "ignore-term", FAKE_WORKING: "1", FAKE_AGENT: "1" });
    await until(() => readDaemonState(s.home)?.pid === old);
    const agent = Number(await until(() => { try { return readFileSync(join(s.home, `agent-${old}`), "utf8"); } catch { return null; } }));
    // ShipIt: the bundle at the same path is a different build now.
    appendFileSync(s.entry, "\n// 2.5.1\n");
    const asked: string[] = [];
    const handle = await launch(s, asked);
    // Nobody was asked — the dialog before any window is what made the update look like it never
    // reopened. The old server is gone for certain, SIGTERM ignored or not, with its agent.
    expect(asked).toEqual([]);
    expect(isAlive(old, realProcessOps)).toBe(false);
    await until(() => !isAlive(agent, realProcessOps));
    expect(handle.state.pid).not.toBe(old);
    expect(handle.state.bundleId).toBe(bundleIdOf(statSync(s.entry)));
    expect(await probeDaemon({ port: handle.port, token: handle.token })).not.toBeNull();
  }, 20_000);

  it("replaces an old server that has stopped answering instead of failing to start", async () => {
    const s = scratch();
    const old = s.start();
    await until(() => readDaemonState(s.home)?.pid === old);
    process.kill(old, "SIGSTOP");
    const handle = await launch(s);
    expect(isAlive(old, realProcessOps)).toBe(false);
    expect(handle.state.pid).not.toBe(old);
    expect(await probeDaemon({ port: handle.port, token: handle.token })).not.toBeNull();
  }, 20_000);

  it("replaces a server still draining once the budget is spent", async () => {
    const s = scratch();
    const old = s.start({ FAKE_MODE: "draining" });
    await until(() => readDaemonState(s.home)?.state === "draining");
    const handle = await launch(s);
    expect(isAlive(old, realProcessOps)).toBe(false);
    expect(handle.state.state).toBe("running");
  }, 20_000);

  it("stops a server left over with no state file before starting the home's one", async () => {
    // An older Realm's hand-off SIGTERMed it, its shutdown cleared daemon.json and hung: nothing names
    // it, and its lock is released, so ours would run beside it on the same database.
    const s = scratch();
    const stray = s.start({ FAKE_NO_STATE: "1" });
    await until(() => runsServer(stray, "/server/dist/main.js", realProcessOps) && realProcessOps.holding(join(s.home, "realm.db")).includes(stray));
    const handle = await launch(s);
    expect(isAlive(stray, realProcessOps)).toBe(false);
    expect(handle.state.pid).not.toBe(stray);
  }, 20_000);
});
