import { describe, expect, it, afterEach } from "vitest";
import WebSocket from "ws";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter, type FakeScript, type McpServerConfig } from "@realm/adapters";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { PLAN_PERMISSION_MODE, reviewResultKey } from "@realm/contracts";
import { createApp, type App } from "../app";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { EnvironmentsStore } from "../store/environments";
import { NotificationsStore } from "../store/notifications";
import { SettingsStore } from "../store/settings";
import { waitFor } from "../test-utils";
import { createRealmAgentProvider } from "../browsers/browser-agent";
import { AGENT_REVIEW_TOOL_NAME } from "./review";

/**
 * Plan 13 W3 behaviour suite — the reviewer recipe, driven through the REAL app (`createApp` +
 * FakeAdapter), the same way agent-run.test.ts drives `agent_run`. The named mutants this suite
 * exists to kill:
 *
 *   - a reviewer child born with write permission     → "hard-capped read-only"
 *   - a reviewer on a kind whose plan mode is a lie   → "kind fallback" (ACP → fallback)
 *   - agent_review recursion (any delegated child)    → "depth-1"
 *   - a second review racing the first                → "one review per environment"
 *   - the verdict not landing / not notifying         → "the verdict lands"
 *   - the review section surviving a ship             → "ship clears" (staleness)
 *   - review→ship wiring                              → structure.test.ts (git-write never imported)
 */

let app: App;
afterEach(async () => { await app?.close(); });

const REVIEW_SCRIPT: FakeScript = [{ on: "You are a review agent.", emit: [
  { kind: "text", text: "partial: reading the diff" },
  { kind: "text", text: "Verdict: refuted — the guard is inverted (src/a.ts:3)" },
] }];

const longScript = (steps: number): FakeScript => [{ on: "You are a review agent.", emit: [
  { kind: "text", text: "partial: starting" },
  ...Array.from({ length: steps }, (_, i) => ({ kind: "text" as const, text: `step ${i}` })),
] }];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
}
function initRepo(dir: string): void {
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", "."); git(dir, "commit", "-m", "init");
}

async function boot(opts: { script?: FakeScript; delayMs?: number; parentKind?: "fake" | "claude" | "acp:cursor"; parentMode?: string;
  timeouts?: { budgetMs: number; pollMs: number } } = {}) {
  const home = tempDir("realm-rv-");
  const fake = new FakeAdapter({ script: opts.script ?? REVIEW_SCRIPT, delayMs: opts.delayMs ?? 5 });
  app = await createApp({
    home, port: 0, adapters: { fake, claude: fake, "acp:cursor": fake },
    browserAgent: { fallbackKind: "fake", timeouts: { baseMs: 5000, perActMs: 0, pollMs: 20 } },
    agentRun: { timeouts: { baseMs: 5000, perTurnMs: 0, pollMs: 20 } },
    review: { fallbackKind: "fake", timeouts: opts.timeouts ?? { budgetMs: 5000, pollMs: 20 } },
  });
  const profile = new ProfilesStore(app.db).create({ name: "P", icon: "x", color: "#000" });
  const space = new SpacesStore(app.db, home).create({ profileId: profile.id, name: "S", icon: "folder" });
  const parent = app.sessions.create({ spaceId: space.id, agentKind: opts.parentKind ?? "fake", projectId: null, model: null, effort: null, permissionMode: opts.parentMode ?? "default" });
  const env = new EnvironmentsStore(app.db).ensurePrimary(space.id);
  return { home, fake, spaceId: space.id, folder: space.folderPath, parentId: parent.session.id, envId: env.id };
}

const text = (r: CallToolResult): string =>
  r.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n");

const reviewerOf = (spaceId: string) =>
  app.sessions.list(spaceId).find((s) => s.dispatchedBy?.kind === "review");

