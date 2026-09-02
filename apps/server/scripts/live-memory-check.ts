/**
 * Live check of W3's memory channel against the REAL agent CLIs.
 *
 * Two protocol claims here cannot be held up by unit tests, because both are about what a third-party
 * binary does with a string:
 *
 *   1. Codex actually applies `thread/start` `developerInstructions` — the field its own protocol doc
 *      lists as *unverified* — rather than accepting and ignoring it.
 *   2. A Claude session running with `settingSources: []` (the skills-injection mode) really does see
 *      the content Realm re-injects through `systemPrompt.append` — the W1 carry-forward that stops
 *      enabling a skill from silently costing the user their `~/.claude/CLAUDE.md`.
 *
 * So this script builds a scratch Realm home and a scratch Claude user dir with marker tokens in them,
 * derives the context with the REAL `MemoryService` (same code the server runs), starts each REAL
 * adapter with it, and asks the model to repeat the tokens back. It costs one short model turn per
 * agent. It writes nothing outside its own temp dirs — in particular nothing under ~/.claude, ~/.codex,
 * ~/.cursor or ~/.agents — and it never reads the user's real memory files: the markers are scratch.
 *
 *   pnpm --filter @realm/server exec tsx scripts/live-memory-check.ts
 *
 * Exits non-zero if any check fails. Requires `claude` and `codex` installed and logged in; a CLI that
 * is missing is reported as a failed section, not a silent pass.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter, CodexAdapter, type AgentHandle } from "@realm/adapters";
import { openDatabase } from "../src/db/database";
import { SettingsStore } from "../src/store/settings";
import { SkillsService } from "../src/skills/service";
import { MemoryService } from "../src/memory/service";
import type { Environment } from "@realm/contracts";
import { finish, ok } from "./harness";

const SPACE = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const nonce = Math.random().toString(36).slice(2, 8).toUpperCase();
/** In the scratch user CLAUDE.md — must survive settingSources: [] via re-injection. */
const USER_TOKEN = `USRMEM${nonce}`;
/** In the Realm memory doc — must reach both agents. */
const REALM_TOKEN = `RLMMEM${nonce}`;
const TURN_TIMEOUT_MS = 180_000;


/** Runs one turn and returns everything the agent said, plus the init payload. */
async function oneTurn(handle: AgentHandle, prompt: string): Promise<{ text: string; init: Record<string, unknown> | null }> {
  let text = "";
  let init: Record<string, unknown> | null = null;
  const done = (async () => {
    for await (const e of handle.events) {
      if (e.type === "init") init = e.payload as unknown as Record<string, unknown>;
      if (e.type === "assistant_text") text += `${e.payload.text}\n`;
      if (e.type === "error") throw new Error(e.payload.message);
      if (e.type === "usage" || (e.type === "status" && e.payload.status === "ended")) break;
    }
  })();
  await handle.send({ text: prompt, attachments: [] });
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([done, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("turn timed out")), TURN_TIMEOUT_MS); })]);
  clearTimeout(timer);
  return { text, init };
}

function scratchRealm() {
  const home = mkdtempSync(join(tmpdir(), "realm-memory-live-"));
  const claudeDir = join(home, "claude-home");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, "CLAUDE.md"), `The value of PROBE_A is ${USER_TOKEN}.\n`);
  const spaceDir = join(home, "space");
  mkdirSync(spaceDir, { recursive: true });
  const settings = new SettingsStore(openDatabase(join(home, "realm.db")));
  const environments = {
    ensurePrimary: (spaceId: string): Environment =>
      ({ id: "env", spaceId, path: spaceDir, branch: null, kind: "primary", portBlockStart: null, createdAt: 0, updatedAt: 0 }),
  };
  const memory = new MemoryService({ home, settings, environments, claudeDir });
  memory.set(SPACE, `The value of PROBE_B is ${REALM_TOKEN}.`);
  // A staged skills library, exactly as the server would hand it over: its presence is what puts the
  // Claude session into settingSources: [] — the mode the re-injection exists for.
  const skills = new SkillsService({ home, settings, bundledDir: null });
  mkdirSync(join(skills.root, "realm-probe"), { recursive: true });
  writeFileSync(join(skills.root, "realm-probe", "SKILL.md"), "---\nname: realm-probe\ndescription: A Realm probe skill. Never invoke it.\n---\n\nprobe\n");
  const injection = skills.injectionFor(SPACE, "claude");
  if (!injection) throw new Error("SkillsService staged nothing — the check cannot prove anything");
  return { home, memory, injection };
}

const PROMPT = "Without using any tools: reply with the exact values of PROBE_A and PROBE_B from your context, or the word ABSENT for any you cannot find.";

async function checkClaude(memory: MemoryService, injection: { pluginPath: string; root: string }, cwd: string) {
  console.log("\n=== claude ===");
  const systemContext = memory.systemContextFor({ spaceId: SPACE, kind: "claude", cwd, skillsInjected: true });
  ok("MemoryService built a context carrying both tokens", !!systemContext?.includes(USER_TOKEN) && !!systemContext?.includes(REALM_TOKEN));
  const adapter = new ClaudeAdapter();
  const handle = adapter.start({ cwd, mcpServers: [], skills: injection, systemContext, permissionMode: "default" });
  try {
    const { text } = await oneTurn(handle, PROMPT);
    ok("the re-injected CLAUDE.md content reaches the session despite settingSources: []", text.includes(USER_TOKEN));
    ok("the Realm memory document reaches the session", text.includes(REALM_TOKEN));
  } finally { await handle.dispose(); }

  // The control: same isolated session, no systemContext. If the tokens showed up here the assertions
  // above would prove nothing about the channel.
  const control = adapter.start({ cwd, mcpServers: [], skills: injection, permissionMode: "default" });
  try {
    const { text } = await oneTurn(control, PROMPT);
    ok("without the re-injection the tokens are absent (so the channel above is real)", !text.includes(USER_TOKEN) && !text.includes(REALM_TOKEN));
  } finally { await control.dispose(); }
}

async function checkCodex(memory: MemoryService, cwd: string) {
  console.log("\n=== codex ===");
  const systemContext = memory.systemContextFor({ spaceId: SPACE, kind: "codex", cwd, skillsInjected: false });
  ok("MemoryService built a codex context carrying the Realm token and never CLAUDE.md", !!systemContext?.includes(REALM_TOKEN) && !systemContext?.includes(USER_TOKEN));
  const adapter = new CodexAdapter();
  const handle = adapter.start({ cwd, mcpServers: [], systemContext, permissionMode: "default" });
  try {
    const { text, init } = await oneTurn(handle, PROMPT);
    ok("developerInstructions actually lands in the thread (PROBE_B came back)", text.includes(REALM_TOKEN));
    const sources = init?.instructionSources;
    ok("thread/start reported instructionSources and the adapter surfaced it on init", Array.isArray(sources), Array.isArray(sources) ? `${sources.length} file(s)` : String(sources));
  } finally { await handle.dispose(); }
}

async function main() {
  const { home, memory, injection } = scratchRealm();
  const cwd = mkdtempSync(join(tmpdir(), "realm-memory-cwd-"));
  console.log(`scratch home: ${home}`);
  try {
    for (const [label, fn] of [
      ["claude", () => checkClaude(memory, injection, cwd)],
      ["codex", () => checkCodex(memory, cwd)],
    ] as const) {
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
