/**
 * Keybindings, user commands, project scripts, project search and the execution sandbox, exercised
 * over the REAL WebSocket against a real `createApp`.
 *
 * Why a live script rather than more unit tests: every one of these features was assembled from a
 * contracts module, a service, an RPC handler and a renderer slice that were written separately, and
 * a unit test proves each piece in isolation. What nothing so far proves is that the *wire* agrees —
 * that `Methods` really parses what the handler really returns, that `app.ts` really constructed the
 * service the handler reads, and that a keymap file really lands on a real disk. Every failure this
 * has caught in the past was of exactly that shape.
 *
 * Run: `pnpm --filter @realm/server exec tsx scripts/live-overnight-check.ts`
 *
 * `REALM_HOME` is a scratch directory made here and the real one is never opened — booting a server
 * against `~/Realm` would write a keybindings.json into the user's actual home.
 */
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { WebSocket } from "ws";
import { tokenProtocol } from "../src/rpc/server";
import { createApp, defaultAdapters } from "../src/app";
import { ProfilesStore } from "../src/store/profiles";
import { SpacesStore } from "../src/store/spaces";
import { finish, ok } from "./harness";

const home = mkdtempSync(join(tmpdir(), "realm-overnight-check-"));

/** One call over the socket, in the shape `parseWireMessage` expects. */
function caller(ws: WebSocket) {
  let seq = 0;
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw)) as { id?: string; ok?: boolean; result?: unknown; error?: { code: string; message: string } };
    if (msg.id === undefined) return; // an event, not our answer
    const p = pending.get(msg.id); if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(`${msg.error?.code}: ${msg.error?.message}`));
  });
  return <T = unknown>(method: string, params: unknown): Promise<T> => {
    const id = `c${++seq}`;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
}

