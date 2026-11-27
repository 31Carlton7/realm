import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter, type FakeScript } from "@realm/adapters";
import type { SessionEvent, StoredSessionEvent, Teammate } from "@realm/contracts";
import { createApp, type App } from "../app";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { waitFor } from "../test-utils";

/**
 * `teammate_archive`, `teammate_set_lead`, `teammate_reorder` and `teammate_run_clock` over the real
 * app with the scripted agent. Each runs only for the Lead or the person's own session, in a turn the
 * person started. Archive and run_clock ask on a card unless the caller is on Full access, set_lead
 * always does, and reorder never does.
 */

let app: App;
afterEach(async () => { await app?.close(); app = undefined!; });

const TOOLS = ["teammate_archive", "teammate_set_lead", "teammate_reorder", "teammate_run_clock"];
const SCRIPT: FakeScript = [
  ...TOOLS.map((tool) => ({ on: `please call ${tool} `, emit: [{ kind: "call" as const, tool: `realm-team__${tool}`, input: {}, argsFromMessage: true }, { kind: "text" as const, text: "Asked." }] })),
  { on: "ask the lead to archive polish", emit: [{ kind: "call", tool: "realm-team__team_message", input: { to: "lead", message: "archive polish now" } }] },
  { on: "archive polish now", emit: [{ kind: "call", tool: "realm-team__teammate_archive", input: { to: "polish" } }] },
  { on: "ask the lead to run polish's clock", emit: [{ kind: "call", tool: "realm-team__team_message", input: { to: "lead", message: "run the polish clock" } }] },
  { on: "run the polish clock", emit: [{ kind: "call", tool: "realm-team__teammate_run_clock", input: { to: "polish" } }] },
  { on: "ask the lead to hand over", emit: [{ kind: "call", tool: "realm-team__team_message", input: { to: "lead", message: "make ops the lead now" } }] },
  { on: "make ops the lead now", emit: [{ kind: "call", tool: "realm-team__teammate_set_lead", input: { to: "ops" } }] },
  { on: "ask the lead to reorder", emit: [{ kind: "call", tool: "realm-team__team_message", input: { to: "lead", message: "put ops first now" } }] },
  { on: "put ops first now", emit: [{ kind: "call", tool: "realm-team__teammate_reorder", input: { order: [{ handle: "ops" }, { handle: "captain" }, { handle: "polish" }] } }] },
  { on: "Look over the UI.", emit: [{ kind: "text", text: "Looked." }] },
];

async function boot() {
  const home = tempDir("realm-teammate-manage-list-");
  const fake = new FakeAdapter({ script: SCRIPT, delayMs: 2 });
  app = await createApp({ home, port: 0, adapters: { fake, claude: fake }, agentRun: { fallbackKind: "fake" } });
  const profile = new ProfilesStore(app.db).create({ name: "P", icon: "x", color: "#000" });
  const space = new SpacesStore(app.db, home).create({ profileId: profile.id, name: "Realm", icon: "folder" });
  const make = (name: string, extra: Record<string, unknown> = {}): Teammate =>
    app.team.create({ spaceId: space.id, name, brief: `You are ${name}.`, agentKind: "fake", ...extra });
  const captain = make("Captain", { lead: true, permissionMode: "bypassPermissions" });
  const polish = make("Polish", { permissionMode: "bypassPermissions", schedule: { cron: "0 9 * * *", prompt: "Look over the UI." } });
  const ops = make("Ops", { permissionMode: "bypassPermissions" });
  return { spaceId: space.id, captain, polish, ops };
}

const events = (sessionId: string): SessionEvent[] => app.sessions.events(sessionId, 0, 2_000).map((e: StoredSessionEvent) => e.event);
const results = (sessionId: string) => events(sessionId).flatMap((e) => (e.type === "tool_result" ? [e.payload] : []));
const cards = (sessionId: string) => events(sessionId).flatMap((e) => (e.type === "permission_request" ? [e.payload] : []));
const clockTurns = (sessionId: string) => events(sessionId).flatMap((e) => (e.type === "user_message" && e.payload.text.startsWith("Look over the UI.\n\n") ? [e.payload] : []));
const say = (who: Teammate, tool: string, input: Record<string, unknown>) => app.team.message(who.id, `please call ${tool} ${JSON.stringify(input)}`);
/** The n-th tool result in the chat, once the turn has settled. */
const answered = async (sessionId: string, n = 1) => {
  await waitFor(() => results(sessionId).length >= n && app.sessions.get(sessionId).status === "idle");
  return results(sessionId)[n - 1]!;
};
/** Answer the n-th card when it comes. */
const answerCard = async (sessionId: string, decision: "allow" | "deny", n = 1) => {
  await waitFor(() => cards(sessionId).length >= n);
  const card = cards(sessionId)[n - 1]!;
  app.sessions.respondPermission(sessionId, card.requestId, decision);
  return card;
};
const handles = (spaceId: string, archived = false) => app.team.list(spaceId, archived).map((t) => t.handle);
const leadOf = (spaceId: string) => app.team.list(spaceId).find((t) => t.lead)?.handle ?? null;

