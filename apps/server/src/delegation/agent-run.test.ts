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
import { SettingsStore } from "../store/settings";
import { waitFor } from "../test-utils";
import { createRealmAgentProvider, RUN_TOOL_NAME } from "../browsers/browser-agent";
import { AGENT_RUN_TOOL_NAME, AGENT_START_TOOL_NAME, AGENT_STATUS_TOOL_NAME, AGENT_WAIT_TOOL_NAME } from "./agent-run";

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
  maxDepth?: number; caps?: { perParent?: number; total?: number };
} = {}) {
  const home = mkdtempSync(join(tmpdir(), "realm-ar-"));
  const fake = new CaptureFake({ script: opts.script ?? CHILD_SCRIPT, delayMs: opts.delayMs ?? 5 });
  // The same fake serves BOTH registry keys — "claude" is the stand-in kind with skills injection,
  // exactly the arrangement browser-agent.test.ts uses.
  app = await createApp({
    home, port: 0, adapters: { fake, claude: fake },
    browserAgent: { fallbackKind: "fake", timeouts: { baseMs: 5000, perActMs: 0, pollMs: 20 } },
    agentRun: { timeouts: opts.timeouts ?? { baseMs: 5000, perTurnMs: 0, pollMs: 20 }, maxDepth: opts.maxDepth, caps: opts.caps },
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
    // The preamble states the REMAINING budget, not a flat prohibition. A depth-1 child under the
    // default max of 2 has one level left, and telling it otherwise would cost the whole budget.
    expect(started.systemContext).toContain("only 1 level deeper");
    expect(started.systemContext).toContain("depth 1 of 2");
  });

  it("tells a child that has SPENT the budget it cannot delegate — the preamble tracks depth", async () => {
    const { fake, spaceId, parentId } = await boot({ parentKind: "claude", maxDepth: 1 });
    await app.agentRuns.run({ sessionId: parentId, spaceId }, { goal: "Refactor the parser" });
    // THE MUTANT: hard-code the "you may delegate" branch and a depth-1 child under maxDepth 1 is
    // told it may spawn agents that every server-side guard will then refuse.
    expect(fake.seen[0]!.systemContext).toContain("cannot delegate further");
    expect(fake.seen[0]!.systemContext).not.toContain("levels deeper");
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

describe("the depth budget — a wall replaced by a countdown, enforced server-side", () => {
  it("a SPENT child lists no realm-agent tools and is refused by all three layers", async () => {
    // maxDepth 1 makes the first child a spent one, which is exactly the old depth-1 rule — so this
    // is the original recursion-guard test, re-pinned at the budget's edge instead of at depth 1.
    const { spaceId, parentId } = await boot({ maxDepth: 1 });
    await app.agentRuns.run({ sessionId: parentId, spaceId }, { goal: "go" });
    const child = childOf(spaceId, parentId);

    // The child is registered — the seam app.ts's gateway closure turns into { exclude: ["realm-agent"] }.
    expect(app.agentRuns.isChild(child.id)).toBe(true);
    expect(app.agentRuns.isChild(parentId)).toBe(false);
    expect(app.agentRuns.canDelegate(child.id)).toBe(false);
    // NOT the browser child's only-mode restriction: the agent child keeps the full surface.
    expect(app.browserAgents.sessionToolset(child.id)).toBeNull();

    // The provider's own belt, independent of the gateway toolset shape:
    const provider = createRealmAgentProvider(app.browserAgents, { providerEnabled: () => true }, app.agentRuns);
    expect(await provider.tools({ sessionId: child.id, spaceId })).toEqual([]);
    expect((await provider.tools({ sessionId: parentId, spaceId })).map((t) => t.name))
      .toEqual([RUN_TOOL_NAME, AGENT_RUN_TOOL_NAME, AGENT_START_TOOL_NAME, AGENT_WAIT_TOOL_NAME, AGENT_STATUS_TOOL_NAME]);
    for (const tool of [AGENT_RUN_TOOL_NAME, AGENT_START_TOOL_NAME, RUN_TOOL_NAME]) {
      const refused = await provider.call({ sessionId: child.id, spaceId }, tool, { goal: "spawn another" });
      expect(refused.isError).toBe(true);
      expect(text(refused)).toContain("depth-1");
    }
    // The service's innermost check, even if both outer layers were lost:
    for (const spawn of [app.agentRuns.run, app.agentRuns.start]) {
      const direct = await spawn.call(app.agentRuns, { sessionId: child.id, spaceId }, { goal: "spawn another" });
      expect(direct.isError).toBe(true);
      expect(text(direct)).toContain("maximum delegation depth");
    }
    // No grandchild session appeared.
    expect(app.sessions.list(spaceId)).toHaveLength(2);
  });

  it("a child WITH budget may delegate — and its grandchild, now spent, may not", async () => {
    // THE MUTANT this kills: keep the flat `isChild` refusal in spawn() and the budget is decorative —
    // every child is still a leaf, and MAX_DELEGATION_DEPTH means nothing.
    const { spaceId, parentId } = await boot({ maxDepth: 2 });
    await app.agentRuns.run({ sessionId: parentId, spaceId }, { goal: "level one" });
    const child = childOf(spaceId, parentId);
    expect(app.agentRuns.depthOf(child.id)).toBe(1);
    expect(app.agentRuns.canDelegate(child.id)).toBe(true);

    const grand = await app.agentRuns.run({ sessionId: child.id, spaceId }, { goal: "level two" });
    expect(grand.isError).toBe(false);
    const grandchild = app.sessions.list(spaceId).find((x) => x.id !== parentId && x.id !== child.id)!;
    expect(grandchild.dispatchedBy).toEqual({ sessionId: child.id, kind: "agent_run" });
    expect(app.agentRuns.depthOf(grandchild.id)).toBe(2);
    expect(app.agentRuns.canDelegate(grandchild.id)).toBe(false);

    const greatGrand = await app.agentRuns.run({ sessionId: grandchild.id, spaceId }, { goal: "level three" });
    expect(greatGrand.isError).toBe(true);
    expect(text(greatGrand)).toContain("maximum delegation depth");
    expect(app.sessions.list(spaceId)).toHaveLength(3);
  });

  it("a budgeted child gets the agent_run family and NOTHING else — no browser agent, no review, no peer questions", async () => {
    // The budget buys delegation, not the whole delegating surface: browser agents, reviews and
    // interjections all assume the caller is the human's own session.
    const { spaceId, parentId } = await boot({ maxDepth: 2 });
    await app.agentRuns.run({ sessionId: parentId, spaceId }, { goal: "go" });
    const child = childOf(spaceId, parentId);
    const provider = createRealmAgentProvider(app.browserAgents, { providerEnabled: () => true }, app.agentRuns);
    expect((await provider.tools({ sessionId: child.id, spaceId })).map((t) => t.name))
      .toEqual([AGENT_RUN_TOOL_NAME, AGENT_START_TOOL_NAME, AGENT_WAIT_TOOL_NAME, AGENT_STATUS_TOOL_NAME]);
    const refused = await provider.call({ sessionId: child.id, spaceId }, RUN_TOOL_NAME, { goal: "browse" });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("the delegating session's to open");
    // And the gateway keeps the provider visible for it — the closure must not exclude a budgeted child.
    expect(app.sessions.list(spaceId)).toHaveLength(2);
  });

  it("a persisted record with no depth field reads as depth 1 — never as a root with a fresh budget", async () => {
    // Records written before the budget existed. THE MUTANT: default the missing field to 0, and every
    // pre-existing child silently becomes a root that can delegate MAX_DELEGATION_DEPTH levels again.
    const { spaceId, parentId } = await boot({ maxDepth: 1 });
    await app.agentRuns.run({ sessionId: parentId, spaceId }, { goal: "go" });
    const child = childOf(spaceId, parentId);
    const key = `agentRun.child:${child.id}`;
    const settings = new SettingsStore(app.db);
    const stored = settings.get(key) as Record<string, unknown>;
    delete stored.depth;
    settings.set(key, stored);
    expect(app.agentRuns.depthOf(child.id)).toBe(1);
    expect(app.agentRuns.canDelegate(child.id)).toBe(false);
  });

  it("through the REAL gateway, a SPENT child's tools/list has the full surface minus realm-agent — app.ts's closure, not a stub", async () => {
    const { spaceId, parentId } = await boot({ maxDepth: 1 });
    await app.agentRuns.run({ sessionId: parentId, spaceId }, { goal: "go" });
    const child = childOf(spaceId, parentId);
    const connectAs = async (sessionId: string): Promise<Client> => {
      const cfg = app.gateway.register(sessionId, spaceId) as Extract<McpServerConfig, { url: string }>;
      const client = new Client({ name: "t", version: "1.0.0" }, { capabilities: {} });
      await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } }));
      return client;
    };
    const asChild = await connectAs(child.id);
    const childTools = (await asChild.listTools()).tools.map((t) => t.name);
    expect(childTools.some((n) => n.startsWith("realm-agent__"))).toBe(false);   // the recursion mutant
    expect(childTools.some((n) => n.startsWith("realm-browser__"))).toBe(true);  // the normal surface stays
    // The GATEWAY layer must refuse the call itself — its exclude-mode block, distinguishable from
    // the provider's own belt ("may not delegate further"): if this wording is missing, the app.ts
    // closure stopped excluding and only the inner layers caught it.
    const blocked = (await asChild.callTool({ name: `realm-agent__${AGENT_RUN_TOOL_NAME}`, arguments: { goal: "grandchild" } })) as CallToolResult;
    expect(blocked.isError).toBe(true);
    expect(text(blocked)).toContain("not available to this delegated session");
    await asChild.close();
    const asParent = await connectAs(parentId);
    const parentTools = (await asParent.listTools()).tools.map((t) => t.name);
    await asParent.close();
    expect(parentTools).toContain(`realm-agent__${AGENT_RUN_TOOL_NAME}`);
    expect(parentTools).toContain(`realm-agent__${AGENT_START_TOOL_NAME}`);
    expect(parentTools).toContain(`realm-agent__${RUN_TOOL_NAME}`);
  });

  it("through the REAL gateway, a BUDGETED child keeps realm-agent but sees only the agent_run family", async () => {
    // The other half of app.ts's closure: `spentChild` must be a DEPTH question, not `isChild`. THE
    // MUTANT: leave the old `agentRuns?.isChild(...)` there and a budgeted child loses the provider
    // at the gateway, so the whole budget is unreachable no matter what the service allows.
    const { spaceId, parentId } = await boot({ maxDepth: 2 });
    await app.agentRuns.run({ sessionId: parentId, spaceId }, { goal: "go" });
    const child = childOf(spaceId, parentId);
    const cfg = app.gateway.register(child.id, spaceId) as Extract<McpServerConfig, { url: string }>;
    const client = new Client({ name: "t", version: "1.0.0" }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } }));
    const names = (await client.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith("realm-agent__"));
    await client.close();
    expect(names).toEqual([AGENT_RUN_TOOL_NAME, AGENT_START_TOOL_NAME, AGENT_WAIT_TOOL_NAME, AGENT_STATUS_TOOL_NAME].map((n) => `realm-agent__${n}`));
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
    // The SERVICE's own guard, not the store's backstop wording — both write paths must refuse.
    expect(text(result)).toContain("runs only in its caller's own space");
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

  it("a parent BLOCKED in agent_run still cannot open a browser agent — hasRun's meaning is unchanged", async () => {
    // The pre-parallel invariant, kept exactly: `hasRun` means "blocked inside a delegation call",
    // and a blocking agent_run is still that. Its wording predates the engine and must not drift.
    const { spaceId, parentId } = await boot({ script: longScript(60), delayMs: 50 });
    const first = app.agentRuns.run({ sessionId: parentId, spaceId }, { goal: "go" });
    await waitFor(() => app.sessions.list(spaceId).length === 2);
    const secondBrowser = await app.browserAgents.run({ sessionId: parentId, spaceId }, { goal: "browse too" });
    expect(secondBrowser.isError).toBe(true);
    expect(text(secondBrowser)).toContain("already has a browser agent running");
    await app.sessions.interrupt(parentId);
    await first;
  });

  it("refuses a spawn past the per-session cap, and the refusal names the way out", async () => {
    const { spaceId, parentId } = await boot({ script: longScript(60), delayMs: 50, caps: { perParent: 2 } });
    for (let i = 0; i < 2; i += 1) {
      const r = await app.agentRuns.start({ sessionId: parentId, spaceId }, { goal: `task ${i}` });
      expect(r.isError).toBe(false);
    }
    // THE MUTANT: drop `atCapacity` from spawn() and a loop of agent_start calls opens one agent
    // process per iteration until the machine gives out.
    const over = await app.agentRuns.start({ sessionId: parentId, spaceId }, { goal: "one too many" });
    expect(over.isError).toBe(true);
    expect(text(over)).toContain("2 delegated agents running");
    expect(text(over)).toContain(AGENT_WAIT_TOOL_NAME);
    expect(app.sessions.list(spaceId)).toHaveLength(3); // parent + 2 — the refused one created nothing
    await app.sessions.interrupt(parentId);
  });

  it("refuses past the MACHINE-wide cap even when no single parent is over its own", async () => {
    // The guard that makes the depth budget safe: per-parent caps alone do not bound a tree.
    const { spaceId, parentId, profileId, spacesStore } = await boot({ script: longScript(60), delayMs: 50, caps: { perParent: 3, total: 2 } });
    const otherSpace = spacesStore.create({ profileId, name: "S2", icon: "folder" });
    const otherParent = app.sessions.create({ spaceId: otherSpace.id, agentKind: "fake", projectId: null, model: null, effort: null, permissionMode: "default" });
    expect((await app.agentRuns.start({ sessionId: parentId, spaceId }, { goal: "a" })).isError).toBe(false);
    expect((await app.agentRuns.start({ sessionId: parentId, spaceId }, { goal: "b" })).isError).toBe(false);
    const over = await app.agentRuns.start({ sessionId: otherParent.session.id, spaceId: otherSpace.id }, { goal: "c" });
    expect(over.isError).toBe(true);
    expect(text(over)).toContain("machine-wide cap");
    await app.sessions.interrupt(parentId);
  });
});