async function main(): Promise<never> {
  const token = "overnight-check-token";
  const app = await createApp({ home, port: 0, adapters: defaultAdapters(), token });
  console.log(`server up on :${app.port}, home ${home}\n`);

  const profile = new ProfilesStore(app.db).create({ name: "Overnight", icon: "home", color: "#7c6cff" });
  const space = new SpacesStore(app.db, home).create({ profileId: profile.id, name: "Work", icon: "home" });

  const ws = new WebSocket(`ws://127.0.0.1:${app.port}`, [tokenProtocol(token)]);
  await new Promise<void>((res, rej) => { ws.once("open", () => res()); ws.once("error", rej); });
  const call = caller(ws);

  /* ── keybindings ───────────────────────────────────────────────────────────────────────────── */
  console.log("=== keybindings ===");
  const kb = await call<{ path: string; rules: { key: string; command: string }[]; error: string | null }>("keybindings.get", {});
  ok("keybindings.get answers", Array.isArray(kb.rules) && kb.rules.length > 0, `${kb.rules.length} rules`);
  ok("seeds the file on first read", existsSync(kb.path), kb.path);
  ok("no parse error on a fresh file", kb.error === null, kb.error ?? "");
  ok("ships ⌘K for the palette", kb.rules.some((r) => r.key === "mod+k" && r.command === "palette.toggle"));
  ok("ships ⌘P / ⌘⇧P for the two searches",
    kb.rules.some((r) => r.key === "mod+p" && r.command === "palette.files")
    && kb.rules.some((r) => r.key === "mod+shift+p" && r.command === "palette.grep"));

  const written = await call<{ rules: unknown[] }>("keybindings.set", { rules: [{ key: "ctrl+alt+t", command: "terminal.new" }] });
  ok("keybindings.set round-trips", written.rules.length === 1);
  ok("…and reaches the actual file", readFileSync(kb.path, "utf8").includes("ctrl+alt+t"));
  const reset = await call<{ rules: unknown[] }>("keybindings.reset", {});
  ok("keybindings.reset restores the shipped table", reset.rules.length === kb.rules.length);

  /* ── user commands ─────────────────────────────────────────────────────────────────────────── */
  console.log("\n=== user commands ===");
  const spaceRow = new SpacesStore(app.db, home).get(space.id)!;
  const cmdDir = join(spaceRow.folderPath, "commands");
  mkdirSync(cmdDir, { recursive: true });
  writeFileSync(join(cmdDir, "review.md"),
    "---\ndescription: Review a file\nargument-hint: <path>\n---\nPlease review $1 and report on $ARGUMENTS.\n");
  const listed = await call<{ commands: { name: string; valid: boolean }[] }>("commands.list", { spaceId: space.id });
  ok("discovers a command file written to the space folder", listed.commands.some((c) => c.name === "review" && c.valid),
    listed.commands.map((c) => c.name).join(", "));
  const expanded = await call<{ text: string; missing: string[] }>("commands.expand",
    { spaceId: space.id, name: "review", args: "src/app.ts and be blunt" });
  ok("expands $1 and $ARGUMENTS", expanded.text.includes("src/app.ts") && expanded.text.includes("and be blunt"), expanded.text.trim());
  const short = await call<{ missing: string[] }>("commands.expand", { spaceId: space.id, name: "review", args: "" });
  ok("reports an unmatched placeholder rather than substituting nothing", short.missing.length > 0, short.missing.join(","));

  /* ── project scripts ───────────────────────────────────────────────────────────────────────── */
  console.log("\n=== project scripts ===");
  const saved = await call<{ id: string; name: string }>("scripts.save",
    { spaceId: space.id, script: { id: null, name: "Say hello", command: "echo hello-from-realm", cwd: null } });
  ok("scripts.save creates one", typeof saved.id === "string" && saved.id.length === 26, saved.id);
  const scripts = await call<{ scripts: { id: string }[] }>("scripts.list", { spaceId: space.id });
  ok("scripts.list returns it", scripts.scripts.some((s) => s.id === saved.id));
  const ran = await call<{ terminalId: string; cwd: string }>("scripts.run",
    { spaceId: space.id, commandId: `script.${saved.id}.run` });
  ok("scripts.run opens a real terminal", typeof ran.terminalId === "string" && ran.terminalId.length > 0, ran.cwd);
  await call("scripts.remove", { spaceId: space.id, id: saved.id });
  const after = await call<{ scripts: unknown[] }>("scripts.list", { spaceId: space.id });
  ok("scripts.remove removes it", after.scripts.length === 0);

  /* ── project search ────────────────────────────────────────────────────────────────────────── */
  console.log("\n=== project search ===");
  const repo = join(home, "repo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "alpha.ts"), "export const needle = 1;\n");
  writeFileSync(join(repo, "beta.md"), "nothing here\n");
  const files = await call<{ hits: { path: string }[]; source: string }>("project.files", { cwd: repo, query: "alpha" });
  ok("project.files finds an untracked new file", files.hits.some((h) => h.path === "alpha.ts"), `source=${files.source}`);
  const grep = await call<{ hits: { path: string; line: number }[]; source: string }>("project.grep", { cwd: repo, query: "needle" });
  ok("project.grep finds the line", grep.hits.some((h) => h.path === "alpha.ts" && h.line === 1), `source=${grep.source}`);
  const plain = await call<{ hits: unknown[] }>("project.grep", { cwd: repo, query: "n.edle" });
  ok("treats the query as text, not a regex", plain.hits.length === 0);
  const notRepo = join(home, "plain");
  mkdirSync(notRepo, { recursive: true });
  writeFileSync(join(notRepo, "x.txt"), "needle\n");
  const walked = await call<{ source: string }>("project.grep", { cwd: notRepo, query: "needle" });
  ok("says so when it fell back to a walk", walked.source === "walk", `source=${walked.source}`);

  /* ── execution sandbox ─────────────────────────────────────────────────────────────────────── */
  console.log("\n=== execution sandbox ===");
  const sb = await call<{ prefs: { posture: string }; inherited: boolean; available: boolean; summary: string }>(
    "sandbox.get", { spaceId: space.id });
  ok("ships OFF, so nothing changes for anyone who has not opted in", sb.prefs.posture === "off", sb.prefs.posture);
  ok("…and says the posture was inherited rather than chosen here", sb.inherited);
  ok("reports whether Seatbelt works on this Mac", typeof sb.available === "boolean", `available=${sb.available}`);
  const onPrefs = await call<{ prefs: { posture: string }; inherited: boolean; policy: { writableRoots: string[] } }>(
    "sandbox.set", { spaceId: space.id, prefs: { posture: "workspace-write", network: true } });
  ok("sandbox.set stores a per-space override", onPrefs.prefs.posture === "workspace-write" && !onPrefs.inherited);
  ok("a sandboxed space names its writable roots", onPrefs.policy.writableRoots.length > 0,
    `${onPrefs.policy.writableRoots.length} roots`);
  const cleared = await call<{ inherited: boolean; prefs: { posture: string } }>("sandbox.set", { spaceId: space.id, prefs: null });
  ok("clearing the override goes back to the default", cleared.inherited && cleared.prefs.posture === "off");

  ws.close();
  await app.close();
  rmSync(home, { recursive: true, force: true });
  return finish();
}

main().catch((e: unknown) => {
  console.error(e);
  rmSync(home, { recursive: true, force: true });
  process.exit(1);
});
