/**
 * Live check of the settings-auth carry-forward (src/claude/settings-auth.ts) against the REAL
 * Agent SDK, on a machine whose login really lives in ~/.claude/settings.json.
 *
 * The claim no unit test can hold up, because it is about what the CLI does with an environment:
 * under `settingSources: []` the CLI never reads the settings file, so a machine authenticating
 * through its `apiKeyHelper` and `env` block boots `apiKeySource: none` and answers "Not logged in"
 * (note: as the RESULT TEXT of a `success` result, not as an error subtype) — and the carried env is
 * what puts the login back. Two stages: the SDK with the carried env (the claim in isolation), then
 * the real ClaudeAdapter with a real staged plugin (the shipping path, exactly as a skills session
 * runs). A credential that already exists in the environment or the settings `env` block would let
 * both stages pass without the helper ever running, so that machine SKIPs too — this check must
 * only ever pass for real.
 *
 * Read-only outside its own temp dirs.
 *
 *   pnpm --filter @realm/adapters exec tsx scripts/live-claude-auth-check.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAdapter } from "../src/claude/claude-adapter";
import { carrySettingsAuth } from "../src/claude/settings-auth";

let failures = 0;
const ok = (label: string, cond: boolean, detail = ""): void => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
};

const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() ? process.env.CLAUDE_CONFIG_DIR : join(homedir(), ".claude");
let helper = "";
let settingsEnv: Record<string, unknown> = {};
try {
  const settings = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8")) as { apiKeyHelper?: unknown; env?: unknown };
  if (typeof settings.apiKeyHelper === "string") helper = settings.apiKeyHelper.trim();
  if (settings.env && typeof settings.env === "object" && !Array.isArray(settings.env)) settingsEnv = settings.env as Record<string, unknown>;
} catch { /* no settings file: same skip as no helper */ }
if (!helper) {
  console.log(`SKIP: no apiKeyHelper in ${join(configDir, "settings.json")} — this machine cannot exercise the carry`);
  process.exit(0);
}
const preexisting = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"].find((k) => process.env[k] || typeof settingsEnv[k] === "string");
if (preexisting) {
  console.log(`SKIP: ${preexisting} is already present — every check below would pass without the helper ever minting`);
  process.exit(0);
}

// The helper command itself stays out of the output: a shell command from someone's settings can
// carry an inline credential, and this log ends up in terminals and CI captures.
console.log(`settings: ${join(configDir, "settings.json")} (apiKeyHelper configured)`);
const timer = setTimeout(() => { console.error("timeout after 240s"); process.exit(2); }, 240_000);

const carried = await carrySettingsAuth({ env: process.env as Record<string, string | undefined>, onLog: (l) => console.error("[carry]", l) });
ok("the carry minted a key through the real helper", Boolean(carried.ANTHROPIC_API_KEY), `carried: ${Object.keys(carried).join(", ") || "(nothing)"}`);

// Stage 1 — the claim in isolation: the SDK under the exact isolation a skills session runs with,
// the carried env threaded the way the adapter threads it. No `plugins`: this stage is about
// settings, not the library.
let apiKeySource = "(no init seen)";
let reply = "(no result seen)";
for await (const m of query({
  prompt: "Reply with exactly: OK",
  options: { cwd: tmpdir(), maxTurns: 1, allowedTools: [], settingSources: [], env: { ...process.env, ...carried } },
})) {
  if (m.type === "system" && m.subtype === "init") apiKeySource = m.apiKeySource;
  if (m.type === "result") { reply = m.subtype === "success" ? m.result : `(${m.subtype})`; break; }
}
// `none` is the broken boot this fix exists for; the helper-minted key arrives as ANTHROPIC_API_KEY.
ok("init reports a real credential under settingSources: []", apiKeySource !== "none" && apiKeySource !== "(no init seen)", `apiKeySource=${apiKeySource}`);
ok('the model answered "OK" — not "Not logged in"', reply.trim() === "OK", JSON.stringify(reply).slice(0, 200));

// Stage 2 — the shipping path: the real adapter, skills set to a real staged plugin (the same shape
// SkillsService stages: .claude-plugin/plugin.json beside a skills/ root), the real CLI, one real
// turn. This is the code a Realm session actually runs, carry included.
const plugin = mkdtempSync(join(tmpdir(), "realm-auth-plugin-"));
mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "realm", version: "0.0.1", description: "Skills managed by Realm." }, null, 2));
const root = join(plugin, "skills");
mkdirSync(join(root, "auth-probe"), { recursive: true });
writeFileSync(join(root, "auth-probe", "SKILL.md"), "---\nname: auth-probe\ndescription: A Realm probe skill. Never invoke it.\n---\n\nprobe\n");

const handle = new ClaudeAdapter().start({ cwd: tmpdir(), mcpServers: [], skills: { pluginPath: plugin, root } });
await handle.send({ text: "Reply with exactly: OK", attachments: [] });
let answer = "";
let sessionError = "";
for await (const e of handle.events) {
  if (e.type === "assistant_text") answer = (e.payload as { text: string }).text;
  if (e.type === "error") { sessionError = String((e.payload as { message?: unknown }).message ?? ""); break; }
  if (e.type === "status" && (e.payload as { status?: string }).status === "idle") break;
}
await handle.dispose();
ok('the real adapter, skills enabled, answered "OK" through the carried login', answer.trim() === "OK", JSON.stringify(sessionError || answer).slice(0, 200));

clearTimeout(timer);
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