/**
 * Parallel delegation — the point of the whole change. Every test here would pass trivially against
 * the old one-blocking-run-per-parent shape EXCEPT the first, which is why the wall-clock assertion is
 * the one that matters: a `agent_start` that secretly blocks satisfies every other expectation in this
 * block, and only elapsed time tells you.
 */
describe("agent_start / agent_wait — several agents at once", () => {
  it("runs children CONCURRENTLY — three starts finish in about one child's time, not three", async () => {
    // Each child emits two chunks at 300ms apiece, so one child is ~600ms of work. Sequential would
    // be ~1800ms. THE MUTANT: make `start` await `run.settled` (i.e. quietly re-block) and the elapsed
    // time crosses 1500ms while every other assertion in this file still passes.
    const { spaceId, parentId } = await boot({ delayMs: 300, caps: { perParent: 4 } });
    const t0 = Date.now();
    const handles: string[] = [];
    for (const goal of ["one", "two", "three"]) {
      const r = await app.agentRuns.start({ sessionId: parentId, spaceId }, { goal });
      expect(r.isError).toBe(false);
      handles.push(handleIn(text(r)));
    }
    const startedBy = Date.now() - t0;
    expect(startedBy).toBeLessThan(600); // starting is not waiting

    const collected = await app.agentRuns.wait({ sessionId: parentId, spaceId }, { handles });
    const elapsed = Date.now() - t0;
    expect(collected.isError).toBe(false);
    expect(elapsed).toBeLessThan(1500);
    // All three reports came back, each attributed to its own child.
    for (const h of handles) expect(text(collected)).toContain(h);
    expect(text(collected)).toContain("All 3 delegated agents finished");
    expect(text(collected).match(/FINAL: wrote the file, all done/g)).toHaveLength(3);
    expect(app.sessions.list(spaceId)).toHaveLength(4); // parent + 3
  }, 20_000);

  it("collects an already-finished agent instantly, and SPENDS the handle", async () => {
    const { spaceId, parentId } = await boot();
    const started = await app.agentRuns.start({ sessionId: parentId, spaceId }, { goal: "go" });
    const handle = handleIn(text(started));
    const first = await app.agentRuns.wait({ sessionId: parentId, spaceId }, { handles: [handle] });
    expect(first.isError).toBe(false);
    expect(text(first)).toContain("FINAL: wrote the file, all done");
    // THE MUTANT: leave the run in the registry after reporting it, and a parent that waits twice is
    // handed the same report again — and its capacity slot never comes back.
    const again = await app.agentRuns.wait({ sessionId: parentId, spaceId }, { handles: [handle] });
    expect(again.isError).toBe(true);
    expect(text(again)).toContain("unknown handle");
  });

  it("a wait TIMEOUT gives up on listening — the children keep running and stay collectable", async () => {
    // The distinction that stops a parent from spawning a duplicate of work still in progress.
    const { spaceId, parentId } = await boot({ script: longScript(8), delayMs: 120 });
    const started = await app.agentRuns.start({ sessionId: parentId, spaceId }, { goal: "slow" });
    const handle = handleIn(text(started));
    const early = await app.agentRuns.wait({ sessionId: parentId, spaceId }, { handles: [handle], timeoutMs: 1_000 });
    expect(early.isError).toBe(true);
    expect(text(early)).toContain("STILL RUNNING");
    expect(text(early)).toContain(handle);
    // Still ours, still running, still collectable — the timeout stopped nothing.
    expect(app.sessions.get(handle).status).not.toBe("ended");
    const later = await app.agentRuns.wait({ sessionId: parentId, spaceId }, { handles: [handle], timeoutMs: 20_000 });
    expect(later.isError).toBe(false);
    expect(text(later)).toContain("step 7");
  }, 30_000);

  it('mode "any" returns on the first finisher and leaves the rest collectable', async () => {
    const { spaceId, parentId } = await boot({ delayMs: 5, caps: { perParent: 4 } });
    const fast = handleIn(text(await app.agentRuns.start({ sessionId: parentId, spaceId }, { goal: "fast" })));
    const second = handleIn(text(await app.agentRuns.start({ sessionId: parentId, spaceId }, { goal: "second" })));
    const any = await app.agentRuns.wait({ sessionId: parentId, spaceId }, { handles: [fast, second], mode: "any" });
    expect(any.isError).toBe(false);
    // Whatever came back, the uncollected one is still addressable afterwards.
    const rest = await app.agentRuns.wait({ sessionId: parentId, spaceId }, { timeoutMs: 20_000 });
    expect([any, rest].map((r) => text(r)).join("\n")).toContain(fast);
    expect([any, rest].map((r) => text(r)).join("\n")).toContain(second);
  }, 20_000);

  it("waits for EVERYTHING in flight when no handles are named", async () => {
    const { spaceId, parentId } = await boot({ delayMs: 5, caps: { perParent: 4 } });
    await app.agentRuns.start({ sessionId: parentId, spaceId }, { goal: "a" });
    await app.agentRuns.start({ sessionId: parentId, spaceId }, { goal: "b" });
    const all = await app.agentRuns.wait({ sessionId: parentId, spaceId }, {});
    expect(all.isError).toBe(false);
    expect(text(all)).toContain("All 2 delegated agents finished");
  }, 20_000);

  it("refuses a handle belonging to ANOTHER session — a handle is not a bearer token", async () => {
    const { spaceId, parentId } = await boot({ script: longScript(20), delayMs: 60 });
    const mine = handleIn(text(await app.agentRuns.start({ sessionId: parentId, spaceId }, { goal: "mine" })));
    const stranger = app.sessions.create({ spaceId, agentKind: "fake", projectId: null, model: null, effort: null, permissionMode: "default" });
    const stolen = await app.agentRuns.wait({ sessionId: stranger.session.id, spaceId }, { handles: [mine] });
    expect(stolen.isError).toBe(true);
    expect(text(stolen)).toContain("unknown handle");
    await app.sessions.interrupt(parentId);
  });

  it("agent_status distinguishes running from finished-and-uncollected, and never blocks", async () => {
    const { spaceId, parentId } = await boot({ script: longScript(20), delayMs: 60, caps: { perParent: 4 } });
    expect(text(app.agentRuns.status({ sessionId: parentId, spaceId }))).toContain("No delegated agents");
    const slow = handleIn(text(await app.agentRuns.start({ sessionId: parentId, spaceId }, { goal: "slow one" })));
    const status = app.agentRuns.status({ sessionId: parentId, spaceId });
    expect(status.isError).toBe(false);
    expect(text(status)).toContain(`${slow}: running`);
    expect(text(status)).toContain("1 running, 0 finished");
    await app.sessions.interrupt(parentId);
  });

  it("interrupting the parent cancels EVERY detached child, not just the first", async () => {
    // THE MUTANT: leave `parentInterrupted` reading one run off the map and two of three agents keep
    // running after the human hit stop — ghosts, which is the exact failure that rule exists to prevent.
    const { spaceId, parentId } = await boot({ script: longScript(60), delayMs: 60, caps: { perParent: 3 } });
    const handles = [] as string[];
    for (const goal of ["a", "b", "c"]) handles.push(handleIn(text(await app.agentRuns.start({ sessionId: parentId, spaceId }, { goal }))));
    await app.sessions.interrupt(parentId);
    for (const h of handles) await waitFor(() => app.sessions.get(h).status === "idle");
    const collected = await app.agentRuns.wait({ sessionId: parentId, spaceId }, { handles, timeoutMs: 20_000 });
    expect(text(collected)).toContain("did NOT finish (cancelled)");
    expect(text(collected).match(/did NOT finish \(cancelled\)/g)).toHaveLength(3);
  }, 30_000);

  it("a detached child is invisible to hasRun — the parent is free to browse and to be asked", async () => {
    // Detached means "not blocked". Counting it as blocked would make agent_start strictly worse than
    // agent_run: fire one and the parent loses the browser agent and peer questions for its duration.
    const { spaceId, parentId } = await boot({ script: longScript(20), delayMs: 60 });
    await app.agentRuns.start({ sessionId: parentId, spaceId }, { goal: "detached" });
    const browser = await app.browserAgents.run({ sessionId: parentId, spaceId }, { goal: "browse" });
    expect(text(browser)).not.toContain("already has a browser agent running");
    await app.sessions.interrupt(parentId);
  }, 20_000);
});

/** `agent_start`'s result names the child session id as the handle — the tests read it back out the
 *  same way the delegating agent would. */
function handleIn(result: string): string {
  const m = /Started delegated agent (\S+) \(/.exec(result);
  expect(m, `no handle in: ${result}`).toBeTruthy();
  return m![1]!;
}
