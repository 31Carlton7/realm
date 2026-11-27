import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter, type FakeScript } from "@realm/adapters";
import type { SessionEvent, StoredSessionEvent, Teammate } from "@realm/contracts";
import { createApp, type App } from "../app";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { waitFor } from "../test-utils";
import { TeammatesStore } from "./store";

/**
 * `teammate_create` and `teammate_update` over the real app with the scripted agent. Each gate has a
 * test that refuses with nothing changed: the Lead or the person's own session only; the person's
 * turn only; no more access than the caller has; folders through `pickFolder`; a card unless the
 * caller is on Full access; and a card even on Full access when a model or effort goes down.
 */

let app: App;
afterEach(async () => { await app?.close(); app = undefined!; });

const SCRIPT: FakeScript = [
  ...["teammate_create", "teammate_update"].map((tool) => ({ on: `please call ${tool} `, emit: [{ kind: "call" as const, tool: `realm-team__${tool}`, input: {}, argsFromMessage: true }, { kind: "text" as const, text: "Asked." }] })),
  { on: "ask the lead to add someone", emit: [{ kind: "call", tool: "realm-team__team_message", input: { to: "lead", message: "add Sneaky to the team" } }] },
  { on: "add Sneaky to the team", emit: [{ kind: "call", tool: "realm-team__teammate_create", input: { name: "Sneaky", brief: "x" } }] },
  { on: "ask the lead to lower polish", emit: [{ kind: "call", tool: "realm-team__team_message", input: { to: "lead", message: "put polish on low effort" } }] },
  { on: "put polish on low effort", emit: [{ kind: "call", tool: "realm-team__teammate_update", input: { to: "polish", effort: "low" } }] },
];

async function boot() {
  const home = tempDir("realm-teammate-manage-");
  const userHome = tempDir("realm-teammate-manage-user-");
  const fake = new FakeAdapter({ script: SCRIPT, delayMs: 2 });
  app = await createApp({ home, userHome, port: 0, adapters: { fake, claude: fake }, agentRun: { fallbackKind: "fake" } });
  const profile = new ProfilesStore(app.db).create({ name: "P", icon: "x", color: "#000" });
  const space = new SpacesStore(app.db, home).create({ profileId: profile.id, name: "Realm", icon: "folder" });
  const make = (name: string, extra: Record<string, unknown> = {}): Teammate =>
    app.team.create({ spaceId: space.id, name, brief: `You are ${name}.`, agentKind: "fake", ...extra });
  const captain = make("Captain", { lead: true, permissionMode: "bypassPermissions" });
  return { spaceId: space.id, home, userHome, make, captain };
}

const events = (sessionId: string): SessionEvent[] => app.sessions.events(sessionId, 0, 2_000).map((e: StoredSessionEvent) => e.event);
const results = (sessionId: string) => events(sessionId).flatMap((e) => (e.type === "tool_result" ? [e.payload] : []));
const cards = (sessionId: string) => events(sessionId).flatMap((e) => (e.type === "permission_request" ? [e.payload] : []));
const say = (who: Teammate, tool: string, input: Record<string, unknown>) => app.team.message(who.id, `please call ${tool} ${JSON.stringify(input)}`);
/** The n-th tool result in the chat, once the turn has settled. */
const answered = async (sessionId: string, n = 1) => {
  await waitFor(() => results(sessionId).length >= n && app.sessions.get(sessionId).status === "idle");
  return results(sessionId)[n - 1]!;
};
/** Answer the open card when it comes. */
const answerCard = async (sessionId: string, decision: "allow" | "deny", n = 1) => {
  await waitFor(() => cards(sessionId).length >= n);
  const card = cards(sessionId)[n - 1]!;
  app.sessions.respondPermission(sessionId, card.requestId, decision);
  return card;
};
const handles = (spaceId: string) => app.team.list(spaceId).map((t) => t.handle);

