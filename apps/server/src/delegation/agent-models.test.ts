import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter, fakeStandIn, type AgentAdapter, type FakeScript, type StartOptions } from "@realm/adapters";
import type { AgentKind, AgentModel } from "@realm/contracts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createApp, type App } from "../app";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { ItemsStore } from "../store/items";
import { waitFor } from "../test-utils";

/**
 * `constraints.model` through the REAL app: a name in a tool call ends as a child session on the
 * harness that runs that model, started with that model's id.
 *
 * The harnesses are stand-ins — the scripted fake behind each real kind's name, probing as that kind
 * with a catalog — because a child that reached real Codex would be a billed turn. Everything between
 * the tool call and the adapter's `start` is the production path.
 */

let app: App;
// Each app is closed once: a test that boots none must not close the last test's again.
afterEach(async () => { vi.useRealTimers(); const closing = app; app = null!; await closing?.close(); });

const CODEX: AgentModel[] = [{ id: "gpt-6-luna", label: "GPT-6 Luna" }, { id: "gpt-6-astra", label: "GPT-6 Astra" }];
const CURSOR: AgentModel[] = [{ id: "claude-fable-5-1", label: "claude-fable-5-1" }, { id: "composer-2", label: "Composer 2" }];

const CHILD: FakeScript = [{ on: "You are a delegated agent.", emit: [{ kind: "text", text: "FINAL: done as asked" }] }];

/** A real agent's name on the fake's body: probes as `kind` with `models`, runs the child script,
 *  and keeps every StartOptions it was handed — the seam the model id is read off. */
function standIn(kind: AgentKind, models: AgentModel[] | null, counts: { probes: number }, script: FakeScript = CHILD) {
  const fake = new FakeAdapter({ script, delayMs: 2 });
  const seen: StartOptions[] = [];
  const adapter: AgentAdapter = {
    kind,
    probe: async () => { counts.probes++; return { kind, available: true, version: "fake", loggedIn: true, reason: null, models }; },
    start: (o) => { seen.push(o); return fake.start(o); },
  };
  return { adapter, seen };
}

async function boot(opts: { parentKind?: AgentKind; parentModel?: string | null; parentMode?: string; leadScript?: FakeScript; cursorScript?: FakeScript } = {}) {
  const counts = { probes: 0 };
  const claude = standIn("claude", null, counts, [...(opts.leadScript ?? []), ...CHILD]);
  const codex = standIn("codex", CODEX, counts);
  const cursor = standIn("acp:cursor", CURSOR, counts, opts.cursorScript);
  app = await createApp({
    home: tempDir("realm-am-"), port: 0,
    adapters: { claude: claude.adapter, codex: codex.adapter, "acp:cursor": cursor.adapter },
    agentRun: { timeouts: { baseMs: 5000, perTurnMs: 0, pollMs: 20 } },
  });
  const profile = new ProfilesStore(app.db).create({ name: "P", icon: "x", color: "#000" });
  const space = new SpacesStore(app.db, tempDir("realm-am-space-")).create({ profileId: profile.id, name: "S", icon: "folder" });
  const parent = app.sessions.create({ spaceId: space.id, agentKind: opts.parentKind ?? "claude", projectId: null,
    model: opts.parentModel ?? null, effort: null, permissionMode: opts.parentMode ?? "default" });
  const ctx = { sessionId: parent.session.id, spaceId: space.id };
  return { ctx, counts, seen: { claude: claude.seen, codex: codex.seen, cursor: cursor.seen } };
}

const text = (r: CallToolResult): string =>
  r.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n");
const children = (ctx: { sessionId: string; spaceId: string }) => app.sessions.list(ctx.spaceId).filter((s) => s.id !== ctx.sessionId);

