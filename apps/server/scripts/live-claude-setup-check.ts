/**
 * Live check of the claim `claude.ownSetup` rests on, against the REAL `claude`.
 *
 * With the setting on, the Claude adapter hands a session Realm's library as a plugin and leaves
 * `settingSources` unset, where it otherwise passes `settingSources: []`. Everything the setting
 * promises is what a third-party binary does with that one difference, which no unit test can hold up:
 *
 *   1. `settingSources: []` with the plugin: Realm's skill is listed, none of the person's MCP servers
 *      is there, and the CLI loads no `CLAUDE.md`.
 *   2. The plugin alone: Realm's skill is still listed, the person's MCP servers of all three scopes
 *      (user and local in `.claude.json`, the project's `.mcp.json`) are connected, and the CLI loads
 *      the `CLAUDE.md` files itself, which is why Realm stops carrying them in.
 *
 * So this script builds a scratch config folder and a scratch project that set up all three scopes,
 * each server a stdio MCP server it writes itself, stages a scratch library with the real
 * `SkillsService`, and asks the CLI what it sees under each start. No turn is sent: the prompt stream
 * never speaks and every answer is a control request, so it needs no account and costs nothing.
 *
 * The CLI is given the scratch folders as `HOME` and `CLAUDE_CONFIG_DIR`, so nothing of this Mac's own
 * setup is read, and the script writes nothing outside its own temp folder. That folder has to sit
 * OUTSIDE the home folder, because Claude Code reads `.claude/CLAUDE.md` from every folder above the
 * working one. Symlinks are resolved before that is judged, since the CLI works in the folder a path
 * leads to: where `TMPDIR` leads into the home folder the script uses `/tmp` instead, and where that
 * does too it refuses to run.
 *
 *   pnpm --filter @realm/server exec tsx scripts/live-claude-setup-check.ts
 *
 * Exits non-zero if any check fails.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { query, type McpServerStatus, type Options, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { openDatabase } from "../src/db/database";
import { SettingsStore } from "../src/store/settings";
import { SkillsService } from "../src/skills/service";
import { finish, ok, sleep } from "./harness";

const SPACE = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SKILL = "realm-probe-setup";
/** Stands in for the gateway entry Realm passes every session in its start options. */
const GATEWAY = "realm-probe-gateway";
/** The person's own servers, one for each scope Claude Code keeps them in. */
const OWN = { user: "realm-probe-user", project: "realm-probe-project", local: "realm-probe-local" } as const;
/** How long the CLI has to answer one control request, and to connect the servers it was given. */
const ANSWER_MS = 30_000;

/** A stdio MCP server small enough to read: it answers the handshake and lists one tool, which is all
 *  a client needs before it reports the server connected. Its name is its first argument. */
const MCP_SERVER = `import { createInterface } from "node:readline";

const name = process.argv[2];
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  if (message.method === "initialize") reply(message.id, { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name, version: "0.0.1" } });
  else if (message.method === "tools/list") reply(message.id, { tools: [{ name: "ping", description: "Answers pong.", inputSchema: { type: "object", properties: {} } }] });
  else if (message.method === "tools/call") reply(message.id, { content: [{ type: "text", text: "pong" }] });
  else reply(message.id, {});
});
`;

/** What one start of the CLI saw. `memory` is an error where the CLI would not say. */
type Seen = { commands: string[]; servers: McpServerStatus[]; memory: string[] | Error };

/** Where the scratch folder goes: the temp folder, or `/tmp` where the temp folder leads under the
 *  home folder. Both are judged by where they really are. Null where neither is outside it. */
function outsideHome(): string | null {
  const home = realpathSync(homedir());
  for (const candidate of [tmpdir(), "/tmp"]) {
    let real: string;
    try { real = realpathSync(candidate); } catch { continue; }
    if (real !== home && !real.startsWith(home + sep)) return real;
  }
  return null;
}

/**
 * Everything the check writes, under one temp folder: Realm's home, the CLI's home, config folder and
 * temp folder, the project it runs in, and the MCP server's source. The config folder and the project
 * between them set a server up in each of the three scopes and hold a `CLAUDE.md` each.
 */
function scratch(base: string) {
  const root = mkdtempSync(join(base, "realm-setup-live-"));
  const dirs = { root, realm: join(root, "realm"), home: join(root, "home"), config: join(root, "config"), project: join(root, "project"), tmp: join(root, "tmp") };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  const source = join(root, "mcp-server.mjs");
  writeFileSync(source, MCP_SERVER);
  const server = (name: string) => ({ type: "stdio" as const, command: process.execPath, args: [source, name] });
  writeFileSync(join(dirs.config, ".claude.json"), JSON.stringify({
    hasCompletedOnboarding: true,
    mcpServers: { [OWN.user]: server(OWN.user) },
    projects: { [dirs.project]: { hasTrustDialogAccepted: true, mcpServers: { [OWN.local]: server(OWN.local) } } },
  }));
  writeFileSync(join(dirs.project, ".mcp.json"), JSON.stringify({ mcpServers: { [OWN.project]: server(OWN.project) } }));
  const memory = { user: join(dirs.config, "CLAUDE.md"), project: join(dirs.project, "CLAUDE.md") };
  for (const file of Object.values(memory)) writeFileSync(file, "A scratch memory file for a live check. It asks for nothing.\n");
  return { ...dirs, memory, gateway: server(GATEWAY) };
}