async function wsClient(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: any) => void>(); const events: any[] = [];
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); else events.push(m); });
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<any>((res, rej) => {
    const id = String(++n);
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`rpc ${method} (#${id}) timed out`)); }, 5000);
    pending.set(id, (v) => { clearTimeout(timer); res(v); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { call, events, close: () => ws.close() };
}

describe("the read-only cap — hard, per agent kind (the write-permission mutant)", () => {
  it("a reviewer is born in plan mode even when the requesting parent runs bypassPermissions", async () => {
    const { spaceId, parentId, envId } = await boot({ parentMode: "bypassPermissions" });
    const result = await app.reviews.runTool({ sessionId: parentId, spaceId }, { environmentId: envId });
    expect(result.isError).toBe(false);
    const reviewer = reviewerOf(spaceId)!;
    expect(reviewer.permissionMode).toBe(PLAN_PERMISSION_MODE);
    expect(reviewer.permissionMode).toBe("plan"); // the wire value both capable adapters read
  });

  it("the user's Request review path is plan mode too, with a null parent in the origin", async () => {
    const { spaceId, envId } = await boot();
    app.reviews.request(envId);
    await waitFor(() => reviewerOf(spaceId) !== undefined);
    const reviewer = reviewerOf(spaceId)!;
    expect(reviewer.permissionMode).toBe(PLAN_PERMISSION_MODE);
    expect(reviewer.dispatchedBy).toEqual({ sessionId: null, kind: "review" });
    await waitFor(() => app.reviews.get(envId) !== null);
  });

  it("an ACP parent's reviewer FALLS BACK in kind — plan mode on acp:cursor would be a label with no enforcement", async () => {
    const { spaceId, parentId, envId } = await boot({ parentKind: "acp:cursor" });
    await app.reviews.runTool({ sessionId: parentId, spaceId }, { environmentId: envId });
    const reviewer = reviewerOf(spaceId)!;
    expect(reviewer.agentKind).toBe("fake");        // the harness's fallbackKind — claude in production
    expect(reviewer.agentKind).not.toBe("acp:cursor"); // AcpAdapter.start never reads permissionMode
    expect(reviewer.permissionMode).toBe(PLAN_PERMISSION_MODE);
  });

  it("a plan-capable parent's reviewer keeps the parent's kind", async () => {
    const { spaceId, parentId, envId } = await boot({ parentKind: "fake" });
    await app.reviews.runTool({ sessionId: parentId, spaceId }, { environmentId: envId });
    expect(reviewerOf(spaceId)!.agentKind).toBe("fake");
  });
});

describe("the verdict lands — KV + broadcast + notification, and stops there", () => {
  it("tool path: fenced report to the caller, origin recorded, verdict persisted with the reviewer's identity", async () => {
    const { spaceId, parentId, envId } = await boot();
    const result = await app.reviews.runTool({ sessionId: parentId, spaceId }, { environmentId: envId });
    expect(result.isError).toBe(false);
    const out = text(result);
    expect(out).toContain("Verdict: refuted");
    expect(out).toMatch(/agent-output-[0-9a-f]{16}/);
    expect(out).toContain("REVIEWER'S REPORT");
    expect(out).toContain("informs the HUMAN's ship decision");
    const reviewer = reviewerOf(spaceId)!;
    expect(reviewer.dispatchedBy).toEqual({ sessionId: parentId, kind: "review" });
    expect(reviewer.title).toContain("Review:");
    const review = app.reviews.get(envId)!;
    expect(review.sessionId).toBe(reviewer.id);
    expect(review.outcome).toBe("done");
    expect(review.text).toContain("Verdict: refuted");
    // The reviewer's preamble carried the refutation discipline.
    const events = app.sessions.events(reviewer.id, 0, 100);
    expect(events.some((e) => e.event.type === "user_message" && (e.event.payload as { text: string }).text.includes("You are a review agent."))).toBe(true);
  });

  it("writes ONE review_done notification row — environment-keyed, born acted, honoring the disabled toggle", async () => {
    const { spaceId, envId } = await boot();
    app.reviews.request(envId);
    await waitFor(() => app.reviews.get(envId) !== null);
    const store = new NotificationsStore(app.db);
    const rows = store.list({ cursor: null, limit: 50 }).notifications.filter((n) => n.category === "review_done");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.refId).toBe(envId);
    expect(rows[0]!.spaceId).toBe(spaceId);
    expect(rows[0]!.actedAt).not.toBeNull();
    expect(rows[0]!.title).toContain("finished");
    expect(rows[0]!.body).toContain("Verdict");
    // The default-on toggle: disable the category, review again — no NEW row (dedup aside, the
    // write path is gated). Dismiss first so the second run would otherwise write.
    new SettingsStore(app.db).set("notifications.disabledCategories", ["review_done"]);
    store.markAllRead(); // otherwise the unread row would absorb/reopen rather than create
    app.reviews.dismiss(envId);
    app.reviews.request(envId);
    await waitFor(() => app.reviews.get(envId) !== null);
    const after = store.list({ cursor: null, limit: 50 }).notifications.filter((n) => n.category === "review_done");
    expect(after).toHaveLength(1); // still just the first
  });

  it("over the wire: review.request answers with the reviewer, review.changed broadcasts the verdict, review.get serves it after a 'reload'", async () => {
    const { spaceId, envId } = await boot();
    const c = await wsClient(app.port);
    const res = (await c.call("review.request", { environmentId: envId })).result;
    expect(typeof res.sessionId).toBe("string");
    // The reviewer streams into its own pane — the delegation idiom.
    await waitFor(() => c.events.some((e) => e.event === "session.agentOpened" && e.payload.sessionId === res.sessionId));
    await waitFor(() => c.events.some((e) => e.event === "review.changed" && e.payload.environmentId === envId && e.payload.review !== null));
    const got = (await c.call("review.get", { environmentId: envId })).result;
    expect(got.review.sessionId).toBe(res.sessionId);
    expect(got.review.text).toContain("Verdict");
    expect(reviewerOf(spaceId)!.id).toBe(res.sessionId);
    // Dismiss clears server-side and tells every window.
    await c.call("review.dismiss", { environmentId: envId });
    await waitFor(() => c.events.some((e) => e.event === "review.changed" && e.payload.review === null));
    expect((await c.call("review.get", { environmentId: envId })).result.review).toBeNull();
    c.close();
  });

  it("a SHIP that commits clears the verdict (the staleness mutant); one that commits nothing leaves it", async () => {
    const { folder, envId } = await boot();
    initRepo(folder);
    app.reviews.request(envId);
    await waitFor(() => app.reviews.get(envId) !== null);
    const c = await wsClient(app.port);
    // Nothing staged: the ship reports nothing-to-commit and the verdict — about the still-standing
    // diff — survives.
    const empty = (await c.call("workspace.ship", { cwd: folder, commit: true, message: "x", push: false, openPr: false })).result;
    expect(empty.commit.state).toBe("nothing-to-commit");
    expect(app.reviews.get(envId)).not.toBeNull();
    // A real commit: the reviewed diff no longer exists, so neither may the verdict.
    writeFileSync(join(folder, "a.txt"), "two\n");
    await c.call("workspace.stage", { cwd: folder, paths: ["a.txt"] });
    const shipped = (await c.call("workspace.ship", { cwd: folder, commit: true, message: "ship it", push: false, openPr: false })).result;
    expect(shipped.commit.state).toBe("committed");
    expect(app.reviews.get(envId)).toBeNull();
    await waitFor(() => c.events.some((e) => e.event === "review.changed" && e.payload.environmentId === envId && e.payload.review === null));
    c.close();
  });
});

