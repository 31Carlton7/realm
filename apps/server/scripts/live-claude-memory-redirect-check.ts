/**
 * Live check that Claude's own auto-memory goes where Realm points it, against the REAL Claude CLI.
 *
 * What a unit test cannot hold up is what the CLI does with the `autoMemoryDirectory` flag setting:
 * whether a fact Claude decides to remember lands in the space's folder of the user's memory repo, and
 * nothing at all under `~/.claude/projects/<project>/memory`. So this builds a scratch Realm home with
 * a real profile repo, takes the folder the REAL `AgentMemoryFolders` hands a session, starts the REAL
 * `ClaudeAdapter` with it (the per-invocation flag layer, the same channel fast mode uses) and the
 * context `MemoryService` would give it, and asks the model to remember a harmless fact. Then the turn
 * is committed the way the server commits a settled turn.
 *
 * It costs one short turn on claude-haiku-4-5. It writes nothing under ~/.claude but the transcript the
 * CLI keeps for its scratch working folder, and it never deletes anything there.
 *
 *   LIVE_SCRATCH=<a folder outside /tmp> pnpm --filter @realm/server exec tsx scripts/live-claude-memory-redirect-check.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter, type AgentHandle } from "@realm/adapters";
import type { Environment } from "@realm/contracts";
import { openDatabase } from "../src/db/database";
import { SettingsStore } from "../src/store/settings";
import { AgentMemoryFolders } from "../src/memory/claude-redirect";
import { MemoryRepoService } from "../src/memory/repo";
import { MemoryService } from "../src/memory/service";
import { finish, ok } from "./harness";

const PROFILE = "01ARZ3NDEKTSV4RRFFQ69G5FP1";
const SPACE = "01ARZ3NDEKTSV4RRFFQ69G5FS1";
const SESSION = "01ARZ3NDEKTSV4RRFFQ69G5FSE";
const MODEL = "claude-haiku-4-5-20251001";
const TURN_TIMEOUT_MS = 240_000;
const nonce = Math.random().toString(36).slice(2, 8).toUpperCase();
const FRUIT = `persimmon-${nonce}`;

/** Every file under `~/.claude/projects/<project>/memory`, with its modification time. */
function claudeMemoryFiles(): Map<string, number> {
  const out = new Map<string, number>();
  const base = join(homedir(), ".claude", "projects");
  for (const project of readdirSync(base)) {
    const dir = join(base, project, "memory");
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) out.set(join(dir, n), statSync(join(dir, n)).mtimeMs);
  }
  return out;
}

async function main(): Promise<void> {
  const scratch = mkdtempSync(join(process.env.LIVE_SCRATCH ?? tmpdir(), "realm-claude-redirect-"));
  const home = join(scratch, "home");
  const cwd = join(scratch, "work");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const before = claudeMemoryFiles();
  const started = Date.now();
  try {
    const settings = new SettingsStore(openDatabase(join(home, "realm.db")));
    const repos = new MemoryRepoService({
      home, settings, autoCreate: true,
      scopes: { profileIdOf: (s) => (s === SPACE ? PROFILE : null), spaceIdsOf: () => [SPACE], spaceNameOf: () => "Scratch" },
      forbiddenRoots: () => [cwd, join(homedir(), ".claude")],
      committerName: async () => "Live check",
    });
    const made = await repos.ensureProfileRepo(PROFILE);
    ok("the profile's repo is made by default", made !== null, made?.path ?? "");
    const folders = new AgentMemoryFolders({ repos });
    const dir = folders.dirFor(SPACE)!;
    ok("the session is handed the space's folder of it", dir === join(made!.path, "spaces", "scratch"), dir);
    const environments = { ensurePrimary: (spaceId: string): Environment => ({ id: "e", spaceId, path: cwd, branch: null, kind: "primary", portBlockStart: null, createdAt: 0, updatedAt: 0 }) };
    const memory = new MemoryService({ home, settings, environments, claudeDir: join(scratch, "claude-home"), repos });
    const systemContext = memory.systemContextFor({ spaceId: SPACE, kind: "claude", cwd, skillsInjected: false });

    const handle: AgentHandle = new ClaudeAdapter().start({ cwd, model: MODEL, permissionMode: "default", mcpServers: [], systemContext, memoryDirectory: dir });
    const asked: string[] = [];
    let text = "";
    let turnError: string | null = null;
    const done = (async () => {
      for await (const e of handle.events) {
        if (e.type === "assistant_text") text += `${e.payload.text}\n`;
        // Anything the CLI does not allow by itself is refused: the check is that a memory write needs no one.
        if (e.type === "permission_request") { asked.push(`${e.payload.toolName} ${JSON.stringify(e.payload.input).slice(0, 160)}`); handle.respondPermission(e.payload.requestId, "deny"); }
        if (e.type === "error") turnError = e.payload.message;
        if (e.type === "status" && (e.payload.status === "idle" || e.payload.status === "error") && text) break;
      }
    })();
    await handle.send({ text: `Please remember this for future sessions in this project: my favourite test fruit is the ${FRUIT}. Save it to your memory now, then reply "saved".`, attachments: [] });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([done, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("turn timed out")), TURN_TIMEOUT_MS); })]);
    clearTimeout(timer);
    await handle.dispose();
    console.log(`[live] Claude said: ${text.trim().slice(0, 300)}`);
    ok("the turn ended without an error", turnError === null, turnError ?? "");
    ok("no permission was asked for", asked.length === 0, JSON.stringify(asked));

    const written = readdirSync(dir);
    const holding = written.filter((n) => readFileSync(join(dir, n), "utf8").includes(FRUIT));
    ok("the fact landed in the redirected folder", holding.length > 0, JSON.stringify(written));
    for (const n of written) console.log(`[live] ${join(dir, n)}:\n${readFileSync(join(dir, n), "utf8")}`);

    await folders.turnSettled({ id: SESSION, spaceId: SPACE, title: "Remember a fruit" });
    const log = execFileSync("git", ["-C", made!.path, "log", "--format=%s", "-2"], { encoding: "utf8" });
    ok("the settled turn is committed, naming the session", log.startsWith("Save what Claude remembered in “Remember a fruit”"), log);
    ok("nothing is left uncommitted", execFileSync("git", ["-C", made!.path, "status", "--porcelain"], { encoding: "utf8" }) === "");

    const after = claudeMemoryFiles();
    const fresh = [...after].filter(([p, t]) => !before.has(p) || t > before.get(p)!).map(([p]) => p);
    ok("no file was written under ~/.claude/projects/*/memory", fresh.length === 0, JSON.stringify(fresh));
    const transcripts = readdirSync(join(homedir(), ".claude", "projects")).filter((p) => statSync(join(homedir(), ".claude", "projects", p)).mtimeMs >= started);
    console.log(`[live] ~/.claude/projects folders touched by this run (a transcript is expected): ${JSON.stringify(transcripts)}`);
    for (const p of transcripts) ok(`${p} holds no memory folder`, !existsSync(join(homedir(), ".claude", "projects", p, "memory")));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().then(finish, (e) => { console.error(e); process.exit(1); });
