import { describe, expect, it, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAdapter, type AgentHandle, type StartOptions, type FakeScript } from "@realm/adapters";
import type { McpServerConfig } from "@realm/adapters";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createApp, type App } from "../app";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { EnvironmentsStore } from "../store/environments";
import { waitFor } from "../test-utils";
import { createRealmAgentProvider, RUN_TOOL_NAME } from "../browsers/browser-agent";
import { AGENT_RUN_TOOL_NAME } from "./agent-run";

/**
 * Plan 13 W1 behaviour suite — `agent_run`, driven through the REAL app (`createApp` + FakeAdapter),
 * the same way browser-agent.test.ts drives `browser_agent_run`. The named mutants this suite exists
 * to kill:
 *
 *   - bypass requested-and-granted              → "bypassPermissions is never granted"
 *   - a laxer-than-parent mode granted          → "the cap is min(parent, requested)"
 *   - child seeing agent_run (recursion)        → "recursion guard" (+ gateway.test.ts exclude-mode)
 *   - constraints.skills superset accepted      → "skills narrowing"
 *   - environment from another space accepted   → "environments"
 *   - parent interrupt not cancelling the child → "interrupting the parent cancels the run"
 *   - engine forked                             → structure.test.ts (one settle/drain implementation)
 *   - browser_agent_run changed by extraction   → that tool's own suite, untouched
 */

let app: App;
afterEach(async () => { await app?.close(); });

/** Records every StartOptions the (child) adapter is started with — the seam the skills/systemContext
 *  assertions read. */
class CaptureFake extends FakeAdapter {
  readonly seen: StartOptions[] = [];
  constructor(cfg: ConstructorParameters<typeof FakeAdapter>[0]) { super(cfg); }
  override start(o: StartOptions): AgentHandle { this.seen.push(o); return super.start(o); }
}

/** The agent child's one message begins "You are a delegated agent." — distinct from the browser
 *  child's "You are a delegated browser agent", so one script can serve both tools. */
const CHILD_SCRIPT: FakeScript = [{ on: "You are a delegated agent.", emit: [
  { kind: "text", text: "partial: reading the task" },
  { kind: "text", text: "FINAL: wrote the file, all done" },
] }];

const longScript = (steps: number): FakeScript => [{ on: "You are a delegated agent.", emit: [
  { kind: "text", text: "partial: starting" },
  ...Array.from({ length: steps }, (_, i) => ({ kind: "text" as const, text: `step ${i}` })),
] }];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
}
/** Turn the space's folder — a plain directory, as Realm makes it — into a real repository, so
 *  `newWorktree` has something to branch. */
