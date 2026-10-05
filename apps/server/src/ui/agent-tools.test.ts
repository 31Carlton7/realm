import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter, type FakeScript } from "@realm/adapters";
import { HIDDEN_ANSWER, type AskCard, type DelegableModel } from "@realm/contracts";
import type { AskOutcome } from "../browsers/permissions";
import { createApp, type App } from "../app";
import { McpCallLogStore } from "../store/mcp";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { waitFor } from "../test-utils";
import { UI_PROVIDER_NAME, createUiAgentProvider, type UiAgentToolsDeps } from "./agent-tools";

const MODELS: DelegableModel[] = [
  { key: "5.5-claude-opus", label: "Claude Opus 5.5", kind: "claude", id: "claude-opus-5-5", ready: true },
  { key: "6-gpt-luna", label: "GPT-6 Luna", kind: "codex", id: "gpt-6-luna", ready: true },
  { key: "2-composer", label: "Composer 2", kind: "acp:cursor", id: "composer-2", ready: false },
];

function setup(over: Partial<UiAgentToolsDeps> & { answer?: (card: AskCard) => AskOutcome; enabled?: boolean } = {}) {
  const cwd = tempDir("realm-ui-ws-");
  const asked: AskCard[] = [];
  const provider = createUiAgentProvider({
    mcp: { providerEnabled: () => over.enabled ?? true },
    broker: { ask: async (_s, card) => { asked.push(card); return over.answer?.(card) ?? { outcome: "skipped" }; } },
    session: () => ({ agentKind: "codex", cwd, model: "gpt-6-luna" }),
    models: async () => ({ models: MODELS, own: { kind: "codex", label: "GPT-6 Luna" } }),
    branches: async () => ({ branches: ["feat/theme", "main"], current: "main" }),
    ...over,
  });
  const call = (args: unknown) => provider.call({ sessionId: "s1", spaceId: "sp1" }, "ui_ask", args);
  return { provider, call, asked, cwd };
}
const text = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;

describe("realm-ui's ui_ask", () => {
  it("is offered where the space has it on, and is gone where it was switched off", async () => {
    expect((await setup().provider.tools({ sessionId: "s1", spaceId: "sp1" })).map((t) => t.name)).toEqual(["ui_ask"]);
    expect(await setup({ enabled: false }).provider.tools({ sessionId: "s1", spaceId: "sp1" })).toEqual([]);
    expect(UI_PROVIDER_NAME).toBe("realm-ui");
  });

  it("asks on the card as the session's own agent, and hands the answers back as words and as data", async () => {
    const { call, asked, cwd } = setup({ answer: () => ({ outcome: "answered", answers: { db: "Postgres" } }) });
    const r = await call({ questions: [{ id: "db", prompt: "Which database?", kind: "choice", options: [{ label: "Postgres" }, { label: "SQLite" }] }] });
    expect(asked[0]).toMatchObject({ asker: { kind: "agent", name: "Codex", agent: "codex" }, mode: "question", workspace: cwd,
      questions: [{ id: "db", kind: "choice", options: [{ value: "Postgres", label: "Postgres" }, { value: "SQLite", label: "SQLite" }] }] });
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toEqual({ answers: { db: "Postgres" } });
    expect(text(r)).toContain("- db (Which database?): Postgres");
  });

  it("fills a model field from Realm's catalog — never from the agent — with the session's own model first", async () => {
    const { call, asked } = setup({ answer: () => ({ outcome: "answered", answers: { who: ["gpt-6-luna", "claude-opus-5-5"] } }) });
    const r = await call({ questions: [{ id: "who", prompt: "Who builds each step?", kind: "model", rows: ["Write the migration", "Wire the toggle"] }] });
    const q = asked[0]!.questions[0]!;
    expect(q.rows).toEqual([{ id: "1", label: "Write the migration" }, { id: "2", label: "Wire the toggle" }]);
    // The session's own model once, on top, by the id it is pinned to; a model whose harness is not
    // ready is listed and marked rather than hidden.
    expect(q.options).toEqual([
      { value: "gpt-6-luna", label: "GPT-6 Luna", agent: "codex", own: true },
      { value: "claude-opus-5-5", label: "Claude Opus 5.5", agent: "claude" },
      { value: "composer-2", label: "Composer 2", agent: "acp:cursor", ready: false },
    ]);
    expect(text(r)).toContain("1. Write the migration: gpt-6-luna (GPT-6 Luna, on Codex, this session's own model)");
    expect(text(r)).toContain("2. Wire the toggle: claude-opus-5-5 (Claude Opus 5.5, on Claude)");
    expect(text(r)).toContain("`constraints.model`");
  });

  it("fills a branch field from git, starting on the branch that is checked out", async () => {
    const { call, asked } = setup();
    await call({ questions: [{ id: "base", prompt: "Which branch?", kind: "branch" }] });
    expect(asked[0]!.questions[0]).toMatchObject({ kind: "branch", default: "main", options: [{ value: "feat/theme" }, { value: "main", current: true }] });
    const bare = setup({ branches: async () => null });
    expect(text(await bare.call({ questions: [{ id: "base", prompt: "Which branch?", kind: "branch" }] }))).toMatch(/not a git repository/);
  });

  it("resolves an option's picture inside the workspace, and refuses one that is not there", async () => {
    // THE MUTANT: pass `image` through as the agent wrote it. A URL would then reach the card, and the
    // card would be one step from fetching something an agent chose.
    const { call, asked, cwd } = setup();
    mkdirSync(join(cwd, "mockups"));
    writeFileSync(join(cwd, "mockups", "calm.png"), "png");
    writeFileSync(join(cwd, "notes.md"), "md");
    const pick = (image: string) => call({ questions: [{ id: "look", prompt: "Which look?", kind: "choice", options: [{ label: "Calm", image }] }] });
    await pick("mockups/calm.png");
    expect(asked[0]!.questions[0]!.options![0]!.image).toMatch(/\/mockups\/calm\.png$/);
    expect(text(await pick("https://evil.example/x.png"))).toMatch(/not a URL/);
    expect(text(await pick("../../etc/passwd.png"))).toMatch(/no file|outside/);
    expect(text(await pick("notes.md"))).toMatch(/not a picture/);
    expect(asked).toHaveLength(1);
  });

  it("refuses what it cannot ask, with the reason, before anything reaches the user", async () => {
    const { call, asked } = setup();
    const five = [1, 2, 3, 4, 5].map((n) => ({ id: `q${n}`, prompt: "?", kind: "text" }));
    expect((await call({ questions: five })).isError).toBe(true);
    expect((await call({ questions: [{ id: "q", prompt: "?", kind: "choice" }] })).isError).toBe(true);
    expect(asked).toEqual([]);
  });

  it("says a skip, a timeout and a withdrawal apart, as data the agent can read", async () => {
    for (const [outcome, data] of [["skipped", { skipped: true }], ["timeout", { skipped: true, reason: "timeout" }], ["cancelled", { skipped: true, reason: "cancelled" }]] as const) {
      const { call } = setup({ answer: () => ({ outcome }) });
      const r = await call({ questions: [{ id: "q", prompt: "Name?", kind: "text" }] });
      expect(r.structuredContent).toEqual(data);
      expect(r.isError).toBe(false);
    }
  });
});