describe("one review per environment, and the parent's interrupt cancels", () => {
  it("refuses a second review of the same checkout while one is running — from either entry point", async () => {
    const { spaceId, parentId, envId } = await boot({ script: longScript(300), delayMs: 20, timeouts: { budgetMs: 30_000, pollMs: 20 } });
    app.reviews.request(envId);
    await waitFor(() => reviewerOf(spaceId) !== undefined);
    expect(() => app.reviews.request(envId)).toThrowError(/already running/);
    const viaTool = await app.reviews.runTool({ sessionId: parentId, spaceId }, { environmentId: envId });
    expect(viaTool.isError).toBe(true);
    expect(text(viaTool)).toContain("already running");
    await app.sessions.interrupt(reviewerOf(spaceId)!.id); // wind the long run down
    await waitFor(() => app.reviews.get(envId) !== null, { timeout: 20_000 });
  }, 30_000);

  it("interrupting the REQUESTING session cancels the tool-path review — cancelled-wins, partial text", async () => {
    const { spaceId, parentId, envId } = await boot({ script: longScript(300), delayMs: 20, timeouts: { budgetMs: 30_000, pollMs: 20 } });
    const pending = app.reviews.runTool({ sessionId: parentId, spaceId }, { environmentId: envId });
    await waitFor(() => reviewerOf(spaceId) !== undefined);
    await app.sessions.interrupt(parentId);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("cancelled");
  });
});