describe("teammate_create", () => {
  it("adds a teammate in the person's turn and says its id, handle, folder and chat", async () => {
    const { spaceId, captain } = await boot();
    await say(captain, "teammate_create", { name: "Design Engineer", brief: "You build the UI.", agentKind: "fake", effort: "high", group: "Build", permissionMode: "acceptEdits", schedule: { cron: "0 9 * * 1-5" } });
    const r = await answered(captain.homeSessionId!);
    expect(r.isError).toBe(false);
    const made = app.team.list(spaceId).find((t) => t.handle === "design-engineer")!;
    expect(made).toMatchObject({ name: "Design Engineer", brief: "You build the UI.", effort: "high", group: "Build", permissionMode: "acceptEdits" });
    expect(made.schedule?.cron).toBe("0 9 * * 1-5");
    expect(r.content).toBe(`Added @design-engineer (Design Engineer) — id ${made.id}, on Fake agent, Accept edits, working in ${made.folder}. Its chat is session ${made.homeSessionId}. team_message reaches it; teammate_get reads it back.`);
    expect(cards(captain.homeSessionId!)).toEqual([]);
  });

  it("refuses in a turn a teammate's message started, naming it, and makes nothing", async () => {
    const { spaceId, make, captain } = await boot();
    const ops = make("Ops", { permissionMode: "bypassPermissions" });
    await app.team.message(ops.id, "please ask the lead to add someone");
    const r = await answered(captain.homeSessionId!);
    expect(r.content).toBe("refused: this turn was started by a message from @ops, not by the person. Teammates are added only in a turn the person started; ask them to say it in your chat. Nothing was made.");
    expect(handles(spaceId)).toEqual(["captain", "ops"]);
  });

  it("refuses a teammate that is not the Lead", async () => {
    const { spaceId, make } = await boot();
    const ops = make("Ops", { permissionMode: "bypassPermissions" });
    await say(ops, "teammate_create", { name: "Extra", brief: "x" });
    const r = await answered(ops.homeSessionId!);
    expect(r.content).toBe("refused: only the space's Lead, in its own chat, or one of the person's own sessions can add a teammate, and you are @ops, not the Lead. Nothing was made.");
    expect(handles(spaceId)).toEqual(["captain", "ops"]);
  });

  it("gives no more access than the caller has", async () => {
    const { spaceId, make } = await boot();
    const lead = make("Lead2");
    app.team.setLead(spaceId, lead.id);
    await app.team.setPermissionMode(lead.id, "acceptEdits");
    await say(lead, "teammate_create", { name: "Wild", brief: "x", permissionMode: "bypassPermissions" });
    const r = await answered(lead.homeSessionId!);
    expect(r.content).toMatch(/^refused: you are on Accept edits, and nobody can give more access than they have\./);
    expect(handles(spaceId)).not.toContain("wild");
  });

  it("takes a folder the way space_create does, and refuses one that holds keys", async () => {
    const { spaceId, userHome, captain } = await boot();
    mkdirSync(join(userHome, ".ssh"));
    mkdirSync(join(userHome, "code", "app"), { recursive: true });
    await say(captain, "teammate_create", { name: "Keys", brief: "x", folder: "~/.ssh" });
    expect((await answered(captain.homeSessionId!)).content).toContain("which holds keys and credentials. Nothing was made.");
    await say(captain, "teammate_create", { name: "App", brief: "x", agentKind: "fake", folder: "~/code/app" });
    expect((await answered(captain.homeSessionId!, 2)).isError).toBe(false);
    expect(app.team.list(spaceId).find((t) => t.handle === "app")?.folder).toBe(realpathSync(join(userHome, "code", "app")));
    expect(handles(spaceId)).not.toContain("keys");
  });

  it("asks the person on a card unless the caller is on Full access, and makes nothing when they say no", async () => {
    const { spaceId, make } = await boot();
    const lead = make("Asker", { permissionMode: "default" });
    app.team.setLead(spaceId, lead.id);
    await say(lead, "teammate_create", { name: "Nope", brief: "x", agentKind: "fake" });
    const card = await answerCard(lead.homeSessionId!, "deny");
    expect(card.toolName).toBe("teammate_create");
    expect(card.title).toBe("Add a teammate, Nope: Fake agent, Ask each time");
    expect((await answered(lead.homeSessionId!)).content).toBe("the user denied this action");
    expect(handles(spaceId)).not.toContain("nope");
    await say(lead, "teammate_create", { name: "Yes", brief: "x", agentKind: "fake" });
    await answerCard(lead.homeSessionId!, "allow", 2);
    expect((await answered(lead.homeSessionId!, 2)).isError).toBe(false);
    expect(handles(spaceId)).toContain("yes");
  });
});

