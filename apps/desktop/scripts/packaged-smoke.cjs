#!/usr/bin/env node
/**
 * Smoke-proof for the PACKAGED app (`pnpm dist:dir` first). Launches the .app binary the way Finder
 * effectively does — a stripped env whose PATH is launchd's `/usr/bin:/bin`, plus a scratch
 * REALM_HOME — and proves over the server's RPC socket that the packaged runtime is whole:
 *
 *   1. the app boots and realm-server comes up (ELECTRON_RUN_AS_NODE spawn; `system.info` answers
 *      with the scratch home),
 *   2. `agents.probe` finds the claude CLI — i.e. main's login-shell PATH resolution worked, since
 *      the spawn env alone could never find it,
 *   3. bundled skills shipped: `skills.list` reports the repo's `skills/` ids, installed into the
 *      scratch home on first boot,
 *   4. a terminal opens, its login shell resolves `claude` too, and the pty round-trips output.
 *
 * Usage: node apps/desktop/scripts/packaged-smoke.cjs [path/to/Realm.app]
 *   REALM_SMOKE_PORT (default 8790) must be free. Needs Node >= 22 (global WebSocket).
 * Exits 0 on pass, 1 on fail, and always kills the app it launched (only that one).
 */
const { spawn } = require("node:child_process");
const { existsSync, mkdtempSync, rmSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const os = require("node:os");

const PORT = Number(process.env.REALM_SMOKE_PORT ?? 8790);
const appDir = process.argv[2] ?? join(__dirname, "..", "release", "mac-arm64", "Realm.app");
const bin = join(appDir, "Contents", "MacOS", "Realm");
if (!existsSync(bin)) { console.error(`no packaged binary at ${bin} — run \`pnpm dist:dir\` first`); process.exit(1); }

const home = mkdtempSync(join(os.tmpdir(), "realm-smoke-"));
// What launchd hands a Finder-launched app: HOME/USER/TMPDIR/SHELL, and a PATH with no Homebrew, no
// node, no agent CLIs. Everything the app finds beyond this, it found itself.
const env = {
  HOME: process.env.HOME, USER: process.env.USER, LOGNAME: process.env.LOGNAME,
  TMPDIR: process.env.TMPDIR, SHELL: process.env.SHELL || "/bin/zsh",
  PATH: "/usr/bin:/bin", REALM_HOME: home, REALM_PORT: String(PORT),
};

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child;
async function connect() {
  const deadline = Date.now() + 40_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error("server socket never opened");
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("connect failed")); });
      return ws;
    } catch { await sleep(500); }
  }
}

function rpcClient(ws) {
  let n = 0;
  const pending = new Map();
  const dataListeners = new Set();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
      msg.ok ? res(msg.result) : rej(new Error(`${msg.error.code}: ${msg.error.message}`));
    } else if (msg.event === "terminal.data") {
      for (const l of dataListeners) l(msg.payload);
    }
  };
  return {
    call: (method, params = {}) => new Promise((res, rej) => {
      const id = `smoke-${++n}`;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (pending.delete(id)) rej(new Error(`${method} timed out`)); }, 20_000);
    }),
    onTerminalData: (l) => dataListeners.add(l),
  };
}

async function main() {
  console.log(`launching ${bin}\n  REALM_HOME=${home} PATH=${env.PATH} port=${PORT}`);
  child = spawn(bin, [], { env, stdio: ["ignore", "inherit", "inherit"] });
  child.on("exit", (code) => { if (!done) { console.error(`app exited early (code ${code})`); process.exit(1); } });

  const ws = await connect();
  const rpc = rpcClient(ws);

  // 1. boot + server up
  const info = await rpc.call("system.info");
  check("server up: system.info answers", info.realmHome === home, JSON.stringify(info));

  // 2. agent CLIs found via login-shell PATH (spawn env had /usr/bin:/bin only)
  const probe = await rpc.call("agents.probe", { force: true });
  console.log("  agents.probe:", JSON.stringify(probe));
  const claude = probe.find((p) => p.kind === "claude");
  check("agents.probe finds claude", Boolean(claude?.available), claude ? `version=${claude.version}` : "no claude row");

  // 3. bundled skills present (need a space to list against)
  let spaces = await rpc.call("spaces.list");
  if (!spaces.length) {
    const profiles = await rpc.call("profiles.list");
    const profileId = profiles[0]?.id ?? (await rpc.call("profiles.create", { name: "Smoke" })).id;
    await rpc.call("spaces.create", { profileId, name: "Smoke" });
    spaces = await rpc.call("spaces.list");
  }
  const spaceId = spaces[0].id;
  const skills = await rpc.call("skills.list", { spaceId });
  const ids = skills.skills.map((s) => s.id);
  const bundledOnDisk = readdirSync(join(home, "skills"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  const wantSkills = ["browsing", "mac"];
  check("bundled skills installed", wantSkills.every((w) => ids.includes(w) && bundledOnDisk.includes(w)),
    `rpc=[${ids}] disk=[${bundledOnDisk}]`);

  // 4. terminal: login shell + working PATH inside the pty
  const term = await rpc.call("terminals.create", { spaceId, cwd: home, cols: 100, rows: 30 });
  let out = "";
  rpc.onTerminalData((p) => { if (p.terminalId === term.terminalId) out += p.data; });
  await sleep(2000); // let the shell finish starting
  // The typed line shows `$?` unexpanded, so SMOKE_RC_0 only ever appears as real output.
  await rpc.call("terminals.write", { terminalId: term.terminalId, data: 'command -v claude; echo "SMOKE_RC_$?"\r' });
  const tDeadline = Date.now() + 10_000;
  while (Date.now() < tDeadline && !/SMOKE_RC_\d/.test(out)) await sleep(250);
  const rcOk = out.includes("SMOKE_RC_0");
  // Strip OSC titles + CSI sequences so the reported path is the path, not the shell's decorations.
  const plain = out.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  const claudePath = (plain.match(/^([^\r\n]*\/claude)\s*$/m) ?? [])[1];
  check("terminal login shell resolves claude", rcOk, claudePath ? `command -v claude -> ${claudePath}` : `output tail: ${JSON.stringify(out.slice(-200))}`);
  await rpc.call("terminals.close", { terminalId: term.terminalId }).catch(() => {});

  ws.close();
}

let done = false;
main()
  .then(() => { done = true; })
  .catch((e) => { done = true; console.error("smoke error:", e.message); results.push({ name: "smoke ran to completion", ok: false }); })
  .finally(() => {
    try { child?.kill("SIGTERM"); } catch {}
    setTimeout(() => {
      try { child?.kill("SIGKILL"); } catch {}
      rmSync(home, { recursive: true, force: true });
      const failed = results.filter((r) => !r.ok);
      console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
      process.exit(failed.length || !results.length ? 1 : 0);
    }, 1500);
  });
