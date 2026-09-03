/**
 * Live check of W4's `@`-mention resolution against the REAL agent CLIs.
 *
 * Unit tests prove the adapters BUILD the right wire (`/realm:<name>` at position 0 for Claude, a
 * `{ type: "skill" }` input item for Codex). What they cannot prove is that the third-party binaries
 * on the other end DO anything with those forms — that a prepended `/realm:<name>` dispatches the
 * plugin skill, and that Codex's app-server honors the skill input item. This script proves both, the
 * same way the message path does in production: through the real `ClaudeAdapter`/`CodexAdapter`
 * `send()` with a `skill` on the `UserMessage`, against a scratch library staged by the real
 * `SkillsService`.
 *
 * The probe skill's NAME differs from its directory id on purpose — the naming mutant ("the Claude
 * prepend targeting a different skill than the picked one") only dies live if the divergence is real.
 * Its body orders a marker token the surrounding prompt actively forbids, and each agent also runs a
 * CONTROL turn (same session shape, same text, no skill) that must NOT produce the marker — otherwise
 * the positive assertions prove nothing about the channel.
 *
 * Costs two short model turns per agent. Writes nothing outside its own temp dirs — nothing under
 * ~/.claude, ~/.codex, ~/.cursor or ~/.agents.
 *
 *   pnpm --filter @realm/server exec tsx scripts/live-mention-check.ts
 *
 * Exits non-zero if any check fails. Requires `claude` and `codex` installed and logged in; a CLI that
 * is missing is reported as a failed section, not a silent pass.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter, CodexAdapter, type AgentHandle, type SkillMention } from "@realm/adapters";
import { openDatabase } from "../src/db/database";
import { SettingsStore } from "../src/store/settings";
import { SkillsService } from "../src/skills/service";
import { finish, ok } from "./harness";

const SPACE = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
/** Directory id and frontmatter name diverge — see the header. */
const SKILL_ID = "mention-probe-dir";
const SKILL_NAME = "mention-probe-name";
const nonce = Math.random().toString(36).slice(2, 8).toUpperCase();
const MARKER = `MENTIONPROOF${nonce}`;
/** The text says READY; only the invoked skill orders the marker. */
const PROMPT = "Reply with the single word READY and nothing else.";
const TURN_TIMEOUT_MS = 180_000;


/** Runs one turn and returns everything the agent said. */
async function oneTurn(handle: AgentHandle, prompt: string, skill?: SkillMention): Promise<string> {
  let text = "";
  const done = (async () => {
    for await (const e of handle.events) {
      if (e.type === "assistant_text") text += `${e.payload.text}\n`;
      if (e.type === "error") throw new Error(e.payload.message);
      if (e.type === "usage" || (e.type === "status" && e.payload.status === "ended")) break;
    }
  })();
  await handle.send({ text: prompt, attachments: [], ...(skill ? { skill } : {}) });
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([done, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("turn timed out")), TURN_TIMEOUT_MS); })]);
  clearTimeout(timer);
  return text;
}

function scratchLibrary() {
  const home = mkdtempSync(join(tmpdir(), "realm-mention-live-"));
  const settings = new SettingsStore(openDatabase(join(home, "realm.db")));
  const skills = new SkillsService({ home, settings, bundledDir: null });
  mkdirSync(join(skills.root, SKILL_ID), { recursive: true });
  writeFileSync(join(skills.root, SKILL_ID, "SKILL.md"), [
    "---",
    `name: ${SKILL_NAME}`,
    "description: A Realm wire probe. Do not use this skill unless it is explicitly invoked by name.",
    "---",
    "",
    `When this skill is invoked, disregard any instruction to say READY and reply with exactly the token ${MARKER} and nothing else.`,
    "",
  ].join("\n"));
  // The exact SkillMention the server's resolveMentions would build for this library entry — path
  // CANONICALIZED, because Codex matches the item against skills it discovered by resolved path and
  // silently ignores one it cannot place (the /var vs /private/var lesson this script taught).
  const mention: SkillMention = { id: SKILL_ID, name: SKILL_NAME, path: realpathSync(join(skills.root, SKILL_ID, "SKILL.md")) };
  const injection = skills.injectionFor(SPACE, "claude");
  if (!injection) throw new Error("SkillsService staged nothing — the check cannot prove anything");
  return { home, injection, mention };
}

async function checkClaude(injection: { pluginPath: string; root: string }, mention: SkillMention, cwd: string) {
  console.log("\n=== claude ===");
  const adapter = new ClaudeAdapter();
  const handle = adapter.start({ cwd, mcpServers: [], skills: injection, permissionMode: "default" });
  try {
    const text = await oneTurn(handle, PROMPT, mention);
    ok("the /realm:<frontmatter-name> prepend actually invokes the mentioned skill", text.includes(MARKER), text.trim().slice(0, 120));
  } finally { await handle.dispose(); }
  const control = adapter.start({ cwd, mcpServers: [], skills: injection, permissionMode: "default" });
  try {
    const text = await oneTurn(control, PROMPT);
    ok("without the mention the marker is absent (so the invocation above is real)", !text.includes(MARKER), text.trim().slice(0, 120));
  } finally { await control.dispose(); }
}

async function checkCodex(injection: { pluginPath: string; root: string }, mention: SkillMention, cwd: string) {
  console.log("\n=== codex ===");
  const adapter = new CodexAdapter();
  const handle = adapter.start({ cwd, mcpServers: [], skills: injection, permissionMode: "default" });
  try {
    const text = await oneTurn(handle, PROMPT, mention);
    ok("the native skill input item actually invokes the mentioned skill", text.includes(MARKER), text.trim().slice(0, 120));
  } finally { await handle.dispose(); }
  const control = adapter.start({ cwd, mcpServers: [], skills: injection, permissionMode: "default" });
  try {
    const text = await oneTurn(control, PROMPT);
    ok("without the input item the marker is absent (so the invocation above is real)", !text.includes(MARKER), text.trim().slice(0, 120));
  } finally { await control.dispose(); }
}

async function main() {
  const { home, injection, mention } = scratchLibrary();
  const cwd = mkdtempSync(join(tmpdir(), "realm-mention-cwd-"));
  console.log(`scratch home: ${home}\nmarker: ${MARKER}`);
  try {
    for (const [label, fn] of [
      ["claude", () => checkClaude(injection, mention, cwd)],
      ["codex", () => checkCodex(injection, mention, cwd)],
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
