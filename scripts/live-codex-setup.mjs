import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Explicit local check: isolated Realm data, existing Codex sources, no model turns or auth flows.
const home = mkdtempSync(join(tmpdir(), "RealmSetupLive"));
const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const paths = ["config.toml", "AGENTS.md", "hooks.json"].map(name => join(codexHome, name));
const digests = () => paths.map(path => existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null);
const before = digests();
const child = spawn(process.execPath, [resolve("apps/server/dist/main.js")], { env: { ...process.env, REALM_HOME: home, REALM_PORT: "0" }, stdio: ["ignore", "pipe", "ignore"] });
let ws;
const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
let evidence = { head, status: "blocked", summary: "Candidate server did not complete discovery." };
const deadline = (promise, ms) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Deadline exceeded")), ms); })]).finally(() => clearTimeout(timer));
};
try {
  const port = await deadline(new Promise((ok, bad) => {
    let buffer = "";
    child.once("error", () => bad(new Error("Candidate server unavailable")));
    child.once("exit", () => bad(new Error("Candidate server exited")));
    child.stdout.on("data", bytes => {
      buffer += bytes;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try { const row = JSON.parse(line); if (row.type === "ready") ok(row.port); } catch { /* Other startup output is not evidence. */ }
      }
    });
  }), 15000);
  ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await deadline(new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error("RPC unavailable")); }), 5000);
  const reply = await deadline(new Promise((ok, bad) => {
    ws.onmessage = event => { const row = JSON.parse(event.data); if (row.id === "scan") row.ok ? ok(row.result) : bad(new Error("Discovery RPC failed")); };
    ws.send(JSON.stringify({ id: "scan", method: "codexSetup.scan", params: { cwd: process.cwd() } }));
  }), 25000);
  const unchanged = JSON.stringify(before) === JSON.stringify(digests());
  evidence = {
    head, status: unchanged && reply.runtime.state === "available" ? "passed" : "blocked",
    summary: "Read-only candidate RPC discovery; no connection or model execution claims.",
    unchangedSources: unchanged, components: reply.runtime.components, fingerprint: reply.fingerprint,
    skills: reply.runtime.skills.length, hooks: reply.runtime.hooks.length, connections: reply.runtime.connections.length,
  };
} catch (error) { evidence.summary = error.message; }
finally {
  ws?.close();
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    try { await deadline(new Promise(ok => child.once("exit", ok)), 5000); }
    catch { child.kill("SIGKILL"); await new Promise(ok => child.once("exit", ok)); }
  }
  rmSync(home, { recursive: true, force: true });
  mkdirSync(".validation", { recursive: true });
  writeFileSync(".validation/codex-setup-live.json", JSON.stringify(evidence, null, 2));
}
console.log(JSON.stringify(evidence));
process.exitCode = evidence.status === "passed" ? 0 : 2;
