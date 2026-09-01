import { describe, expect, it, afterEach } from "vitest";
import WebSocket from "ws";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAdapter, type AgentHandle, type StartOptions, type FakeScript } from "@realm/adapters";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createApp, type App } from "../app";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { waitFor } from "../test-utils";
import { createRealmAgentProvider, RUN_TOOL_NAME } from "./browser-agent";

/**
 * Plan 11 W5 behaviour suite — the browser-agent delegation feature, driven through the REAL app
 * (`createApp` + FakeAdapter): a real SessionService, real gateway, real settings persistence. The
 * named mutants this suite exists to kill:
 *
 *   - bypass inherited by the child            → "bypassPermissions is never inherited"
 *   - recursion guard dropped                  → "recursion guard" (+ the gateway suite's toolset tests)
 *   - child toolset containing user MCP servers → gateway.test.ts "per-session toolset restriction"
 *   - settle-wait returning before the turn ends → "the settle wait holds until the turn ends"
 *   - parent interrupt not cancelling the child → "interrupting the parent cancels the run"
 *   - playbook skill absent from the child      → "the child starts with the browsing playbook staged"
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

/** The child's one message begins "You are a delegated browser agent." — the script keys on that. */
const CHILD_SCRIPT: FakeScript = [{ on: "delegated browser agent", emit: [
  { kind: "text", text: "partial: looking at the page" },
  { kind: "text", text: "FINAL: clicked the button, count is 1" },
] }];

const longScript = (steps: number): FakeScript => [{ on: "delegated browser agent", emit: [
  { kind: "text", text: "partial: starting" },
  ...Array.from({ length: steps }, (_, i) => ({ kind: "text" as const, text: `step ${i}` })),
] }];

async function boot(opts: {
  script?: FakeScript; delayMs?: number;
  parentKind?: "fake" | "claude"; parentMode?: string; fallbackKind?: "fake" | "claude";
  timeouts?: { baseMs: number; perActMs: number; pollMs: number };
} = {}) {
  const home = mkdtempSync(join(tmpdir(), "realm-ba-"));
  const fake = new CaptureFake({ script: opts.script ?? CHILD_SCRIPT, delayMs: opts.delayMs ?? 5 });
  // The same fake serves BOTH registry keys: "claude" here is a stand-in whose only job is to be a
  // kind with AGENT_SKILL_SUPPORT "injected", so kind-selection and skills staging are testable
  // without the real CLI (the live check covers that end).
  app = await createApp({
    home, port: 0, adapters: { fake, claude: fake },
    browserAgent: { fallbackKind: opts.fallbackKind ?? "fake", timeouts: opts.timeouts ?? { baseMs: 5000, perActMs: 0, pollMs: 20 } },
  });
  const profile = new ProfilesStore(app.db).create({ name: "P", icon: "x", color: "#000" });
  const space = new SpacesStore(app.db, home).create({ profileId: profile.id, name: "S", icon: "folder" });
  const parent = app.sessions.create({ spaceId: space.id, agentKind: opts.parentKind ?? "fake", projectId: null, model: null, effort: null, permissionMode: opts.parentMode ?? "default" });
  return { home, fake, spaceId: space.id, parentId: parent.session.id };
}

const text = (r: CallToolResult): string =>
  r.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n");

const childOf = (spaceId: string, parentId: string) => {
  const others = app.sessions.list(spaceId).filter((s) => s.id !== parentId);
  expect(others).toHaveLength(1);
  return others[0]!;
};

