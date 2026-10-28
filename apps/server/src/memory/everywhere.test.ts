import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { AsyncQueue, type AgentAdapter, type AgentHandle, type StartOptions } from "@realm/adapters";
import { sessionEvent, type AgentKind, type SessionEvent } from "@realm/contracts";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";
import { claudeProjectName } from "./claude-backfill";

let app: App | null = null;
afterEach(async () => { await app?.close(); app = null; vi.unstubAllEnvs(); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: Any) => void>();
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); });
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<Any>((res, rej) => {
    const id = String(++n);
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`rpc ${method} timed out`)); }, 10_000);
    pending.set(id, (v) => { clearTimeout(timer); if (v.error) rej(new Error(`${method}: ${v.error.message}`)); else res(v.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { call, close: () => ws.close() };
}

/**
 * An engine that keeps memory the way Claude does: on each turn it writes a fact file and its index
 * line into whatever memory directory it was started with — plain writes, never a commit.
 */
class EngineThatRemembers implements AgentAdapter {
  readonly starts: StartOptions[] = [];
  constructor(readonly kind: AgentKind) {}
  async probe() { return { kind: this.kind, available: true, version: "0", loggedIn: true, reason: null }; }
  start(opts: StartOptions): AgentHandle {
    this.starts.push(opts);
    const events = new AsyncQueue<SessionEvent>();
    events.push(sessionEvent("init", { providerSessionId: `prov_${this.starts.length}`, model: "m", tools: [], cwd: opts.cwd }));
    events.push(sessionEvent("status", { status: "idle" }));
    return {
      events,
      send: async () => {
        events.push(sessionEvent("status", { status: "running" }));
        if (opts.memoryDirectory) {
          writeFileSync(join(opts.memoryDirectory, "uses-pnpm.md"), "---\nname: uses-pnpm\ndescription: The repo uses pnpm\nmetadata:\n  type: project\n---\n\nFOLDER-FACT pnpm, never npm.\n");
          writeFileSync(join(opts.memoryDirectory, "MEMORY.md"), "- [uses-pnpm](uses-pnpm.md) — FOLDER-FACT the repo uses pnpm\n");
        }
        events.push(sessionEvent("assistant_text", { messageId: "m1", text: "ok" }));
        events.push(sessionEvent("status", { status: "idle" }));
      },
      respondPermission: () => {},
      interrupt: async () => {},
      setOptions: async () => {},
      dispose: async () => { events.close(); },
    };
  }
}

async function boot(home: string, o: { memoryRepoByDefault?: boolean } = {}) {
  vi.stubEnv("REALM_BUNDLED_SKILLS", join(home, "no-bundle"));
  const claude = new EngineThatRemembers("claude");
  const codex = new EngineThatRemembers("codex");
  // The suite's homes are under the temporary folder, which the app passes over; this one names its own.
  app = await createApp({ home, port: 0, claudeDir: join(home, "claude-home"), memoryRepoByDefault: o.memoryRepoByDefault ?? true, adapters: { claude, codex }, claudeTemporaryRoots: [join(home, "scratch")] });
  return { ...(await client(app.port)), claude, codex };
}

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" });

describe("memory on by default", () => {
  it("gives the first profile a repo at boot and a new profile one as it is made; a detached one stays detached", async () => {
    const home = tempDir("realm-memdefault-app-");
    const c = await boot(home);
    const [personal] = await c.call("profiles.list", {});
    expect((await c.call("memory.repo.get", { profileId: personal.id })).repos).toMatchObject([{ scope: "profile", valid: true }]);
    const work = await c.call("profiles.create", { name: "Work" });
    // Made before `profiles.create` answered, so the page that opens next already has it.
    expect((await c.call("memory.repo.get", { profileId: work.id })).repos).toMatchObject([{ scope: "profile", valid: true }]);
    await c.call("memory.repo.detach", { scope: "profile", ownerId: work.id });
    c.close();
    await app!.close();
    app = null;
    const again = await boot(home);
    expect((await again.call("memory.repo.get", { profileId: work.id })).repos).toEqual([]);
    expect((await again.call("memory.repo.get", { profileId: personal.id })).repos).toHaveLength(1);
    again.close();
  });

  it("makes none in a harness that does not ask for it", async () => {
    const c = await boot(tempDir("realm-memdefault-app-"), { memoryRepoByDefault: false });
    const [personal] = await c.call("profiles.list", {});
    expect((await c.call("memory.repo.get", { profileId: personal.id })).repos).toEqual([]);
    c.close();
  });
});

describe("the engines' own memory, kept in the profile's repo", () => {
  async function space(c: Awaited<ReturnType<typeof boot>>, name = "Realm") {
    const [personal] = await c.call("profiles.list", {});
    const sp = await c.call("spaces.create", { profileId: personal.id, name });
    const [repo] = (await c.call("memory.repo.get", { profileId: personal.id })).repos;
    return { sp, repo: repo.path as string, profileId: personal.id as string };
  }
  async function turn(c: Awaited<ReturnType<typeof boot>>, spaceId: string, agentKind: string, title: string) {
    const { session } = await c.call("sessions.create", { spaceId, agentKind, title });
    await c.call("sessions.send", { id: session.id, text: "go" });
    return session;
  }

  it("points Claude at the space's folder and commits what it wrote when the turn ends, naming the session", async () => {
    const c = await boot(tempDir("realm-memredirect-"));
    const { sp, repo } = await space(c);
    const session = await turn(c, sp.id, "claude", "Fix the build");
    const dir = join(repo, "spaces", "realm");
    expect(c.claude.starts[0]!.memoryDirectory).toBe(dir);
    await waitFor(() => git(repo, "log", "-1", "--format=%s").trim() === "Save what Claude remembered in “Fix the build”");
    expect(git(repo, "log", "-1", "--format=%b").trim()).toBe(`Session: realm:session/${session.id}`);
    expect(git(repo, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean).sort()).toEqual(["MEMORY.md", "spaces/realm/MEMORY.md", "spaces/realm/uses-pnpm.md"]);
    expect(git(repo, "status", "--porcelain")).toBe("");
    // Codex in the same space keeps none of its own, and reads the folder's index from Realm; Claude
    // started again reads only the root, because the folder is its own directory.
    await turn(c, sp.id, "codex", "Review");
    await turn(c, sp.id, "claude", "Again");
    expect(c.codex.starts[0]!.memoryDirectory).toBe(dir);
    expect(c.codex.starts[0]!.systemContext).toContain("FOLDER-FACT");
    expect(c.claude.starts[1]!.systemContext).not.toContain("FOLDER-FACT");
    c.close();
  });

  it("leaves Claude's memory where it was in a space that turned the profile's repo off", async () => {
    const c = await boot(tempDir("realm-memredirect-"));
    const { sp } = await space(c);
    await c.call("memory.repo.setInherited", { spaceId: sp.id, enabled: false });
    await turn(c, sp.id, "claude", "Off here");
    // THE MUTANT: hand the folder to every session — a space that opted out has its memory moved anyway.
    expect("memoryDirectory" in c.claude.starts[0]!).toBe(false);
    c.close();
  });

  it("commits at boot what Claude wrote while nothing was committing it", async () => {
    const home = tempDir("realm-memredirect-");
    const c = await boot(home);
    const { sp, repo } = await space(c);
    await turn(c, sp.id, "claude", "First");
    await waitFor(() => git(repo, "log", "-1", "--format=%s").startsWith("Save what Claude remembered"));
    c.close();
    await app!.close();
    app = null;
    const dir = join(repo, "spaces", "realm");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "late.md"), "Written by a Claude run Realm never saw end.\n");
    const again = await boot(home);
    await waitFor(() => git(repo, "log", "-1", "--format=%s").trim() === "Save memory Claude left uncommitted");
    expect(existsSync(join(dir, "late.md"))).toBe(true);
    expect(git(repo, "status", "--porcelain")).toBe("");
    again.close();
  });
});

