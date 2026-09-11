#!/usr/bin/env node
/**
 * Look at, or stop, the realm-server daemon on a home.
 *
 * For development, where a daemon that outlives the app is occasionally a daemon nobody meant to
 * leave running — an interrupted live check, a build swapped under it, an experiment with
 * REALM_DAEMON=1. Reads `daemon.json` and reports what is actually true rather than what the file
 * claims: a pid that is gone and a port that does not answer are both ordinary findings here.
 *
 *   node scripts/daemon.mjs status [home]
 *   node scripts/daemon.mjs stop   [home]
 *
 * `home` defaults to $REALM_HOME, then ~/Realm.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [, , cmd = "status", homeArg] = process.argv;
const home = homeArg ?? process.env.REALM_HOME ?? path.join(os.homedir(), "Realm");
const statePath = path.join(home, "daemon.json");

const read = () => {
  try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return null; }
};
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};
const probe = (port, token) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, [`realm.${token}`]);
  const done = (v) => { try { ws.close(); } catch {} resolve(v); };
  const timer = setTimeout(() => done(null), 2000);
  ws.addEventListener("open", () => ws.send(JSON.stringify({ id: "p", method: "system.info", params: {} })));
  ws.addEventListener("error", () => { clearTimeout(timer); done(null); });
  ws.addEventListener("message", (ev) => {
    clearTimeout(timer);
    try { const m = JSON.parse(ev.data); done(m.ok ? m.result : null); } catch { done(null); }
  });
});

const state = read();
if (!state) {
  console.log(`no daemon recorded at ${statePath}`);
  process.exit(0);
}

const running = alive(state.pid);
const info = running ? await probe(state.port, state.token) : null;
const ours = info && info.bootId === state.bootId;

if (cmd === "status") {
  console.log(`home     ${home}`);
  console.log(`pid      ${state.pid} ${running ? "alive" : "GONE"}`);
  console.log(`port     ${state.port} ${info ? "answering" : "silent"}${info && !ours ? " (someone else — bootId differs)" : ""}`);
  console.log(`state    ${state.state}`);
  console.log(`bundle   ${state.bundleId}`);
  console.log(`entry    ${state.entry}`);
  console.log(`started  ${new Date(state.startedAt).toISOString()}`);
  console.log(`verdict  ${ours ? "a live Realm daemon" : running ? "pid alive but not answering as ours" : "stale file"}`);
  process.exit(0);
}

if (cmd === "stop") {
  if (!running) {
    console.log(`pid ${state.pid} is already gone; clearing ${statePath}`);
    fs.rmSync(statePath, { force: true });
    fs.rmSync(path.join(home, "daemon.lock"), { force: true });
    process.exit(0);
  }
  if (!ours) {
    console.error(`pid ${state.pid} does not answer as the daemon this file describes — refusing to signal it`);
    process.exit(1);
  }
  process.kill(state.pid, "SIGTERM");
  for (let i = 0; i < 100; i++) {
    if (!alive(state.pid)) { console.log(`stopped pid ${state.pid}`); process.exit(0); }
    await new Promise((r) => setTimeout(r, 100));
  }
  console.error(`pid ${state.pid} did not exit within 10s`);
  process.exit(1);
}

console.error(`unknown command ${cmd} — expected status or stop`);
process.exit(1);