describe("browser_agent_run — the delegated session", () => {
  it("creates a real, visible child session in the caller's space and returns its fenced final report + identity", async () => {
    const { spaceId, parentId } = await boot();
    const result = await app.browserAgents.run({ sessionId: parentId, spaceId }, { goal: "Count the buttons on the test page" });
    expect(result.isError).toBe(false);
    const child = childOf(spaceId, parentId);
    expect(child.spaceId).toBe(spaceId);
    expect(child.title).toContain("Browser agent");
    const out = text(result);
    expect(out).toContain(child.id);           // the parent's transcript can link the trace
    expect(out).toContain(child.title);
    expect(out).toContain("FINAL: clicked the button, count is 1");
    expect(out).toMatch(/agent-output-[0-9a-f]{16}/); // fenced, attributed as a subagent's report
    expect(out).toContain("DELEGATED BROWSER AGENT");
  });

  it("holds the settle wait until the turn actually ends — the report is the LAST assistant text and the child is idle", async () => {
    const { spaceId, parentId } = await boot({ delayMs: 40 }); // two texts, 40ms apart: an early return grabs the wrong one
    const result = await app.browserAgents.run({ sessionId: parentId, spaceId }, { goal: "go" });
    const child = childOf(spaceId, parentId);
    // At the moment the run resolved, the child's turn was OVER — not merely started.
    expect(app.sessions.get(child.id).status).toBe("idle");
    expect(text(result)).toContain("FINAL: clicked the button, count is 1");
    expect(result.isError).toBe(false);
  });

  it("NEVER inherits bypassPermissions — a bypass parent's child runs default (the safety line)", async () => {
    const { spaceId, parentId } = await boot({ parentMode: "bypassPermissions" });
    await app.browserAgents.run({ sessionId: parentId, spaceId }, { goal: "go" });
    expect(childOf(spaceId, parentId).permissionMode).toBe("default");
  });

  it("carries every other permission mode over unchanged", async () => {
    const { spaceId, parentId } = await boot({ parentMode: "acceptEdits" });
    await app.browserAgents.run({ sessionId: parentId, spaceId }, { goal: "go" });
    expect(childOf(spaceId, parentId).permissionMode).toBe("acceptEdits");
  });

  it("keeps the caller's agent kind when that kind takes skills injection", async () => {
    const { spaceId, parentId } = await boot({ parentKind: "claude" });
    await app.browserAgents.run({ sessionId: parentId, spaceId }, { goal: "go" });
    expect(childOf(spaceId, parentId).agentKind).toBe("claude");
  });

  it("falls back for a parent kind with no injection route", async () => {
    const { spaceId, parentId } = await boot({ parentKind: "fake", fallbackKind: "claude" });
    await app.browserAgents.run({ sessionId: parentId, spaceId }, { goal: "go" });
    expect(childOf(spaceId, parentId).agentKind).toBe("claude");
  });

  it("refuses malformed arguments without creating anything", async () => {
    const { spaceId, parentId } = await boot();
    const result = await app.browserAgents.run({ sessionId: parentId, spaceId }, {});
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("invalid arguments");
    expect(app.sessions.list(spaceId)).toHaveLength(1);
  });
});

describe("recursion guard — depth-1, enforced server-side", () => {
  it("a child cannot run browser_agent_run, lists no realm-agent tools, and its gateway toolset is realm-browser only", async () => {
    const { spaceId, parentId } = await boot();
    await app.browserAgents.run({ sessionId: parentId, spaceId }, { goal: "go" });
    const child = childOf(spaceId, parentId);

    // The gateway seam: the child's whole toolset is the realm-browser provider — realm-agent (and
    // every user MCP server; see gateway.test.ts) is unroutable for it. The parent is unrestricted.
    expect(app.browserAgents.sessionToolset(child.id)).toEqual(["realm-browser"]);
    expect(app.browserAgents.sessionToolset(parentId)).toBeNull();

    // The provider's own belt, independent of the toolset restriction:
    const provider = createRealmAgentProvider(app.browserAgents, { providerEnabled: () => true });
    expect(await provider.tools({ sessionId: child.id, spaceId })).toEqual([]);
    expect((await provider.tools({ sessionId: parentId, spaceId })).map((t) => t.name)).toEqual([RUN_TOOL_NAME]);
    const refused = await provider.call({ sessionId: child.id, spaceId }, RUN_TOOL_NAME, { goal: "spawn another" });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("depth-1");
    // No grandchild session appeared.
    expect(app.sessions.list(spaceId)).toHaveLength(2);
  });
});

