import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter, type FakeScript } from "@realm/adapters";
import type { SessionEvent, StoredSessionEvent, Teammate } from "@realm/contracts";
import { createApp, type App } from "../app";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { waitFor } from "../test-utils";

/**
 * `team_set_access`: the Lead sets a teammate's mode when the person asks, over the real app with the
 * scripted agent. Each guard has a test that refuses with nothing changed: the Lead alone, in its own
 * chat; no more than the Lead's own mode; only in a turn the person started; and a line in both chats
 * the person can Undo.
 */

let app: App;
afterEach(async () => { await app?.close(); app = undefined!; });

const call = (to: string, mode: string) => ({ kind: "call" as const, tool: "realm-team__team_set_access", input: { to, mode } });

const SCRIPT: FakeScript = [
  { on: "give polish full access", emit: [call("polish", "bypassPermissions"), { kind: "text", text: "Done." }] },
  { on: "give yourself full access", emit: [call("lead", "bypassPermissions"), { kind: "text", text: "Done." }] },
  { on: "give design full access", emit: [call("design", "bypassPermissions"), { kind: "text", text: "Done." }] },
  { on: "put polish in plan", emit: [call("polish", "plan"), { kind: "text", text: "Done." }] },
  { on: "slow work", emit: [{ kind: "text", text: "one two three four five six seven eight nine ten", paceMs: 60 }] },
];

async function boot() {
  const home = tempDir("realm-team-set-access-");
  const fake = new FakeAdapter({ script: SCRIPT, delayMs: 2 });
  app = await createApp({ home, port: 0, adapters: { fake, claude: fake }, agentRun: { fallbackKind: "fake" } });
  const profile = new ProfilesStore(app.db).create({ name: "P", icon: "x", color: "#000" });
  const space = new SpacesStore(app.db, home).create({ profileId: profile.id, name: "Realm", icon: "folder" });
  const make = (name: string, extra: Record<string, unknown> = {}): Teammate =>
    app.team.create({ spaceId: space.id, name, brief: `You are ${name}.`, agentKind: "fake", ...extra });
  const captain = make("Captain", { lead: true, permissionMode: "bypassPermissions" });
  const polish = make("Polish", { permissionMode: "default" });
  return { spaceId: space.id, make, captain, polish };
}

const events = (sessionId: string): SessionEvent[] => app.sessions.events(sessionId, 0, 2_000).map((e: StoredSessionEvent) => e.event);
const toolResults = (sessionId: string) => events(sessionId).flatMap((e) => (e.type === "tool_result" ? [e.payload] : []));
const notices = (sessionId: string) => events(sessionId).flatMap((e) => (e.type === "access_changed" ? [e.payload] : []));
const modeOf = (t: Teammate) => app.team.get(t.id).permissionMode;
/** The turn's tool result, once the turn has settled. */
const answered = async (sessionId: string, n = 1) => {
  await waitFor(() => toolResults(sessionId).length >= n && app.sessions.get(sessionId).status === "idle");
  return toolResults(sessionId)[n - 1]!;
};