describe("agent_start with a model by name", () => {
  it("GPT-6 Luna starts a Codex child on gpt-6-luna, and the result says what it runs on", async () => {
    const { ctx, seen } = await boot();
    await app.sessions.probe();
    const r = await app.agentRuns.start(ctx, { goal: "Write the tests", constraints: { model: "GPT-6 Luna" } });
    expect(r.isError).toBe(false);
    const [child] = children(ctx);
    expect(child).toMatchObject({ agentKind: "codex", model: "gpt-6-luna" });
    expect(text(r)).toContain("on Codex · GPT-6 Luna");
    // Mutant: create the child with `model: null` — the row would say Codex and the adapter would
    // run Codex's default, which is a different model from the one asked for.
    await waitFor(() => seen.codex.length === 1);
    expect(seen.codex[0]!.model).toBe("gpt-6-luna");
  });

  it("Fable starts a Claude child on the newest Fable, not Cursor's route to it", async () => {
    const { ctx, seen } = await boot();
    await app.sessions.probe();
    await app.agentRuns.start(ctx, { goal: "Build the toggle", constraints: { model: "Fable" } });
    expect(children(ctx)[0]).toMatchObject({ agentKind: "claude", model: "claude-fable-5-1" });
    await waitFor(() => seen.claude.length === 1);
    expect(seen.cursor).toHaveLength(0);
  });

  it("a name that could mean two models is refused, and nothing is started", async () => {
    const { ctx } = await boot();
    await app.sessions.probe();
    const r = await app.agentRuns.start(ctx, { goal: "go", constraints: { model: "GPT-6" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('"GPT-6" could mean GPT-6 Luna (Codex) or GPT-6 Astra (Codex)');
    expect(children(ctx)).toHaveLength(0);
    expect(app.agentRuns.status(ctx).content[0]).toMatchObject({ text: expect.stringContaining("No delegated agents") });
  });

  it("an unknown name is refused with the names that would work", async () => {
    const { ctx } = await boot();
    await app.sessions.probe();
    const r = await app.agentRuns.run(ctx, { goal: "go", constraints: { model: "GPT-9 Nova" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("- Codex: GPT-6 Luna, GPT-6 Astra");
    expect(children(ctx)).toHaveLength(0);
  });

  it("resolves against a fresh probe when nothing has been probed yet", async () => {
    // Codex's catalog is live-only (no static list), so a cold cache cannot know GPT-6 Luna exists.
    // Mutant: drop the refresh — the first delegation after a launch refuses a model that is right there.
    const { ctx, counts } = await boot();
    const r = await app.agentRuns.start(ctx, { goal: "go", constraints: { model: "GPT-6 Luna" } });
    expect(r.isError).toBe(false);
    expect(children(ctx)[0]!.agentKind).toBe("codex");
    expect(counts.probes).toBeGreaterThan(0);
  });

  it("asks again for an unknown name once the list is old — and only then", async () => {
    // Only the clock is faked: the app's own timers (the settle polls) keep real time.
    vi.useFakeTimers({ toFake: ["Date"] });
    const { ctx, counts } = await boot();
    await app.sessions.probe();
    const after = counts.probes;
    // A recent list is trusted to say a name does not exist. Mutant: re-probe whenever the probe's
    // own 30s TTL has lapsed — every typo would then cost a probe of every agent, half a minute here.
    vi.setSystemTime(Date.now() + 60_000);
    expect((await app.agentRuns.start(ctx, { goal: "go", constraints: { model: "GPT-9 Nova" } })).isError).toBe(true);
    expect(counts.probes).toBe(after);
    vi.setSystemTime(Date.now() + 11 * 60_000);
    expect((await app.agentRuns.start(ctx, { goal: "go", constraints: { model: "GPT-9 Nova" } })).isError).toBe(true);
    expect(counts.probes).toBeGreaterThan(after);
  });

  it("never asks again for an AMBIGUOUS name, however old the list", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { ctx, counts } = await boot();
    await app.sessions.probe();
    const after = counts.probes;
    vi.setSystemTime(Date.now() + 60 * 60_000);
    // Mutant: re-probe on any refusal — "GPT-6" is no less ambiguous for a new list.
    expect(text(await app.agentRuns.start(ctx, { goal: "go", constraints: { model: "GPT-6" } }))).toContain("could mean");
    expect(counts.probes).toBe(after);
  });

  it("a child on another harness takes the lead's mode the same way — Full access under a Full access lead", async () => {
    const { ctx } = await boot({ parentMode: "bypassPermissions" });
    await app.sessions.probe();
    await app.agentRuns.start(ctx, { goal: "go", constraints: { model: "GPT-6 Luna" } });
    expect(children(ctx)[0]).toMatchObject({ agentKind: "codex", permissionMode: "bypassPermissions" });
  });

  it("a named model does not loosen the cap — a request above the lead is held to the lead's mode", async () => {
    const { ctx } = await boot({ parentMode: "default" });
    await app.sessions.probe();
    await app.agentRuns.start(ctx, { goal: "go", constraints: { model: "GPT-6 Luna", permissionMode: "bypassPermissions" } });
    expect(children(ctx)[0]).toMatchObject({ agentKind: "codex", permissionMode: "default" });
  });

  it("refuses a read-only lead's child on Cursor, which Realm cannot hold to read-only — and creates nothing", async () => {
    // The bug this kills: a plan lead naming a Cursor model minted a child whose row said plan while
    // nothing restrained it.
    const { ctx } = await boot({ parentMode: "plan" });
    await app.sessions.probe();
    const r = await app.agentRuns.start(ctx, { goal: "go", constraints: { agentKind: "acp:cursor" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("cannot hold Cursor to a read-only mode");
    expect(children(ctx)).toEqual([]);
  });

  it("a running Cursor child is stopped, and says why, when its lead goes read-only — and kept when the lead goes to Ask each time", async () => {
    // THE MUTANT: skip the stop — the Cursor child keeps editing at default under a lead the person
    // just made read-only, which is the promise the spawn-time refusal exists to keep.
    const long: FakeScript = [{ on: "You are a delegated agent.", emit: Array.from({ length: 200 }, (_, i) => ({ kind: "text" as const, text: `step ${i}` })) }];
    const { ctx } = await boot({ parentMode: "bypassPermissions", cursorScript: long });
    await app.sessions.probe();
    await app.agentRuns.start(ctx, { goal: "go", constraints: { agentKind: "acp:cursor" } });
    const [child] = children(ctx);
    await waitFor(() => app.sessions.get(child!.id).status === "running");

    await app.sessions.setOptions(ctx.sessionId, { permissionMode: "default" });
    expect(text(app.agentRuns.status(ctx))).toContain(`${child!.id}: running`);

    await app.sessions.setOptions(ctx.sessionId, { permissionMode: "plan" });
    const note = "Stopped when the session that started it went to Plan: Realm cannot hold Cursor to a read-only mode.";
    expect(app.agentRuns.record(child!.id)?.stopNote).toBe(note);
    const r = await app.agentRuns.wait(ctx, {});
    expect(text(r)).toContain("did NOT finish (stopped)");
    expect(text(r)).toContain(note);
  }, 20_000);

  it("writes default for a Cursor child of a Full access lead, and says why", async () => {
    const { ctx } = await boot({ parentMode: "bypassPermissions" });
    await app.sessions.probe();
    const r = await app.agentRuns.start(ctx, { goal: "go", constraints: { agentKind: "acp:cursor" } });
    expect(r.isError).toBe(false);
    expect(children(ctx)[0]).toMatchObject({ agentKind: "acp:cursor", permissionMode: "default" });
    expect(text(r)).toContain("Realm cannot set a permission mode on Cursor");
  });
});

describe("no model named", () => {
  it("a child on the lead's own harness runs the lead's own model", async () => {
    // "We should have the main model that it's ran in be an option": the lead on Opus 5.5 hands out
    // work on Opus 5.5. Mutant: leave the child's model null — it runs the harness default instead.
    const { ctx, seen } = await boot({ parentKind: "claude", parentModel: "claude-opus-5-5" });
    const r = await app.agentRuns.start(ctx, { goal: "go" });
    expect(children(ctx)[0]).toMatchObject({ agentKind: "claude", model: "claude-opus-5-5" });
    expect(text(r)).toContain("on Claude · Claude Opus 5.5");
    await waitFor(() => seen.claude.length === 1);
    expect(seen.claude[0]!.model).toBe("claude-opus-5-5");
  });

  it("a child on ANOTHER harness takes that harness's default, never the lead's foreign id", async () => {
    const { ctx } = await boot({ parentKind: "claude", parentModel: "claude-opus-5-5" });
    await app.agentRuns.start(ctx, { goal: "go", constraints: { agentKind: "codex" } });
    expect(children(ctx)[0]).toMatchObject({ agentKind: "codex", model: null });
  });
});

describe("the child's record outlives the run", () => {
  it("keeps when it started, when it settled and how", async () => {
    const { ctx } = await boot();
    await app.sessions.probe();
    const started = await app.agentRuns.start(ctx, { goal: "go", constraints: { model: "GPT-6 Luna" } });
    expect(started.isError).toBe(false);
    const [child] = children(ctx);
    expect(app.agentRuns.record(child!.id)).toMatchObject({ parentSessionId: ctx.sessionId, goal: "go", startedAt: expect.any(Number) });
    const waited = await app.agentRuns.wait(ctx, {});
    expect(waited.isError).toBe(false);
    // Mutant: drop `noteSettled` — once agent_wait has collected the run, the engine has forgotten
    // it, and nothing anywhere could say this child finished rather than timed out.
    await waitFor(() => app.agentRuns.record(child!.id)?.outcome === "done");
    const rec = app.agentRuns.record(child!.id)!;
    expect(rec.settledAt).toBeGreaterThanOrEqual(rec.startedAt!);
  });
});

describe("the tool list says which models can be named", () => {
  it("agent_start's description and its model field carry the catalog once a probe has answered", async () => {
    await boot();
    await app.sessions.probe();
    const [run, start] = app.agentRuns.spawnTools();
    expect(start!.description).toContain("Models you can name right now");
    expect(start!.description).toContain("Codex: GPT-6 Luna, GPT-6 Astra");
    expect(start!.description).toContain('"GPT-6 Luna"');
    const props = (start!.inputSchema.properties as { constraints: { properties: Record<string, { description: string }> } }).constraints.properties;
    expect(props.model!.description).toContain("Codex: GPT-6 Luna");
    // One schema for both, so neither quietly stops accepting a model.
    expect(run!.inputSchema).toEqual(start!.inputSchema);
  });
});

/** The RPC socket, as a window would hold it — the three methods below are the Agents tab's whole
 *  view of a session's sub-agents. */
async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: { result?: unknown; error?: { message: string } }) => void>();
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); });
  let n = 0;
  const call = <T>(method: string, params: unknown) => new Promise<T>((res, rej) => {
    const id = String(++n);
    pending.set(id, (v) => (v.error ? rej(new Error(v.error.message)) : res(v.result as T)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { call, close: () => ws.close() };
}

type Child = { session: { id: string; agentKind: string; model: string | null }; goal: string | null; startedAt: number;
  settledAt: number | null; outcome: string | null; report: string | null; activity: { type: string } | null };

describe("the lead's list of its sub-agents", () => {
  it("delegation.children names each child's model, task and outcome — before and after it is collected", async () => {
    const { ctx } = await boot({ parentKind: "claude", parentModel: "claude-opus-5-5" });
    await app.sessions.probe();
    const c = await client(app.port);
    await app.agentRuns.start(ctx, { goal: "Write the tests", constraints: { model: "GPT-6 Luna" } });
    await app.agentRuns.start(ctx, { goal: "Write the migration", constraints: { model: "Fable" } });
    const before = (await c.call<{ children: Child[] }>("delegation.children", { sessionId: ctx.sessionId })).children;
    expect(before.map((x) => [x.goal, x.session.agentKind, x.session.model])).toEqual([
      ["Write the tests", "codex", "gpt-6-luna"], ["Write the migration", "claude", "claude-fable-5-1"]]);
    expect(await app.agentRuns.wait(ctx, {})).toMatchObject({ isError: false });
    // Collected: the engine has let both runs go. The list still says how each one ended.
    await waitFor(async () => (await c.call<{ children: Child[] }>("delegation.children", { sessionId: ctx.sessionId })).children.every((x) => x.outcome === "done"));
    const after = (await c.call<{ children: Child[] }>("delegation.children", { sessionId: ctx.sessionId })).children;
    for (const x of after) {
      expect(x.report).toBe("FINAL: done as asked");
      expect(x.activity?.type).toBe("assistant_text");
      expect(x.settledAt).toBeGreaterThanOrEqual(x.startedAt);
    }
    c.close();
  });

  it("lists only the sessions this one delegated to — never the lead itself, a stranger or a fork of it", async () => {
    const { ctx } = await boot();
    const c = await client(app.port);
    const stranger = app.sessions.create({ spaceId: ctx.spaceId, agentKind: "claude", projectId: null, model: null, effort: null, permissionMode: "default" });
    // A fork names the session it came from, and is nobody's sub-agent. Mutant: drop the origin
    // filter — every "Fork from here" would appear in the lead's Agents tab as a delegated child.
    app.sessions.create({ spaceId: ctx.spaceId, agentKind: "claude", projectId: null, model: null, effort: null, permissionMode: "default",
      dispatchedBy: { kind: "fork", sessionId: ctx.sessionId } });
    await app.agentRuns.start(ctx, { goal: "go" });
    const kids = (await c.call<{ children: Child[] }>("delegation.children", { sessionId: ctx.sessionId })).children;
    expect(kids.map((x) => x.session.id)).not.toContain(stranger.session.id);
    expect(kids).toHaveLength(1);
    expect((await c.call<{ children: Child[] }>("delegation.children", { sessionId: stranger.session.id })).children).toEqual([]);
    c.close();
  });

  it("says each child's budget and how much of it is spent — time waiting on the user is not charged", async () => {
    // THE MUTANT: report wall time as spent — a child held on a prompt reads as over its budget for a
    // wait the user caused, which the engine does not charge it for.
    const asks: FakeScript = [{ on: "You are a delegated agent.", emit: [
      { kind: "tool", name: "Bash", input: { command: "pnpm test" }, needsPermission: true, result: "ok" },
      { kind: "text", text: "FINAL: tests pass" },
    ] }];
    const { ctx } = await boot({ leadScript: asks });
    const c = await client(app.port);
    await app.agentRuns.start(ctx, { goal: "run the tests" });
    const [child] = children(ctx);
    await waitFor(() => app.sessions.get(child!.id).status === "waiting_permission");
    await new Promise((r) => setTimeout(r, 600));
    const waiting = (await c.call<{ children: (Child & { budgetMs: number | null; working: { ms: number; at: number } | null })[] }>("delegation.children", { sessionId: ctx.sessionId })).children[0]!;
    expect(waiting.budgetMs).toBe(5000);
    expect(waiting.working!.ms).toBeLessThan(waiting.working!.at - waiting.startedAt - 500);
    const ask = app.sessions.events(child!.id, 0, 500).map((e) => e.event).find((e) => e.type === "permission_request");
    await app.sessions.respondPermission(child!.id, ask!.type === "permission_request" ? ask!.payload.requestId : "", "allow");
    await app.agentRuns.wait(ctx, {});
    await waitFor(() => app.agentRuns.record(child!.id)?.workedMs !== undefined);
    const rec = app.agentRuns.record(child!.id)!;
    expect(rec.workedMs!).toBeLessThan(rec.settledAt! - rec.startedAt! - 500);
    c.close();
  }, 20_000);

  it("lists a sub-agent's own sub-agents under it — the ones started before a sub-agent could no longer start any", async () => {
    // THE MUTANT: list one level — a grandchild from an older build has no place in the tab at all.
    const { ctx } = await boot();
    const c = await client(app.port);
    await app.agentRuns.start(ctx, { goal: "go" });
    const [child] = children(ctx);
    const grandchild = app.sessions.create({ spaceId: ctx.spaceId, agentKind: "claude", projectId: null, model: null, effort: null, permissionMode: "default",
      dispatchedBy: { kind: "agent_run", sessionId: child!.id } });
    const kids = (await c.call<{ children: (Child & { children?: Child[] })[] }>("delegation.children", { sessionId: ctx.sessionId })).children;
    expect(kids.map((k) => k.session.id)).toEqual([child!.id]);
    expect(kids[0]!.children?.map((k) => k.session.id)).toEqual([grandchild.session.id]);
    c.close();
  });

  it("delegation.models offers the catalog on its routes, and names what the lead itself runs", async () => {
    const { ctx } = await boot({ parentKind: "claude", parentModel: "claude-opus-5-5" });
    await app.sessions.probe();
    const c = await client(app.port);
    const r = await c.call<{ models: { label: string; kind: string; id: string; ready: boolean }[]; own: { kind: string; label: string } }>("delegation.models", { sessionId: ctx.sessionId });
    expect(r.own).toEqual({ kind: "claude", label: "Claude Opus 5.5" });
    expect(r.models).toContainEqual(expect.objectContaining({ label: "GPT-6 Luna", kind: "codex", id: "gpt-6-luna", ready: true }));
    // One row per model: Fable through Claude and through Cursor is one Fable, on Claude.
    expect(r.models.filter((m) => m.label === "Claude Fable 5.1")).toEqual([expect.objectContaining({ kind: "claude" })]);
    c.close();
  });
});

describe("a session's Agents tab", () => {
  it("is one item per session, kind agents, refId the session — and the session's own item still answers for its id", async () => {
    const { ctx } = await boot();
    const c = await client(app.port);
    const first = await c.call<{ itemId: string }>("delegation.tab", { sessionId: ctx.sessionId });
    const again = await c.call<{ itemId: string }>("delegation.tab", { sessionId: ctx.sessionId });
    expect(again.itemId).toBe(first.itemId);
    const items = new ItemsStore(app.db);
    expect(items.get(first.itemId)).toMatchObject({ kind: "agents", refId: ctx.sessionId, title: "Agents", spaceId: ctx.spaceId });
    // Mutant: drop the kind filter from findByRefId — a rename, a move or a delete of the session
    // could then land on its tab, whichever row SQLite returned first.
    expect(items.findByRefId(ctx.sessionId)?.kind).toBe("session");
    c.close();
  });

  it("findByRefId never answers with a tab, whichever row was written first", async () => {
    // Row order is not a promise: VACUUM may renumber the rowids of a table keyed by TEXT. So the
    // rule is pinned with the tab written FIRST. Mutant: drop the kind filter.
    const { ctx } = await boot();
    const items = new ItemsStore(app.db);
    const ref = "01JBZZZZZZZZZZZZZZZZZZZZZZ";
    items.create({ spaceId: ctx.spaceId, kind: "agents", title: "Agents", refId: ref });
    items.create({ spaceId: ctx.spaceId, kind: "session", title: "S", refId: ref });
    expect(items.findByRefId(ref)?.kind).toBe("session");
    expect(items.findTab(ref)?.kind).toBe("agents");
  });

  it("moves with its session", async () => {
    const { ctx } = await boot();
    const c = await client(app.port);
    const { itemId } = await c.call<{ itemId: string }>("delegation.tab", { sessionId: ctx.sessionId });
    const space = app.sessions.get(ctx.sessionId).spaceId;
    const profileId = new SpacesStore(app.db, tempDir("realm-am-space-")).get(space)!.profileId;
    const other = new SpacesStore(app.db, tempDir("realm-am-space-")).create({ profileId, name: "T", icon: "folder" });
    await app.sessions.moveToSpace(ctx.sessionId, other.id);
    // Mutant: leave the tab behind — a session in one space with its Agents tab in another.
    expect(new ItemsStore(app.db).get(itemId)?.spaceId).toBe(other.id);
    c.close();
  });

  it("goes when its session goes", async () => {
    const { ctx } = await boot();
    const c = await client(app.port);
    const { itemId } = await c.call<{ itemId: string }>("delegation.tab", { sessionId: ctx.sessionId });
    await app.sessions.delete(ctx.sessionId);
    // Mutant: forget the tab in SessionService.delete — a tab for a session that no longer exists.
    expect(new ItemsStore(app.db).get(itemId)).toBeNull();
    c.close();
  });
});

describe("the scripted agent plays an orchestration for real", () => {
  it("a `call` step goes through the session's own gateway: the lead's turn starts a Codex child on GPT-6 Luna", async () => {
    const { ctx } = await boot({ leadScript: [{ on: "Build this with", emit: [
      { kind: "call", tool: "realm-agent__agent_start", input: { goal: "Write the tests", constraints: { model: "GPT-6 Luna" } } },
    ] }] });
    await app.sessions.probe();
    await app.sessions.send(ctx.sessionId, { text: "Build this with sub-agents on GPT-6 Luna.", attachments: [] });
    await waitFor(() => children(ctx).length === 1);
    expect(children(ctx)[0]).toMatchObject({ agentKind: "codex", model: "gpt-6-luna", dispatchedBy: { sessionId: ctx.sessionId, kind: "agent_run" } });
    // And the lead's own transcript holds the call and the gateway's real answer to it.
    await waitFor(() => app.sessions.events(ctx.sessionId, 0, 500).some((e) => e.event.type === "tool_result"));
    const evs = app.sessions.events(ctx.sessionId, 0, 500).map((e) => e.event);
    expect(evs).toContainEqual(expect.objectContaining({ type: "tool_call", payload: expect.objectContaining({ name: "mcp__realm__realm-agent__agent_start" }) }));
    const result = evs.find((e) => e.type === "tool_result");
    expect(result?.type === "tool_result" && result.payload).toMatchObject({ isError: false, content: expect.stringContaining("on Codex · GPT-6 Luna") });
  });

  it("a stand-in answers to a real harness's name, with the catalog it was given", async () => {
    const stand = fakeStandIn(new FakeAdapter(), "codex", [{ id: "gpt-6-luna", label: "GPT-6 Luna" }]);
    expect(stand.kind).toBe("codex");
    expect(await stand.probe()).toEqual({ kind: "codex", available: true, version: "fake", loggedIn: true, reason: null, models: [{ id: "gpt-6-luna", label: "GPT-6 Luna" }] });
  });
});
