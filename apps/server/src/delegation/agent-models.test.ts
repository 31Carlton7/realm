import { afterEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter, type AgentAdapter, type FakeScript, type StartOptions } from "@realm/adapters";
import type { AgentKind, AgentModel } from "@realm/contracts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createApp, type App } from "../app";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
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
afterEach(async () => { vi.useRealTimers(); await app?.close(); });

const CODEX: AgentModel[] = [{ id: "gpt-6-luna", label: "GPT-6 Luna" }, { id: "gpt-6-astra", label: "GPT-6 Astra" }];
const CURSOR: AgentModel[] = [{ id: "claude-fable-5-1", label: "claude-fable-5-1" }, { id: "composer-2", label: "Composer 2" }];

const CHILD: FakeScript = [{ on: "You are a delegated agent.", emit: [{ kind: "text", text: "FINAL: done as asked" }] }];

/** A real agent's name on the fake's body: probes as `kind` with `models`, runs the child script,
 *  and keeps every StartOptions it was handed — the seam the model id is read off. */
function standIn(kind: AgentKind, models: AgentModel[] | null, counts: { probes: number }) {
  const fake = new FakeAdapter({ script: CHILD, delayMs: 2 });
  const seen: StartOptions[] = [];
  const adapter: AgentAdapter = {
    kind,
    probe: async () => { counts.probes++; return { kind, available: true, version: "fake", loggedIn: true, reason: null, models }; },
    start: (o) => { seen.push(o); return fake.start(o); },
  };
  return { adapter, seen };
}

async function boot(opts: { parentKind?: AgentKind; parentModel?: string | null; parentMode?: string } = {}) {
  const counts = { probes: 0 };
  const claude = standIn("claude", null, counts);
  const codex = standIn("codex", CODEX, counts);
  const cursor = standIn("acp:cursor", CURSOR, counts);
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

  it("a named model does not loosen the permission cap — bypass still degrades to default", async () => {
    const { ctx } = await boot({ parentMode: "bypassPermissions" });
    await app.sessions.probe();
    await app.agentRuns.start(ctx, { goal: "go", constraints: { model: "GPT-6 Luna", permissionMode: "bypassPermissions" } });
    expect(children(ctx)[0]).toMatchObject({ agentKind: "codex", permissionMode: "default" });
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