describe("teammate_archive", () => {
  it("archives a teammate on Full access with no card, and brings it back", async () => {
    const { spaceId, captain } = await boot();
    await say(captain, "teammate_archive", { to: "polish" });
    expect((await answered(captain.homeSessionId!)).content).toBe("Archived @polish. Its sessions stay; teammate_archive with archived: false brings it back.");
    expect(handles(spaceId)).toEqual(["captain", "ops"]);
    expect(handles(spaceId, true)).toEqual(["polish"]);
    await say(captain, "teammate_archive", { to: "polish", archived: false });
    expect((await answered(captain.homeSessionId!, 2)).content).toBe("@polish is back on the Team list.");
    expect(handles(spaceId)).toContain("polish");
    expect(cards(captain.homeSessionId!)).toEqual([]);
  });

  it("refuses in a turn a teammate's message started", async () => {
    const { spaceId, captain, ops } = await boot();
    await app.team.message(ops.id, "please ask the lead to archive polish");
    expect((await answered(captain.homeSessionId!)).content).toBe("refused: this turn was started by a message from @ops, not by the person. Teammates are archived only in a turn the person started; ask them to say it in your chat. Nothing changed.");
    expect(handles(spaceId)).toContain("polish");
    expect(cards(captain.homeSessionId!)).toEqual([]);
  });

  it("asks on a card off Full access, and a denied card changes nothing", async () => {
    const { spaceId, captain } = await boot();
    await app.team.setPermissionMode(captain.id, "acceptEdits");
    await say(captain, "teammate_archive", { to: "polish" });
    const card = await answerCard(captain.homeSessionId!, "deny");
    expect(card.title).toBe("Archive @polish (Polish): it leaves the Team list and the team tools, and its clock stops. Its sessions stay.");
    expect((await answered(captain.homeSessionId!)).content).toBe("the user denied this action");
    expect(handles(spaceId)).toContain("polish");
    await say(captain, "teammate_archive", { to: "polish" });
    await answerCard(captain.homeSessionId!, "allow", 2);
    expect((await answered(captain.homeSessionId!, 2)).content).toMatch(/^Archived @polish\./);
    expect(handles(spaceId)).not.toContain("polish");
  });

  it("refuses a teammate that is not the Lead", async () => {
    const { spaceId, ops } = await boot();
    await say(ops, "teammate_archive", { to: "polish" });
    expect((await answered(ops.homeSessionId!)).content).toBe("refused: only the space's Lead, in its own chat, or one of the person's own sessions can archive a teammate, and you are @ops, not the Lead. Nothing changed.");
    expect(handles(spaceId)).toContain("polish");
  });
});

describe("teammate_set_lead", () => {
  it("hands the Lead over on a card, even on Full access", async () => {
    const { spaceId, captain } = await boot();
    await say(captain, "teammate_set_lead", { to: "ops" });
    const card = await answerCard(captain.homeSessionId!, "allow");
    expect(card.title).toBe("Make @ops (Ops) the Lead, in place of @captain");
    expect((await answered(captain.homeSessionId!)).content).toBe("@ops is the Lead now; @captain is not.");
    expect(leadOf(spaceId)).toBe("ops");
  });

  it("changes nothing when the card is denied", async () => {
    const { spaceId, captain } = await boot();
    await say(captain, "teammate_set_lead", { to: null });
    const card = await answerCard(captain.homeSessionId!, "deny");
    expect(card.title).toBe("Leave the space with no Lead (@captain stops being the Lead)");
    expect((await answered(captain.homeSessionId!)).content).toBe("the user denied this action");
    expect(leadOf(spaceId)).toBe("captain");
  });

  it("refuses in a turn a teammate's message started", async () => {
    const { spaceId, captain, ops } = await boot();
    await app.team.message(ops.id, "please ask the lead to hand over");
    expect((await answered(captain.homeSessionId!)).content).toBe("refused: this turn was started by a message from @ops, not by the person. The Lead is chosen only in a turn the person started; ask them to say it in your chat. Nothing changed.");
    expect(cards(captain.homeSessionId!)).toEqual([]);
    expect(leadOf(spaceId)).toBe("captain");
  });

  it("refuses a teammate making itself the Lead", async () => {
    const { spaceId, ops } = await boot();
    await say(ops, "teammate_set_lead", { to: "ops" });
    expect((await answered(ops.homeSessionId!)).content).toBe("refused: only the space's Lead, in its own chat, or one of the person's own sessions can choose the Lead, and you are @ops, not the Lead. Nothing changed.");
    expect(cards(ops.homeSessionId!)).toEqual([]);
    expect(leadOf(spaceId)).toBe("captain");
  });
});