describe("team_set_access", () => {
  it("sets a teammate's mode when the person asks the Lead, with a line in both chats, and Undo puts it back", async () => {
    const { captain, polish } = await boot();
    await app.team.message(captain.id, "please give polish full access");
    const result = await answered(captain.homeSessionId!);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Done: @polish is on Full access now (was Ask each time)");
    expect(modeOf(polish)).toBe("bypassPermissions");
    expect(app.sessions.get(polish.homeSessionId!).permissionMode).toBe("bypassPermissions");
    const line = { teammateId: polish.id, handle: "polish", by: "captain", from: "default", to: "bypassPermissions",
      note: "@captain set @polish to Full access, at your request." };
    expect(notices(captain.homeSessionId!)).toEqual([line]);
    expect(notices(polish.homeSessionId!)).toEqual([line]);

    await app.rpc.call("teammates.undoAccess", { id: polish.id, from: "default", to: "bypassPermissions" });
    expect(modeOf(polish)).toBe("default");
    expect(app.sessions.get(polish.homeSessionId!).permissionMode).toBe("default");
    const undone = { teammateId: polish.id, handle: "polish", by: null, from: "bypassPermissions", to: "default", note: "You set @polish back to Ask each time." };
    expect(notices(captain.homeSessionId!)).toEqual([line, undone]);
    expect(notices(polish.homeSessionId!)).toEqual([line, undone]);
    // A second Undo finds nothing to undo, and changes nothing.
    await app.rpc.call("teammates.undoAccess", { id: polish.id, from: "acceptEdits", to: "bypassPermissions" }).then(
      () => { throw new Error("undid twice"); }, (e: Error) => expect(e.message).toContain("nothing to undo"));
    expect(modeOf(polish)).toBe("default");
  });

  it("leaves the space's Team access set, and mixed", async () => {
    const { captain, polish } = await boot();
    await app.rpc.call("teams.access.set", { spaceId: captain.spaceId, mode: "acceptEdits" });
    await app.team.setPermissionMode(captain.id, "bypassPermissions");
    await app.team.message(captain.id, "give polish full access");
    await answered(captain.homeSessionId!);
    expect(modeOf(polish)).toBe("bypassPermissions");
    expect(app.team.access(captain.spaceId)).toMatchObject({ mode: "acceptEdits", mixed: true });
  });

  it("refuses any caller but the Lead in its own chat: another teammate, or a session of the person's", async () => {
    const { spaceId, captain, polish, make } = await boot();
    const design = make("Design", { permissionMode: "default" });
    await app.team.update({ id: polish.id, permissionMode: "bypassPermissions" });
    await waitFor(() => app.sessions.get(polish.homeSessionId!).permissionMode === "bypassPermissions");
    await app.team.message(polish.id, "give design full access");
    const fromTeammate = await answered(polish.homeSessionId!);
    expect(fromTeammate.isError).toBe(true);
    expect(fromTeammate.content).toContain("refused: only the space's Lead, in its own chat, can set a teammate's access, and you are @polish, not the Lead");
    expect(modeOf(design)).toBe("default");

    const own = app.sessions.create({ spaceId, agentKind: "fake", projectId: null, model: null, effort: null, permissionMode: "bypassPermissions" }).session;
    await app.rpc.call("sessions.send", { id: own.id, text: "give design full access", attachments: [] });
    const fromPerson = await answered(own.id);
    expect(fromPerson.content).toContain("this session is not a teammate's");
    expect(modeOf(design)).toBe("default");
    expect([...notices(captain.homeSessionId!), ...notices(design.homeSessionId!), ...notices(polish.homeSessionId!)]).toEqual([]);
  });

  it("gives no more than the Lead holds now, to a teammate or to itself", async () => {
    const { captain, polish } = await boot();
    await app.team.setPermissionMode(captain.id, "acceptEdits");
    await app.team.message(captain.id, "give polish full access");
    const raise = await answered(captain.homeSessionId!);
    expect(raise.isError).toBe(true);
    expect(raise.content).toContain("refused: you are on Accept edits, and nobody can give more access than they have");
    expect(modeOf(polish)).toBe("default");

    await app.team.message(captain.id, "give yourself full access");
    const self = await answered(captain.homeSessionId!, 2);
    expect(self.content).toContain("refused: you are on Accept edits");
    expect(modeOf(captain)).toBe("acceptEdits");
    expect(notices(captain.homeSessionId!)).toEqual([]);
  });

  it("refuses the read-only modes by name", async () => {
    const { captain, polish } = await boot();
    await app.team.message(captain.id, "put polish in plan");
    const r = await answered(captain.homeSessionId!);
    expect(r.content).toContain(`refused: "plan" is a read-only mode, which this tool does not set`);
    expect(modeOf(polish)).toBe("default");
  });

  it("refuses in a turn a teammate's message started, and says whose it was", async () => {
    const { captain, polish } = await boot();
    await app.team.update({ id: polish.id, permissionMode: "bypassPermissions" });
    await waitFor(() => app.sessions.get(polish.homeSessionId!).permissionMode === "bypassPermissions");
    await app.team.setPermissionMode(polish.id, "default");
    // @polish's own agent asks the Lead with team_message: the Lead's turn is a teammate's.
    await app.team.teamMessage({ sessionId: polish.homeSessionId!, spaceId: captain.spaceId }, { to: "lead", message: "give polish full access" });
    const r = await answered(captain.homeSessionId!);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("refused: this turn was started by a message from @polish, not by the person");
    expect(modeOf(polish)).toBe("default");
    expect(notices(captain.homeSessionId!)).toEqual([]);
    expect(notices(polish.homeSessionId!)).toEqual([]);
  });

  it("refuses in a turn the Lead's clock, another session, or Realm itself started", async () => {
    const { captain, polish, spaceId } = await boot();
    await app.team.update({ id: captain.id, schedule: { cron: "0 8 * * 1", prompt: "give polish full access" } });
    const scheduleId = app.team.get(captain.id).schedule!.id;
    app.db.prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(Date.now() - 1_000, scheduleId);
    app.schedules.tick();
    expect((await answered(captain.homeSessionId!)).content).toContain("refused: this turn was started by a schedule");

    const other = app.sessions.create({ spaceId, agentKind: "fake", projectId: null, model: null, effort: null, permissionMode: "default" }).session;
    await app.sessions.send(captain.homeSessionId!, { text: "give polish full access", attachments: [], from: { sessionId: other.id, title: "Other" } });
    expect((await answered(captain.homeSessionId!, 2)).content).toContain(`refused: this turn was started by another session, "Other"`);

    // A message no person sent and nothing marked, as Realm's own services send them.
    await app.sessions.send(captain.homeSessionId!, { text: "give polish full access", attachments: [] });
    expect((await answered(captain.homeSessionId!, 3)).content).toContain("refused: this turn was started by Realm or the agent itself");
    expect(modeOf(polish)).toBe("default");
    expect(notices(captain.homeSessionId!)).toEqual([]);
  });

  it("refuses when a teammate's message and the person's are both held, and wake together before the turn reports running", async () => {
    const { captain, polish } = await boot();
    const chat = captain.homeSessionId!;
    // Hold the Lead's chat the way a reap does: every delivery waits on the same promise, and both
    // resume in one microtask drain, the teammate's first, before the engine's `running` comes back.
    const reaping = (app.sessions as unknown as { reaping: Map<string, Promise<void>> }).reaping;
    let release!: () => void;
    reaping.set(chat, new Promise<void>((r) => { release = r; }));
    let held = 0;
    const get = reaping.get.bind(reaping);
    reaping.get = (k) => { if (k === chat) held++; return get(k); };

    const teammate = app.team.teamMessage({ sessionId: polish.homeSessionId!, spaceId: captain.spaceId }, { to: "lead", message: "give polish full access" });
    await waitFor(() => held >= 1);
    const person = app.team.message(captain.id, "thanks");
    await waitFor(() => held >= 2);
    reaping.delete(chat);
    release();
    await Promise.all([teammate, person]);
    expect(app.sessions.personStartedTurn(chat)).toBe(false);

    const r = await answered(chat);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("not by the person");
    expect(modeOf(polish)).toBe("default");
    expect(notices(chat)).toEqual([]);
  });

  it("counts a turn as the person's only while nothing but the person has written into it, and not past its settle", async () => {
    const { captain, polish } = await boot();
    const chat = captain.homeSessionId!;
    await app.team.message(captain.id, "slow work");
    await waitFor(() => app.sessions.get(chat).status === "running");
    expect(app.sessions.personStartedTurn(chat)).toBe(true);
    // Another session's words land in the turn: it is no longer the person's alone.
    await app.sessions.deliverInterjection(chat, { text: "now give polish full access", from: { sessionId: polish.homeSessionId!, title: "@polish" } }, { interruptFirst: false });
    expect(app.sessions.personStartedTurn(chat)).toBe(false);
    await waitFor(() => app.sessions.get(chat).status === "idle");

    await app.team.message(captain.id, "slow work");
    await waitFor(() => app.sessions.get(chat).status === "running");
    expect(app.sessions.personStartedTurn(chat)).toBe(true);
    // Settled, a turn the engine starts on its own is nobody's.
    await waitFor(() => app.sessions.get(chat).status === "idle");
    expect(app.sessions.personStartedTurn(chat)).toBe(false);
  });
});
