/**
 * Live check for user-level skill discovery (run with: node apps/server/scripts/user-skill-roots-live.mjs)
 *
 * The bug this covers lived in one argument at one call site, and every unit test passed through it:
 * the suite hands `SkillsService` a scratch directory that plays both roles, so `~/.codex/skills`
 * read from Realm's home instead of the machine's looks identical to a test and finds nothing at all
 * in production. `main.ts` is where the two are told apart, and `main.ts` is what no test constructs.
 *
 * So this boots the BUILT server the way Electron does and asks it over RPC. `HOME` and `CODEX_HOME`
 * point at fixtures, which is both what makes the run hermetic and what makes it honest — the real
 * `~/.codex` is never read, and a pass cannot come from the operator's own skills.
 *
 * Ports: env-overridable. Touches only a scratch dir; kills only the process it started.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-skill-roots-live-"));
let server = null;

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

const skill = (dir, name) => {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: Fixture skill for the live check.\n---\n\nBody.\n`);
};

function rpc(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", () => rej(new Error("RPC unavailable"))); });
  ws.addEventListener("message", (m) => {
    const row = JSON.parse(m.data);
    if (row.id !== undefined) pending.get(row.id)?.(row);
  });
  return {
    ready,
    call: (method, params) => new Promise((res, rej) => {
      const i = String(++id);
      pending.set(i, (row) => (row.ok === false || row.error ? rej(new Error(`${method}: ${row.error?.message ?? "failed"}`)) : res(row.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => ws.close(),
  };
}

/** One server on one fixture home, torn down before the next: `userHome` is read once at boot. */
async function boot(env) {
  const home = fs.mkdtempSync(path.join(scratch, "realm-home-"));
  server = spawn(process.execPath, [path.join(repoRoot, "apps/server/dist/main.js")], {
    env: { ...process.env, ...env, REALM_HOME: home, REALM_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", () => {});
  const port = await new Promise((ok, bad) => {
    const timer = setTimeout(() => bad(new Error("server did not report ready")), 20000);
    let buffer = "";
    server.once("exit", (code) => bad(new Error(`server exited (${code})`)));
    server.stdout.on("data", (bytes) => {
      buffer += bytes;
      for (let end; (end = buffer.indexOf("\n")) >= 0; ) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try { const row = JSON.parse(line); if (row.type === "ready") { clearTimeout(timer); ok(row.port); } } catch { /* other startup output is not the handshake */ }
      }
    });
  });
  const c = rpc(port);
  await c.ready;
  const profile = await c.call("profiles.create", { name: "Live" });
  const space = await c.call("spaces.create", { profileId: profile.id, name: "Work" });
  const ids = (await c.call("skills.list", { spaceId: space.id })).skills.map((s) => s.id);
  c.close();
  server.kill();
  await new Promise((ok) => server.once("exit", ok));
  server = null;
  return ids;
}

async function main() {
  const userHome = path.join(scratch, "user-home");
  const movedCodex = path.join(scratch, "moved-codex");
  skill(path.join(userHome, ".codex", "skills"), "fixture-codex");
  skill(path.join(userHome, ".claude", "skills"), "fixture-claude");
  skill(path.join(movedCodex, "skills"), "fixture-moved");

  const plain = await boot({ HOME: userHome, CODEX_HOME: "" });
  check("a user's Codex skills reach the library", plain.includes("codex.fixture-codex"), { ids: plain });
  check("the other agent directories come with them", plain.includes("claude.fixture-claude"), { ids: plain });

  const moved = await boot({ HOME: userHome, CODEX_HOME: movedCodex });
  check("CODEX_HOME moves where Codex's skills are read from", moved.includes("codex.fixture-moved"), { ids: moved });
  check("and the default location is not read as well", !moved.includes("codex.fixture-codex"), { ids: moved });
  check("a relocated Codex does not disturb the other directories", moved.includes("claude.fixture-claude"), { ids: moved });
}

main()
  .catch((e) => { console.log("FAIL", e.message); process.exitCode = 1; })
  .finally(() => {
    server?.kill();
    fs.rmSync(scratch, { recursive: true, force: true });
  });