describe("cancellation and budgets", () => {
  it("interrupting the PARENT cancels the run and interrupts the child, returning whatever partial text exists", async () => {
    const { spaceId, parentId } = await boot({ script: longScript(60), delayMs: 50 });
    const running = app.browserAgents.run({ sessionId: parentId, spaceId }, { goal: "go" });
    await waitFor(() => app.sessions.list(spaceId).length === 2);
    const child = childOf(spaceId, parentId);
    await waitFor(() => app.sessions.get(child.id).status === "running");
    await app.sessions.interrupt(parentId);
    const result = await running;
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("delegating session was interrupted");
    expect(text(result)).toContain("Partial output");
    // The child was interrupted too — its turn winds down to idle instead of running to the end.
    await waitFor(() => app.sessions.get(child.id).status === "idle");
  });

  it("cancellation wins even when the child settles to idle inside the same poll window (live-found)", async () => {
    // A coarse poll (400ms) + a child that winds down fast (delay 10) reproduces the live race: by
    // the poll after the interrupt, the child is ALREADY idle with assistant text — a drain that
    // checks settled-first would mislabel the cancelled run as a clean finish.
    const { spaceId, parentId } = await boot({ script: longScript(200), delayMs: 10, timeouts: { baseMs: 30_000, perActMs: 0, pollMs: 400 } });
    const running = app.browserAgents.run({ sessionId: parentId, spaceId }, { goal: "go" });
    await waitFor(() => app.sessions.list(spaceId).length === 2);
    const child = childOf(spaceId, parentId);
    await waitFor(() => app.sessions.get(child.id).status === "running");
    await app.sessions.interrupt(parentId);
    await waitFor(() => app.sessions.get(child.id).status === "idle");
    const result = await running;
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("delegating session was interrupted");
  });

  it("a run that exceeds its settle budget is reported as timed out (with partial text) and the child is interrupted", async () => {
    const { spaceId, parentId } = await boot({ script: longScript(60), delayMs: 50, timeouts: { baseMs: 400, perActMs: 0, pollMs: 20 } });
    const result = await app.browserAgents.run({ sessionId: parentId, spaceId }, { goal: "go" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("timed out");
    expect(text(result)).toContain("Partial output");
    const child = childOf(spaceId, parentId);
    await waitFor(() => app.sessions.get(child.id).status === "idle");
  });

  it("one delegated run per parent at a time", async () => {
    const { spaceId, parentId } = await boot({ script: longScript(60), delayMs: 50 });
    const first = app.browserAgents.run({ sessionId: parentId, spaceId }, { goal: "go" });
    await waitFor(() => app.sessions.list(spaceId).length === 2);
    const second = await app.browserAgents.run({ sessionId: parentId, spaceId }, { goal: "another" });
    expect(second.isError).toBe(true);
    expect(text(second)).toContain("already has a browser agent running");
    await app.sessions.interrupt(parentId);
    await first;
  });

  it("constraints.allowedOrigins narrows the CHILD's open/navigate targets — and only the child's", async () => {
    const { spaceId, parentId } = await boot();
    await app.browserAgents.run({ sessionId: parentId, spaceId }, { goal: "go", constraints: { allowedOrigins: ["http://127.0.0.1:8799"] } });
    const child = childOf(spaceId, parentId);
    expect(app.browserAgents.checkMutation(child.id, "browser_open", "http://127.0.0.1:8799/page")).toBeNull();
    expect(app.browserAgents.checkMutation(child.id, "browser_navigate", "https://evil.example/steal")).toContain("outside this browser agent's allowed origins");
    // A non-child session is never constrained by someone else's run.
    expect(app.browserAgents.checkMutation(parentId, "browser_open", "https://evil.example/")).toBeNull();
  });

  it("maxActs bounds the child's ATTEMPTED mutations", async () => {
    const { spaceId, parentId } = await boot();
    await app.browserAgents.run({ sessionId: parentId, spaceId }, { goal: "go", constraints: { maxActs: 2 } });
    const child = childOf(spaceId, parentId);
    expect(app.browserAgents.checkMutation(child.id, "browser_act")).toBeNull();
    expect(app.browserAgents.checkMutation(child.id, "browser_act")).toBeNull();
    expect(app.browserAgents.checkMutation(child.id, "browser_act")).toContain("maxActs");
  });
});

describe("specialization through existing seams", () => {
  it("stages the browsing playbook skill into the child's injection and puts the policy preamble in its systemContext", async () => {
    const { fake, spaceId, parentId } = await boot({ parentKind: "claude" });
    await app.browserAgents.run({ sessionId: parentId, spaceId }, { goal: "Count the buttons on example.test" });
    // The only adapter start in this test is the CHILD's (the parent never received a message).
    expect(fake.seen).toHaveLength(1);
    const started = fake.seen[0]!;
    // Plan 8's skills injection carried the bundled playbook (installed by createApp on boot).
    expect(started.skills).toBeDefined();
    expect(readdirSync(started.skills!.root)).toContain("browsing");
    // The memory seam carried the browsing policy, goal included.
    expect(started.systemContext).toContain("Delegated browser agent");
    expect(started.systemContext).toContain("Count the buttons on example.test");
    expect(started.systemContext).toContain("password fields");
    expect(started.permissionMode).toBe("default");
  });

  it("broadcasts session.agentOpened with the child's id and item — the renderer's open-into-layout signal", async () => {
    const { spaceId, parentId } = await boot();
    const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${app.port}`); w.once("open", () => res(w)); w.once("error", rej); });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const events: any[] = [];
    ws.on("message", (d) => { const m = JSON.parse(d.toString()); if (!("id" in m)) events.push(m); });
    await app.browserAgents.run({ sessionId: parentId, spaceId }, { goal: "go" });
    const child = childOf(spaceId, parentId);
    await waitFor(() => events.some((e) => e.event === "session.agentOpened"));
    const opened = events.find((e) => e.event === "session.agentOpened")!;
    expect(opened.payload).toMatchObject({ spaceId, sessionId: child.id });
    expect(opened.payload.itemId).toBeTruthy();
    ws.close();
  });

  it("the child's record — and with it the toolset restriction — survives a server restart", async () => {
    const { home, spaceId, parentId } = await boot();
    await app.browserAgents.run({ sessionId: parentId, spaceId }, { goal: "go" });
    const childId = childOf(spaceId, parentId).id;
    await app.close();
    app = await createApp({ home, port: 0, adapters: { fake: new FakeAdapter({ script: [] }) } });
    expect(app.browserAgents.isChild(childId)).toBe(true);
    expect(app.browserAgents.sessionToolset(childId)).toEqual(["realm-browser"]);
  });

  it("deleting the child session forgets its record — the restriction dies with it", async () => {
    const { spaceId, parentId } = await boot();
    await app.browserAgents.run({ sessionId: parentId, spaceId }, { goal: "go" });
    const childId = childOf(spaceId, parentId).id;
    await app.sessions.delete(childId);
    expect(app.browserAgents.isChild(childId)).toBe(false);
    expect(app.browserAgents.sessionToolset(childId)).toBeNull();
  });
});