/* ── End to end: the fake agent calls ui_ask through its own gateway, the way a real agent does ── */

let app: App;
afterEach(async () => { await app?.close(); });

const SCRIPT: FakeScript = [{ on: "ask", emit: [{ kind: "call", tool: "realm-ui__ui_ask", input: { questions: [
  { id: "db", prompt: "Which database?", kind: "choice", options: [{ label: "Postgres" }, { label: "SQLite" }] },
  { id: "token", prompt: "Paste the deploy token.", kind: "text", secret: true },
] } }] }];

async function boot(permissionMode?: string) {
  const home = tempDir("realm-ui-int-");
  app = await createApp({ home, port: 0, adapters: { fake: new FakeAdapter({ script: SCRIPT, delayMs: 2 }) } });
  const profile = new ProfilesStore(app.db).create({ name: "P", icon: "x", color: "#000" });
  const space = new SpacesStore(app.db, home).create({ profileId: profile.id, name: "S", icon: "folder" });
  const { session } = app.sessions.create({ spaceId: space.id, agentKind: "fake", projectId: null, model: null, effort: null, permissionMode: permissionMode ?? null });
  return session.id;
}
const eventsOf = (id: string) => app.sessions.events(id, 0, 500).map((e) => e.event);

describe("ui_ask, end to end", () => {
  it("puts the card up even in Plan, and keeps the masked answer out of the log, the feed and Activity", async () => {
    const id = await boot("plan");
    await app.sessions.send(id, { text: "ask", attachments: [] });
    await waitFor(() => eventsOf(id).some((e) => e.type === "permission_request"));
    const req = eventsOf(id).find((e) => e.type === "permission_request")!;
    expect(req.type === "permission_request" && req.payload.ask?.asker.name).toBe("Fake agent");
    app.sessions.respondPermission(id, req.type === "permission_request" ? req.payload.requestId : "", "allow", { db: "Postgres", token: "tok_live_SECRET_77" });
    await waitFor(() => eventsOf(id).some((e) => e.type === "tool_result"));
    const result = eventsOf(id).find((e) => e.type === "tool_result")!;
    // The agent was handed the token — its result quotes the answer back — and the log keeps a mark.
    // THE MUTANT: drop the scrub in `onEvent`. The tool result is then persisted with the token in it.
    expect(result.type === "tool_result" && result.payload.content).toContain(`token (Paste the deploy token.): ${HIDDEN_ANSWER}`);
    expect(JSON.stringify(eventsOf(id))).not.toContain("tok_live_SECRET_77");
    const calls = new McpCallLogStore(app.db).list({ sessionId: id });
    expect(calls.map((c) => c.tool)).toEqual(["ui_ask"]);
    expect(JSON.stringify(calls)).not.toContain("tok_live_SECRET_77");
  });
});