/** Stages one skill with the real `SkillsService`, exactly as the server does for a session start. */
function library(home: string) {
  const service = new SkillsService({ home, settings: new SettingsStore(openDatabase(join(home, "realm.db"))), bundledDir: null });
  mkdirSync(join(service.root, SKILL), { recursive: true });
  writeFileSync(join(service.root, SKILL, "SKILL.md"), `---\nname: ${SKILL}\ndescription: A Realm probe skill. Never invoke it.\n---\n\nprobe\n`);
  const injection = service.injectionFor(SPACE, "claude");
  if (!injection) throw new Error("SkillsService staged nothing, so the check cannot prove anything");
  return injection;
}

/** One control request's answer, or an error naming the request once the CLI has had its time. */
function answer<T>(request: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} went unanswered for ${ANSWER_MS / 1000}s`)), ANSWER_MS);
  });
  return Promise.race([request, late]).finally(() => clearTimeout(timer));
}

/** The CLI's MCP servers, asked again until none of `expected` is still missing or connecting. A
 *  server is listed as pending while its process starts, so one answer taken early proves nothing. */
async function settled(q: Query, expected: readonly string[]): Promise<McpServerStatus[]> {
  const deadline = Date.now() + ANSWER_MS;
  for (;;) {
    const servers = await answer(q.mcpServerStatus(), "mcpServerStatus");
    const waiting = expected.filter((name) => (servers.find((s) => s.name === name)?.status ?? "pending") === "pending");
    if (waiting.length === 0 || Date.now() > deadline) return servers;
    await sleep(250);
  }
}

/**
 * Starts the CLI under one set of start options and reads what it sees: its commands, its MCP servers
 * once those in `expected` have settled, and the memory files it loaded. The prompt stream ends
 * without a word, so no turn is ever sent. It answers once the CLI has had a moment to exit, so the
 * next start and the clean-up do not meet a process that is still writing its config.
 */
async function see(options: Options, expected: readonly string[]): Promise<Seen> {
  let end!: () => void;
  const ended = new Promise<IteratorResult<SDKUserMessage>>((settle) => { end = () => settle({ done: true, value: undefined }); });
  const prompt: AsyncIterable<SDKUserMessage> = { [Symbol.asyncIterator]: () => ({ next: () => ended }) };
  const q = query({ prompt, options });
  try {
    const commands = (await answer(q.supportedCommands(), "supportedCommands")).map((c) => c.name);
    const servers = await settled(q, expected);
    let memory: Seen["memory"];
    try {
      memory = (await answer(q.getContextUsage({ detail: "summary" }), "getContextUsage")).memoryFiles.map((f) => resolve(options.cwd ?? "", f.path));
    } catch (e) {
      memory = e instanceof Error ? e : new Error(String(e));
    }
    return { commands, servers, memory };
  } finally {
    end();
    q.close();
    await sleep(500);
  }
}

const statusOf = (seen: Seen, name: string): string => seen.servers.find((s) => s.name === name)?.status ?? "absent";
const serversOf = (seen: Seen): string => seen.servers.map((s) => `${s.name}: ${s.status}`).join(", ") || "(none)";
const memoryOf = (seen: Seen): string => (seen.memory instanceof Error ? seen.memory.message : seen.memory.join(", ") || "(none)");
const loads = (seen: Seen, file: string): boolean => !(seen.memory instanceof Error) && seen.memory.includes(file);

async function main() {
  const base = outsideHome();
  if (!base) {
    ok("there is a temp folder outside the home folder", false, `${tmpdir()} and /tmp both lead under ${homedir()}`);
    finish();
  }
  const dirs = scratch(base);
  const stderr: string[] = [];
  console.log(`scratch: ${dirs.root}`);
  try {
    const injection = library(dirs.realm);
    const plugin = { type: "local" as const, path: injection.pluginPath, skipMcpDiscovery: true };
    const shared: Options = {
      cwd: dirs.project,
      env: {
        HOME: dirs.home, CLAUDE_CONFIG_DIR: dirs.config, TMPDIR: dirs.tmp, PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
      },
      mcpServers: { [GATEWAY]: dirs.gateway },
      stderr: (line) => { stderr.push(line); },
    };

    console.log("\n=== settingSources: [] with the plugin ===");
    const isolated = await see({ ...shared, settingSources: [], plugins: [plugin] }, [GATEWAY]);
    ok("Realm's skill is listed", isolated.commands.includes(`realm:${SKILL}`), `${isolated.commands.length} commands`);
    ok("the server Realm passes in the start options is connected", statusOf(isolated, GATEWAY) === "connected", serversOf(isolated));
    ok("none of the person's three MCP servers is there", Object.values(OWN).every((name) => statusOf(isolated, name) === "absent"), serversOf(isolated));
    ok("the CLI loads neither CLAUDE.md, so Realm has to carry them in",
      Array.isArray(isolated.memory) && !Object.values(dirs.memory).some((file) => loads(isolated, file)), memoryOf(isolated));

    console.log("\n=== the plugin alone ===");
    const own = await see({ ...shared, plugins: [plugin] }, [GATEWAY, ...Object.values(OWN)]);
    ok("Realm's skill is still listed", own.commands.includes(`realm:${SKILL}`), `${own.commands.length} commands`);
    ok("the server Realm passes in the start options is still connected", statusOf(own, GATEWAY) === "connected", serversOf(own));
    for (const [scope, name] of Object.entries(OWN)) ok(`the person's ${scope}-scope MCP server is connected`, statusOf(own, name) === "connected", statusOf(own, name));
    ok("the CLI loads the user's and the project's CLAUDE.md itself, so Realm must not carry them in again",
      Object.values(dirs.memory).every((file) => loads(own, file)), memoryOf(own));
  } catch (e) {
    ok("claude reachable", false, [e instanceof Error ? e.message : String(e), ...stderr.slice(-20)].join("\n"));
  } finally {
    rmSync(dirs.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
  finish();
}

main().catch((e) => { console.error("driver crashed:", e); process.exit(2); });
