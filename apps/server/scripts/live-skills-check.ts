/**
 * Live check of Realm's skills injection against the REAL agent CLIs.
 *
 * The whole of W1 rests on two protocol claims that no unit test can hold up, because both are about what
 * a third-party binary does with a directory:
 *
 *   1. Claude Code loads a skill from `plugins: [{ type:'local', path }]`, and `settingSources: []`
 *      keeps the user's own installed skills out of the same session.
 *   2. Codex's app-server accepts `skills/extraRoots/set` and then reports the skill in `skills/list`.
 *
 * So this script builds a scratch library with the real `SkillsService` — same staging code the server
 * runs, symlinks and all — and asks each CLI what it sees. It writes nothing outside its own temp dirs,
 * and in particular nothing under ~/.claude, ~/.codex, ~/.cursor or ~/.agents.
 *
 *   pnpm --filter @realm/server exec tsx scripts/live-skills-check.ts
 *
 * Exits non-zero if any check fails. Requires `claude` and `codex` to be installed and logged in; a CLI
 * that is missing is reported as a skipped section, not a pass.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { CodexConnection } from "@realm/adapters";
import { openDatabase } from "../src/db/database";
import { SettingsStore } from "../src/store/settings";
import { SkillsService } from "../src/skills/service";
import { finish, ok } from "./harness";

const ENABLED = "realm-probe-enabled";
const DISABLED = "realm-probe-disabled";
const SPACE = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
/** Skills of the user's own that the isolation check looks for. Absence of ALL of them is the assertion. */
const USER_SKILL_HINTS = ["caikins", "frontend-design", "quiet-saas", "refactoring-ui", "skill-creator"];


function library() {
  const home = mkdtempSync(join(tmpdir(), "realm-skills-live-"));
  const settings = new SettingsStore(openDatabase(join(home, "realm.db")));
  const service = new SkillsService({ home, settings, bundledDir: null });
  for (const id of [ENABLED, DISABLED]) {
    mkdirSync(join(service.root, id), { recursive: true });
    writeFileSync(join(service.root, id, "SKILL.md"), `---\nname: ${id}\ndescription: A Realm probe skill (${id}). Never invoke it.\n---\n\nprobe\n`);
  }
  // The disabled one is the control: it exists on disk and must NOT reach either agent.
  service.setEnabled(SPACE, DISABLED, false);
  const injection = service.injectionFor(SPACE, "claude");
  if (!injection) throw new Error("SkillsService staged nothing — the check cannot prove anything");
  return { home, injection };
}

/** Runs one query far enough to read its command list, then abandons it. No turn is ever sent. */
async function claudeCommands(options: Record<string, unknown>, cwd: string): Promise<string[]> {
  const input = (async function* () {
    yield { type: "user" as const, message: { role: "user" as const, content: "probe" }, parent_tool_use_id: null, session_id: "" };
  })();
  const q = query({ prompt: input as never, options: { cwd, ...options } as never });
  try {
    return (await q.supportedCommands()).map((c: { name: string }) => c.name);
  } finally {
    await q.interrupt().catch(() => { /* the probe never started a turn; there may be nothing to interrupt */ });
  }
}

async function checkClaude(pluginPath: string, cwd: string) {
  console.log("\n=== claude ===");
  const injected = await claudeCommands(
    { settingSources: [], plugins: [{ type: "local", path: pluginPath, skipMcpDiscovery: true }] },
    cwd,
  );
  const realm = injected.filter((n) => n.includes("realm-probe"));
  ok("the enabled skill is loaded from the staged plugin", realm.includes(`realm:${ENABLED}`), realm.join(", ") || "(none)");
  ok("the disabled skill is not", !realm.includes(`realm:${DISABLED}`), realm.join(", ") || "(none)");
  const leaked = injected.filter((n) => USER_SKILL_HINTS.some((h) => n.includes(h)));
  ok("settingSources: [] keeps the user's own skills out", leaked.length === 0, leaked.slice(0, 5).join(", ") || "(none)");

  // The control: the same session without the two options is the behaviour Realm had before W1.
  const bare = await claudeCommands({}, cwd);
  ok("without the plugin, Realm's library is absent", !bare.some((n) => n.includes("realm-probe")));
  ok("without settingSources: [], the user's own skills are present (so the isolation above is real)",
    bare.some((n) => USER_SKILL_HINTS.some((h) => n.includes(h))), `${bare.length} commands vs ${injected.length} injected`);
}

async function checkCodex(root: string, cwd: string) {
  console.log("\n=== codex ===");
  const conn = await CodexConnection.open({ bin: process.env.REALM_CODEX_BIN ?? "codex", cwd });
  try {
    let supported = true;
    try { await conn.request("skills/extraRoots/set", { extraRoots: [root] }, 15_000); }
    catch (e) { supported = false; ok("skills/extraRoots/set is available on this codex build", false, e instanceof Error ? e.message : String(e)); }
    if (!supported) return;
    ok("skills/extraRoots/set is available on this codex build", true);
    const listed = await conn.request<{ data: { skills: { name: string; path: string; scope: string }[] }[] }>(
      "skills/list", { cwds: [cwd], forceReload: true }, 20_000);
    const names = listed.data.flatMap((d) => d.skills.map((s) => s.name));
    const probes = names.filter((n) => n.includes("realm-probe"));
    ok("the enabled skill appears in skills/list", probes.includes(ENABLED), probes.join(", ") || "(none)");
    ok("the disabled skill does not", !probes.includes(DISABLED), probes.join(", ") || "(none)");
    // Codex resolves the symlink, which is what lets the staged root point back at the user's library
    // instead of being a copy that goes stale the moment they edit a skill.
    const path = listed.data.flatMap((d) => d.skills).find((s) => s.name === ENABLED)?.path ?? "";
    ok("the staged symlink resolves back to the library", path.includes("skills/" + ENABLED), path || "(not listed)");
  } finally {
    await conn.dispose();
  }
}

async function main() {
  const { home, injection } = library();
  const cwd = mkdtempSync(join(tmpdir(), "realm-skills-cwd-"));
  console.log(`library: ${home}\nstaged:  ${injection.pluginPath}`);
  try {
    for (const [label, fn] of [["claude", () => checkClaude(injection.pluginPath, cwd)], ["codex", () => checkCodex(injection.root, cwd)]] as const) {
      try { await fn(); }
      catch (e) { console.log(`\n=== ${label} ===`); ok(`${label} reachable`, false, e instanceof Error ? e.message : String(e)); }
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
  finish();
}

main().catch((e) => { console.error("driver crashed:", e); process.exit(2); });