describe("depth-1 — agent_review is refused to EVERY delegated child (the recursion mutant)", () => {
  it("an agent_run child, and the reviewer itself, cannot call agent_review; the provider lists them nothing", async () => {
    const { spaceId, parentId, envId } = await boot({ script: [
      ...REVIEW_SCRIPT,
      { on: "You are a delegated agent.", emit: [{ kind: "text", text: "FINAL: did the task" }] },
    ] });
    await app.agentRuns.run({ sessionId: parentId, spaceId }, { goal: "task" });
    const agentChild = app.sessions.list(spaceId).find((s) => s.dispatchedBy?.kind === "agent_run")!;
    const viaAgentChild = await app.reviews.runTool({ sessionId: agentChild.id, spaceId }, { environmentId: envId });
    expect(viaAgentChild.isError).toBe(true);
    expect(text(viaAgentChild)).toContain("depth-1");

    await app.reviews.runTool({ sessionId: parentId, spaceId }, { environmentId: envId });
    const reviewer = reviewerOf(spaceId)!;
    expect(app.reviews.isChild(reviewer.id)).toBe(true);
    const viaReviewer = await app.reviews.runTool({ sessionId: reviewer.id, spaceId }, { environmentId: envId });
    expect(viaReviewer.isError).toBe(true);
    expect(text(viaReviewer)).toContain("depth-1");

    // The provider's belt: a reviewer child lists NO realm-agent tools and is refused on call.
    const provider = createRealmAgentProvider(app.browserAgents, { providerEnabled: () => true }, app.agentRuns, app.reviews);
    expect(await provider.tools({ sessionId: reviewer.id, spaceId })).toEqual([]);
    const refused = await provider.call({ sessionId: reviewer.id, spaceId }, AGENT_REVIEW_TOOL_NAME, { environmentId: envId });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("depth-1");
    // A NON-child parent lists agent_review beside the other two.
    const parentTools = (await provider.tools({ sessionId: parentId, spaceId })).map((t) => t.name);
    expect(parentTools).toContain(AGENT_REVIEW_TOOL_NAME);
  });

  it("through the REAL gateway, the reviewer's tools/list is the full surface minus realm-agent — app.ts's closure", async () => {
    const { spaceId, envId } = await boot();
    app.reviews.request(envId);
    // Let the run SETTLE first: registering mid-send races ensureLive's own gateway.register for the
    // same session, and whichever token mints second revokes the other. The child record persists
    // past settle, so the exclusion is still what a live list would see.
    await waitFor(() => app.reviews.get(envId) !== null);
    const reviewer = reviewerOf(spaceId)!;
    const cfg = app.gateway.register(reviewer.id, spaceId) as Extract<McpServerConfig, { url: string }>;
    const client = new Client({ name: "t", version: "1.0.0" }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } }));
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools.some((n) => n.startsWith("realm-agent__"))).toBe(false);  // neither agent tool nor agent_review
    expect(tools.some((n) => n.startsWith("realm-browser__"))).toBe(true); // the normal surface stays
    const blocked = (await client.callTool({ name: `realm-agent__${AGENT_REVIEW_TOOL_NAME}`, arguments: { environmentId: envId } })) as CallToolResult;
    expect(blocked.isError).toBe(true);
    expect(text(blocked)).toContain("not available to this delegated session");
    await client.close();
    await waitFor(() => app.reviews.get(envId) !== null);
  });
});

describe("refusals, restart, release", () => {
  it("refuses a foreign space's environment and a ghost environment, creating NOTHING", async () => {
    const { home, spaceId, parentId } = await boot();
    const profile2 = new ProfilesStore(app.db).create({ name: "Q", icon: "x", color: "#000" });
    const space2 = new SpacesStore(app.db, home).create({ profileId: profile2.id, name: "S2", icon: "folder" });
    const foreignEnv = new EnvironmentsStore(app.db).ensurePrimary(space2.id);
    const foreign = await app.reviews.runTool({ sessionId: parentId, spaceId }, { environmentId: foreignEnv.id });
    expect(foreign.isError).toBe(true);
    expect(text(foreign)).toContain("another space");
    const ghost = await app.reviews.runTool({ sessionId: parentId, spaceId }, { environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" });
    expect(ghost.isError).toBe(true);
    expect(app.sessions.list(spaceId)).toHaveLength(1);
    expect(app.sessions.list(space2.id)).toHaveLength(0);
  });

  it("the reviewer's child record — and the verdict — survive a server restart; deletion forgets the record but keeps the verdict", async () => {
    const { home, spaceId, parentId, envId } = await boot();
    await app.reviews.runTool({ sessionId: parentId, spaceId }, { environmentId: envId });
    const reviewerId = reviewerOf(spaceId)!.id;
    await app.close();
    app = await createApp({ home, port: 0, adapters: { fake: new FakeAdapter({ script: [] }) } });
    expect(app.reviews.isChild(reviewerId)).toBe(true);
    expect(app.reviews.get(envId)).not.toBeNull(); // the reload-keeps-the-verdict half of W3
    await app.sessions.delete(reviewerId);
    expect(app.reviews.isChild(reviewerId)).toBe(false);
    // Log posture: the verdict outlives the reviewer session.
    expect(app.reviews.get(envId)).not.toBeNull();
    // The raw KV round-trips the schema (a corrupt blob would read as null).
    expect(new SettingsStore(app.db).get(reviewResultKey(envId))).not.toBeNull();
  });
});