describe("Claude's memory from outside Realm, through the Memory page's row", () => {
  it("lands in the folder of the space that works in the project, and the row says what came in", async () => {
    const home = tempDir("realm-membackfill-app-");
    const c = await boot(home);
    const [personal] = await c.call("profiles.list", {});
    const sp = await c.call("spaces.create", { profileId: personal.id, name: "Stora" });
    // It runs by itself at boot; that run is over before Claude keeps anything here.
    await waitFor(async () => (await c.call("memory.repo.claudeBackfill", { profileId: personal.id })).at !== null);
    // A Claude run in a terminal, in the space's folder, kept this.
    const memory = join(home, "claude-home", "projects", claudeProjectName(realpathSync(sp.folderPath)), "memory");
    mkdirSync(memory, { recursive: true });
    writeFileSync(join(memory, "deploys.md"), "Deploys on Fridays.\n");
    writeFileSync(join(memory, "MEMORY.md"), "- [deploys](deploys.md) — Fridays\n");
    const lost = join(home, "claude-home", "projects", "-nowhere-at-all", "memory");
    mkdirSync(lost, { recursive: true });
    writeFileSync(join(lost, "x.md"), "x\n");
    const r = await c.call("memory.repo.claudeBackfill", { profileId: personal.id, run: true });
    expect(r).toMatchObject({ imported: 1, total: 1, unmatched: [{ project: "-nowhere-at-all", reason: "no space works in that folder" }], error: null });
    const [repo] = (await c.call("memory.repo.get", { profileId: personal.id })).repos;
    expect(readFileSync(join(repo.path, "spaces", "stora", "deploys.md"), "utf8")).toBe("Deploys on Fridays.\n");
    c.close();
  });
});