function initRepo(dir: string): void {
  git(dir, "init", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", "."); git(dir, "commit", "-m", "init");
}

/** Drop a valid skill into the library so narrowing has something to narrow. */
function addSkill(home: string, id: string): void {
  const dir = join(home, "skills", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${id}\ndescription: does ${id}\n---\nbody\n`);
}

async function boot(opts: {
  script?: FakeScript; delayMs?: number;
  parentKind?: "fake" | "claude"; parentMode?: string;
  timeouts?: { baseMs: number; perTurnMs: number; pollMs: number };
} = {}) {
  const home = mkdtempSync(join(tmpdir(), "realm-ar-"));
  const fake = new CaptureFake({ script: opts.script ?? CHILD_SCRIPT, delayMs: opts.delayMs ?? 5 });
  // The same fake serves BOTH registry keys — "claude" is the stand-in kind with skills injection,
  // exactly the arrangement browser-agent.test.ts uses.
  app = await createApp({
    home, port: 0, adapters: { fake, claude: fake },
    browserAgent: { fallbackKind: "fake", timeouts: { baseMs: 5000, perActMs: 0, pollMs: 20 } },
    agentRun: { timeouts: opts.timeouts ?? { baseMs: 5000, perTurnMs: 0, pollMs: 20 } },
  });
  const profile = new ProfilesStore(app.db).create({ name: "P", icon: "x", color: "#000" });
  const spacesStore = new SpacesStore(app.db, home);
  const space = spacesStore.create({ profileId: profile.id, name: "S", icon: "folder" });
  const parent = app.sessions.create({ spaceId: space.id, agentKind: opts.parentKind ?? "fake", projectId: null, model: null, effort: null, permissionMode: opts.parentMode ?? "default" });
  return { home, fake, spacesStore, profileId: profile.id, spaceId: space.id, folder: space.folderPath, parentId: parent.session.id };
}

const text = (r: CallToolResult): string =>
  r.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n");

const childOf = (spaceId: string, parentId: string) => {
  const others = app.sessions.list(spaceId).filter((s) => s.id !== parentId);
  expect(others).toHaveLength(1);
  return others[0]!;
};

describe("agent_run — the delegated session", () => {
  it("creates a real, visible child session in the caller's space and returns its fenced final report + identity", async () => {
    const { spaceId, parentId } = await boot();
    const result = await app.agentRuns.run({ sessionId: parentId, spaceId }, { goal: "Write DONE.txt in the repo" });
    expect(result.isError).toBe(false);
    const child = childOf(spaceId, parentId);
    expect(child.spaceId).toBe(spaceId);
    expect(child.title).toContain("Agent:");
    const out = text(result);
    expect(out).toContain(child.id);            // the structured identity names the child
    expect(out).toContain(child.title);
    expect(out).toContain('"status":"done"');
    expect(out).toContain("FINAL: wrote the file, all done");
    expect(out).toMatch(/agent-output-[0-9a-f]{16}/); // fenced, attributed as a subagent's report
    expect(out).toContain("DELEGATED AGENT'S REPORT");
  });

  it("records the dispatch origin on the child — and on a browser_agent_run child too (the W2 Tasks-lens seam)", async () => {
    const { spaceId, parentId } = await boot({ script: [
      ...CHILD_SCRIPT,
      { on: "delegated browser agent", emit: [{ kind: "text", text: "FINAL: browsed" }] },
    ] });
    expect(app.sessions.get(parentId).dispatchedBy).toBeNull(); // user-created: no origin invented
    await app.agentRuns.run({ sessionId: parentId, spaceId }, { goal: "go" });
    const agentChild = childOf(spaceId, parentId);
    expect(agentChild.dispatchedBy).toEqual({ sessionId: parentId, kind: "agent_run" });
    await app.browserAgents.run({ sessionId: parentId, spaceId }, { goal: "browse" });
    const browserChild = app.sessions.list(spaceId).find((s) => s.id !== parentId && s.id !== agentChild.id)!;
    expect(browserChild.dispatchedBy).toEqual({ sessionId: parentId, kind: "browser_agent_run" });
  });

  it("refuses malformed arguments without creating anything", async () => {
    const { spaceId, parentId } = await boot();
    const result = await app.agentRuns.run({ sessionId: parentId, spaceId }, {});
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("invalid arguments");
    expect(app.sessions.list(spaceId)).toHaveLength(1);
  });

  it("broadcasts session.agentOpened with the child's id and item, and stages the delegation preamble", async () => {
    const { fake, spaceId, parentId } = await boot({ parentKind: "claude" });
    await app.agentRuns.run({ sessionId: parentId, spaceId }, { goal: "Refactor the parser" });
    expect(fake.seen).toHaveLength(1); // only the CHILD started
    const started = fake.seen[0]!;
    expect(started.systemContext).toContain("Delegated agent (Realm)");
    expect(started.systemContext).toContain("Refactor the parser");
    expect(started.systemContext).toContain("depth-1");
  });
});

describe("permission cap — min(parent, requested), bypass never granted", () => {
  it("NEVER inherits bypassPermissions — a bypass parent's child runs default (the safety line)", async () => {
    const { spaceId, parentId } = await boot({ parentMode: "bypassPermissions" });
    await app.agentRuns.run({ sessionId: parentId, spaceId }, { goal: "go" });
    expect(childOf(spaceId, parentId).permissionMode).toBe("default");
  });

  it("NEVER grants a requested bypass — it degrades to default and the result says so", async () => {
    const { spaceId, parentId } = await boot({ parentMode: "bypassPermissions" });
    const result = await app.agentRuns.run({ sessionId: parentId, spaceId }, { goal: "go", constraints: { permissionMode: "bypassPermissions" } });
    expect(childOf(spaceId, parentId).permissionMode).toBe("default");
    expect(text(result)).toContain("bypassPermissions was requested but is never granted");
  });

  it("caps a requested mode at the parent's — a default parent cannot mint an acceptEdits child", async () => {
    const { spaceId, parentId } = await boot({ parentMode: "default" });
    await app.agentRuns.run({ sessionId: parentId, spaceId }, { goal: "go", constraints: { permissionMode: "acceptEdits" } });
    expect(childOf(spaceId, parentId).permissionMode).toBe("default");
  });

  it("carries the parent's mode when nothing is requested, and lets a request TIGHTEN it", async () => {
    const { spaceId, parentId } = await boot({ parentMode: "acceptEdits", script: [
      ...CHILD_SCRIPT,
    ] });
    await app.agentRuns.run({ sessionId: parentId, spaceId }, { goal: "go" });
    const first = childOf(spaceId, parentId);
    expect(first.permissionMode).toBe("acceptEdits");
    const r2 = await app.agentRuns.run({ sessionId: parentId, spaceId }, { goal: "go tighter", constraints: { permissionMode: "plan" } });
    expect(r2.isError).toBe(false);
    const second = app.sessions.list(spaceId).find((s) => s.id !== parentId && s.id !== first.id)!;
    expect(second.permissionMode).toBe("plan");
  });
});

describe("recursion guard — depth-1, enforced server-side", () => {
  it("a child cannot run agent_run OR browser_agent_run, and lists no realm-agent tools", async () => {
    const { spaceId, parentId } = await boot();
    await app.agentRuns.run({ sessionId: parentId, spaceId }, { goal: "go" });
    const child = childOf(spaceId, parentId);

    // The child is registered — the seam app.ts's gateway closure turns into { exclude: ["realm-agent"] }.
    expect(app.agentRuns.isChild(child.id)).toBe(true);
    expect(app.agentRuns.isChild(parentId)).toBe(false);
    // NOT the browser child's only-mode restriction: the agent child keeps the full surface.
    expect(app.browserAgents.sessionToolset(child.id)).toBeNull();

    // The provider's own belt, independent of the gateway toolset shape:
    const provider = createRealmAgentProvider(app.browserAgents, { providerEnabled: () => true }, app.agentRuns);
    expect(await provider.tools({ sessionId: child.id, spaceId })).toEqual([]);
    expect((await provider.tools({ sessionId: parentId, spaceId })).map((t) => t.name)).toEqual([RUN_TOOL_NAME, AGENT_RUN_TOOL_NAME]);
    for (const tool of [AGENT_RUN_TOOL_NAME, RUN_TOOL_NAME]) {
      const refused = await provider.call({ sessionId: child.id, spaceId }, tool, { goal: "spawn another" });
      expect(refused.isError).toBe(true);
      expect(text(refused)).toContain("depth-1");
    }
    // The service's innermost check, even if both outer layers were lost:
    const direct = await app.agentRuns.run({ sessionId: child.id, spaceId }, { goal: "spawn another" });
    expect(direct.isError).toBe(true);
    expect(text(direct)).toContain("depth-1");
    // No grandchild session appeared.
    expect(app.sessions.list(spaceId)).toHaveLength(2);
  });

  it("through the REAL gateway, the child's tools/list has the full surface minus realm-agent — app.ts's closure, not a stub", async () => {
    const { spaceId, parentId } = await boot();
    await app.agentRuns.run({ sessionId: parentId, spaceId }, { goal: "go" });
    const child = childOf(spaceId, parentId);
    const listAs = async (sessionId: string): Promise<string[]> => {
      const cfg = app.gateway.register(sessionId, spaceId) as Extract<McpServerConfig, { url: string }>;
      const client = new Client({ name: "t", version: "1.0.0" }, { capabilities: {} });
      await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } }));
      const names = (await client.listTools()).tools.map((t) => t.name);
      await client.close();
      return names;
    };
    const childTools = await listAs(child.id);
    expect(childTools.some((n) => n.startsWith("realm-agent__"))).toBe(false);   // the recursion mutant
    expect(childTools.some((n) => n.startsWith("realm-browser__"))).toBe(true);  // the normal surface stays
    const parentTools = await listAs(parentId);
    expect(parentTools).toContain(`realm-agent__${AGENT_RUN_TOOL_NAME}`);
    expect(parentTools).toContain(`realm-agent__${RUN_TOOL_NAME}`);
  });

  it("a BROWSER-agent child cannot call agent_run either", async () => {
    const { spaceId, parentId } = await boot({ script: [
      { on: "delegated browser agent", emit: [{ kind: "text", text: "FINAL: browsed" }] },
    ] });
    await app.browserAgents.run({ sessionId: parentId, spaceId }, { goal: "browse" });
    const browserChild = childOf(spaceId, parentId);
    const refused = await app.agentRuns.run({ sessionId: browserChild.id, spaceId }, { goal: "escalate" });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("depth-1");
    expect(app.sessions.list(spaceId)).toHaveLength(2);
  });

  it("the child's record — and with it the exclusion and skill narrowing — survives a server restart", async () => {
    const { home, spaceId, parentId } = await boot();
    addSkill(home, "alpha");
    await app.agentRuns.run({ sessionId: parentId, spaceId }, { goal: "go", constraints: { skills: ["alpha"] } });
    const childId = childOf(spaceId, parentId).id;
    await app.close();
    app = await createApp({ home, port: 0, adapters: { fake: new FakeAdapter({ script: [] }) } });
    expect(app.agentRuns.isChild(childId)).toBe(true);
    expect(app.agentRuns.skillsFilter(childId)).toEqual(["alpha"]);
  });

  it("deleting the child session forgets its record — the restriction dies with it", async () => {
    const { spaceId, parentId } = await boot();
    await app.agentRuns.run({ sessionId: parentId, spaceId }, { goal: "go" });
    const childId = childOf(spaceId, parentId).id;
    await app.sessions.delete(childId);
    expect(app.agentRuns.isChild(childId)).toBe(false);
    expect(app.agentRuns.skillsFilter(childId)).toBeNull();
  });
});

describe("skills narrowing — subset of the space's enabled set, refused loudly otherwise", () => {
  it("refuses a skill id the space never enabled, creating NOTHING (the superset mutant)", async () => {
    const { home, spaceId, parentId } = await boot();
    addSkill(home, "alpha");
    const result = await app.agentRuns.run({ sessionId: parentId, spaceId }, { goal: "go", constraints: { skills: ["alpha", "ghost"] } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("ghost");
    expect(text(result)).toContain("subset");
    expect(app.sessions.list(spaceId)).toHaveLength(1);
  });

  it("stages ONLY the named subset for the child, under a per-session stage — the space's shared stage untouched", async () => {
    const { home, fake, spaceId, parentId } = await boot({ parentKind: "claude" });
    addSkill(home, "alpha");
    addSkill(home, "beta");
    await app.agentRuns.run({ sessionId: parentId, spaceId }, { goal: "go", constraints: { skills: ["alpha"] } });
    const child = childOf(spaceId, parentId);
    expect(fake.seen).toHaveLength(1);
    const started = fake.seen[0]!;
    expect(started.skills).toBeDefined();
    expect(readdirSync(started.skills!.root)).toEqual(["alpha"]); // not beta, not the bundled browsing skill
    expect(started.skills!.root).toContain(child.id);             // session-keyed stage, not the space's
  });

  it("without a skills constraint the child gets the space's FULL enabled set", async () => {
    const { home, fake, spaceId, parentId } = await boot({ parentKind: "claude" });
    addSkill(home, "alpha");
    await app.agentRuns.run({ sessionId: parentId, spaceId }, { goal: "go" });
    expect(fake.seen).toHaveLength(1);
    const staged = readdirSync(fake.seen[0]!.skills!.root);
    expect(staged).toContain("alpha");
    expect(staged).toContain("browsing"); // the bundled skill — full set, no browser-agent narrowing
  });
});

describe("environments — named, fresh worktree, or the space primary", () => {
  it("runs the child in a NAMED existing environment — born with it, no rebind", async () => {
    const { spaceId, folder, parentId } = await boot();
    initRepo(folder);
    const envs = new EnvironmentsStore(app.db);
    const primary = envs.ensurePrimary(spaceId);
    const other = envs.create({ spaceId, path: join(folder, ".."), kind: "checkout", branch: null });
    const result = await app.agentRuns.run({ sessionId: parentId, spaceId }, { goal: "go", constraints: { environmentId: other.id } });
    expect(result.isError).toBe(false);
    const child = childOf(spaceId, parentId);
    expect(child.environmentId).toBe(other.id);
    expect(child.environmentId).not.toBe(primary.id);
    expect(child.cwd).toBe(other.path);
  });

  it("REFUSES an environment belonging to another space, creating nothing", async () => {
    const { spacesStore, profileId, spaceId, parentId } = await boot();
    const spaceB = spacesStore.create({ profileId, name: "B", icon: "folder" });
    const foreign = new EnvironmentsStore(app.db).ensurePrimary(spaceB.id);
    const result = await app.agentRuns.run({ sessionId: parentId, spaceId }, { goal: "go", constraints: { environmentId: foreign.id } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("another space");
    expect(app.sessions.list(spaceId)).toHaveLength(1);
    expect(app.sessions.list(spaceB.id)).toHaveLength(0);
  });

  it("newWorktree creates a fresh worktree via the Plan 7 path and the child runs INSIDE it", async () => {
    const { home, spaceId, folder, parentId } = await boot();
    initRepo(folder);
    const result = await app.agentRuns.run({ sessionId: parentId, spaceId }, { goal: "go", constraints: { newWorktree: "fix-login" } });
    expect(result.isError).toBe(false);
    const child = childOf(spaceId, parentId);
    const env = new EnvironmentsStore(app.db).get(child.environmentId)!;
    expect(env.kind).toBe("worktree");
    expect(env.path).toBe(join(home, "worktrees", spaceId, "fix-login"));
    expect(child.cwd).toBe(env.path);
    expect(git(env.path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toMatch(/fix-login/);
  });

  it("newWorktree: true titles the worktree from the goal's first words", async () => {
    const { spaceId, folder, parentId } = await boot();
    initRepo(folder);
    const result = await app.agentRuns.run({ sessionId: parentId, spaceId }, { goal: "Sort the imports\nand more detail", constraints: { newWorktree: true } });
    expect(result.isError).toBe(false);
    const child = childOf(spaceId, parentId);
    const env = new EnvironmentsStore(app.db).get(child.environmentId)!;
    expect(env.kind).toBe("worktree");
    expect(env.path).toContain("sort-the-imports");
  });

  it("a space that is not a git repository refuses newWorktree with git's real reason, creating nothing", async () => {
    const { spaceId, parentId } = await boot();
    const result = await app.agentRuns.run({ sessionId: parentId, spaceId }, { goal: "go", constraints: { newWorktree: true } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("not a git repository");
    expect(app.sessions.list(spaceId)).toHaveLength(1);
  });

  it("refuses environmentId + newWorktree together", async () => {
    const { spaceId, parentId } = await boot();
    const env = new EnvironmentsStore(app.db).ensurePrimary(spaceId);
    const result = await app.agentRuns.run({ sessionId: parentId, spaceId }, { goal: "go", constraints: { environmentId: env.id, newWorktree: true } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("mutually exclusive");
    expect(app.sessions.list(spaceId)).toHaveLength(1);
  });

  it("neither constraint → the child runs in the space's primary", async () => {
    const { spaceId, folder, parentId } = await boot();
    await app.agentRuns.run({ sessionId: parentId, spaceId }, { goal: "go" });
    const child = childOf(spaceId, parentId);
    expect(child.cwd).toBe(folder);
    expect(child.environmentId).toBe(new EnvironmentsStore(app.db).ensurePrimary(spaceId).id);
  });
});

describe("cancellation, budgets, and the one-run rule", () => {
  it("interrupting the PARENT cancels the run and interrupts the child, returning whatever partial text exists", async () => {
    const { spaceId, parentId } = await boot({ script: longScript(60), delayMs: 50 });
    const running = app.agentRuns.run({ sessionId: parentId, spaceId }, { goal: "go" });
    await waitFor(() => app.sessions.list(spaceId).length === 2);
    const child = childOf(spaceId, parentId);
    await waitFor(() => app.sessions.get(child.id).status === "running");
    await app.sessions.interrupt(parentId);
    const result = await running;
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("delegating session was interrupted");
    expect(text(result)).toContain("Partial output");
    expect(text(result)).toContain('"status":"cancelled"');
    await waitFor(() => app.sessions.get(child.id).status === "idle");
  });

  it("a run that exceeds its budget is reported as timed out (with partial text) and the child is interrupted", async () => {
    const { spaceId, parentId } = await boot({ script: longScript(60), delayMs: 50, timeouts: { baseMs: 400, perTurnMs: 0, pollMs: 20 } });
    const result = await app.agentRuns.run({ sessionId: parentId, spaceId }, { goal: "go" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("timed out");
    expect(text(result)).toContain("Partial output");
    const child = childOf(spaceId, parentId);
    await waitFor(() => app.sessions.get(child.id).status === "idle");
  });

  it("timeoutMs overrides the maxTurns scaling wholesale", async () => {
    const { spaceId, parentId } = await boot({ script: longScript(400), delayMs: 50, timeouts: { baseMs: 60_000, perTurnMs: 60_000, pollMs: 20 } });
    const result = await app.agentRuns.run({ sessionId: parentId, spaceId }, { goal: "go", constraints: { timeoutMs: 5_000 } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("timed out");
  }, 15_000);

  it("one delegated run per parent — across BOTH tools (shared engine)", async () => {
    const { spaceId, parentId } = await boot({ script: longScript(60), delayMs: 50 });
    const first = app.agentRuns.run({ sessionId: parentId, spaceId }, { goal: "go" });
    await waitFor(() => app.sessions.list(spaceId).length === 2);
    const secondAgent = await app.agentRuns.run({ sessionId: parentId, spaceId }, { goal: "another" });
    expect(secondAgent.isError).toBe(true);
    expect(text(secondAgent)).toContain("already has a delegated run in flight");
    const secondBrowser = await app.browserAgents.run({ sessionId: parentId, spaceId }, { goal: "browse too" });
    expect(secondBrowser.isError).toBe(true);
    expect(text(secondBrowser)).toContain("already has a browser agent running");
    await app.sessions.interrupt(parentId);
    await first;
  });
});