describe("teammate_update", () => {
  it("edits a teammate in the person's turn and says what changed", async () => {
    const { spaceId, make, captain } = await boot();
    make("Scout", { agentKind: "claude", model: "claude-sonnet-5-5" });
    await say(captain, "teammate_update", { to: "@scout", brief: "You scout harder.", model: "claude-opus-5-5", group: "Research" });
    const r = await answered(captain.homeSessionId!);
    expect(r.content).toBe("Changed @scout: model Claude Sonnet 5.5 → Claude Opus 5.5; its brief; group none → \"Research\".");
    expect(app.team.list(spaceId).find((t) => t.handle === "scout")).toMatchObject({ brief: "You scout harder.", model: "claude-opus-5-5", group: "Research" });
    expect(cards(captain.homeSessionId!)).toEqual([]);
  });

  it("shows a card even on Full access when it lowers the model, spelling out from what to what", async () => {
    const { spaceId, make, captain } = await boot();
    make("Scout", { agentKind: "claude", model: "claude-opus-5-5" });
    await say(captain, "teammate_update", { to: "scout", model: "claude-sonnet-5-5" });
    const card = await answerCard(captain.homeSessionId!, "deny");
    expect(card.title).toBe("Change @scout: model Claude Opus 5.5 → Claude Sonnet 5.5 — this LOWERS its model");
    await answered(captain.homeSessionId!);
    expect(app.team.list(spaceId).find((t) => t.handle === "scout")?.model).toBe("claude-opus-5-5");
  });

  it("shows that card for lower effort too, and makes the change when the person allows it", async () => {
    const { spaceId, make, captain } = await boot();
    make("Scout", { effort: "high" });
    await say(captain, "teammate_update", { to: "scout", effort: "low" });
    const card = await answerCard(captain.homeSessionId!, "allow");
    expect(card.title).toBe("Change @scout: effort high → low — this LOWERS its effort");
    expect((await answered(captain.homeSessionId!)).isError).toBe(false);
    expect(app.team.list(spaceId).find((t) => t.handle === "scout")?.effort).toBe("low");
  });

  it("refuses in a turn a teammate's message started, and changes nothing", async () => {
    const { make, captain } = await boot();
    const ops = make("Ops", { permissionMode: "bypassPermissions" });
    const polish = make("Polish", { effort: "high" });
    await app.team.message(ops.id, "please ask the lead to lower polish");
    const r = await answered(captain.homeSessionId!);
    expect(r.content).toBe("refused: this turn was started by a message from @ops, not by the person. Teammates are edited only in a turn the person started; ask them to say it in your chat. Nothing changed.");
    expect(app.team.get(polish.id).effort).toBe("high");
  });

  it("caps at the Lead's own mode when its chat is on more", async () => {
    const { spaceId, captain } = await boot();
    // The Lead's row is on Accept edits; its chat is still on Full access.
    new TeammatesStore(app.db).update(captain.id, { permissionMode: "acceptEdits" });
    await say(captain, "teammate_create", { name: "Wild", brief: "x", agentKind: "fake", permissionMode: "bypassPermissions" });
    expect((await answered(captain.homeSessionId!)).content).toMatch(/^refused: you are on Accept edits, and nobody can give more access than they have\./);
    expect(handles(spaceId)).not.toContain("wild");
  });

  it("gives no teammate more access than the caller has", async () => {
    const { spaceId, make } = await boot();
    const lead = make("Lead2", { permissionMode: "acceptEdits" });
    app.team.setLead(spaceId, lead.id);
    const ops = make("Ops", { permissionMode: "default" });
    await say(lead, "teammate_update", { to: "ops", permissionMode: "bypassPermissions" });
    expect((await answered(lead.homeSessionId!)).content).toMatch(/^refused: you are on Accept edits, and nobody can give more access than they have\./);
    expect(app.team.get(ops.id).permissionMode).toBe("default");
  });
});