describe("teammate_reorder", () => {
  it("sets the Team list's order and sections with no card, off Full access too, and wants every teammate named", async () => {
    const { spaceId, captain } = await boot();
    await app.team.setPermissionMode(captain.id, "acceptEdits");
    await say(captain, "teammate_reorder", { order: [{ handle: "captain" }, { handle: "ops", group: "Ship" }] });
    expect((await answered(captain.homeSessionId!)).content).toBe("name every teammate on the Team list, top to bottom; missing: @polish. Nothing changed.");
    await say(captain, "teammate_reorder", { order: [{ handle: "captain" }, { handle: "ops", group: "Ship" }, { handle: "polish", group: "Ship" }] });
    expect((await answered(captain.homeSessionId!, 2)).content).toBe("The Team list is now: @captain, @ops (Ship), @polish (Ship).");
    expect(app.team.list(spaceId).map((t) => [t.handle, t.group])).toEqual([["captain", null], ["ops", "Ship"], ["polish", "Ship"]]);
    expect(cards(captain.homeSessionId!)).toEqual([]);
  });

  it("refuses in a turn a teammate's message started", async () => {
    const { spaceId, captain, ops } = await boot();
    await app.team.message(ops.id, "please ask the lead to reorder");
    expect((await answered(captain.homeSessionId!)).content).toBe("refused: this turn was started by a message from @ops, not by the person. The Team list is reordered only in a turn the person started; ask them to say it in your chat. Nothing changed.");
    expect(handles(spaceId)).toEqual(["captain", "polish", "ops"]);
  });
});

describe("teammate_run_clock", () => {
  it("fires a teammate's clock on Full access with no card, its prompt a turn in its chat", async () => {
    const { captain, polish } = await boot();
    await say(captain, "teammate_run_clock", { to: "polish" });
    expect((await answered(captain.homeSessionId!)).content).toBe(`@polish's clock ran: its prompt is a turn in its chat, session ${polish.homeSessionId}. teammate_sessions shows the task sessions it starts.`);
    await waitFor(() => clockTurns(polish.homeSessionId!).length === 1);
    expect(clockTurns(polish.homeSessionId!)[0]!.scheduled?.scheduleId).toBe(polish.schedule!.id);
    expect(cards(captain.homeSessionId!)).toEqual([]);
  });

  it("refuses in a turn a teammate's message started, and says so for one with no clock", async () => {
    const { captain, polish, ops } = await boot();
    await app.team.message(ops.id, "please ask the lead to run polish's clock");
    expect((await answered(captain.homeSessionId!)).content).toBe("refused: this turn was started by a message from @ops, not by the person. Clocks are run by hand only in a turn the person started; ask them to say it in your chat. Nothing ran.");
    expect(clockTurns(polish.homeSessionId!)).toEqual([]);
    await say(captain, "teammate_run_clock", { to: "ops" });
    expect((await answered(captain.homeSessionId!, 2)).content).toBe("@ops has no clock. teammate_update with schedule gives it one. Nothing ran.");
  });

  it("asks on a card off Full access, and a denied card runs nothing", async () => {
    const { captain, polish } = await boot();
    await app.team.setPermissionMode(captain.id, "acceptEdits");
    await say(captain, "teammate_run_clock", { to: "polish" });
    const card = await answerCard(captain.homeSessionId!, "deny");
    expect(card.title).toBe("Run @polish's clock now: \"Look over the UI.\" in its chat");
    expect((await answered(captain.homeSessionId!)).content).toBe("the user denied this action");
    expect(clockTurns(polish.homeSessionId!)).toEqual([]);
  });
});
