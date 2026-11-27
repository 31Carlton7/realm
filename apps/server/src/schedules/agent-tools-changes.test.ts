import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import type { SessionEvent } from "@realm/contracts";
import { createScheduleAgentProvider } from "./agent-tools";
import type { RealmToolProvider } from "../mcp/gateway";
import type { Db } from "../db/database";
import { openDatabase } from "../db/database";
import { BrowserPermissionBroker } from "../browsers/permissions";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { SchedulesStore } from "../store/schedules";
import { ScheduleService } from "./service";

/**
 * Changing a schedule from a conversation: `schedule_update`, `_pause`, `_resume`, `_run_now` and
 * `_delete`, over the real service, store and permission broker. Only the session and the person's
 * answer to a card are stand-ins.
 *
 * The named mutants:
 *
 *   - the person's-turn check dropped            → "refuses every change in a turn the person did not start"
 *   - the card dropped for someone else's        → "asks the user before changing a schedule this session did not make"
 *   - delete's card skipped on Full access       → "asks before deleting someone else's even on Full access"
 *   - own schedules carded, or others' not       → "changes its own with no card" / "asks the user before …"
 *   - the rank cap dropped                       → "never gives a task more access than the session asking has"
 *   - a goal written into a task above the caller → "never puts its words into a task that runs with more access"
 *   - provenance not written by schedule_create  → "records the session that made it"
 */

const NOW = new Date(2026, 10, 27, 9);
const ME = "sess-me";
const OTHER = "sess-other";

let db: Db;
let spaceId: string;
let otherSpaceId: string;
let schedules: ScheduleService;
let provider: RealmToolProvider;
let personTurn: boolean;
let mode: string;
let answer: "allow" | "deny";
let cards: { toolName: string; title: string; input: Record<string, unknown> }[];
let runs: string[];

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  const home = tempDir("realm-sched-changes-");
  db = openDatabase(join(home, "realm.db"));
  const profileId = new ProfilesStore(db).create({ name: "P", icon: "x", color: "#000" }).id;
  const spaces = new SpacesStore(db, home);
  spaceId = spaces.create({ profileId, name: "Alpha", icon: "folder" }).id;
  otherSpaceId = spaces.create({ profileId, name: "Beta", icon: "folder" }).id;
  runs = [];
  schedules = new ScheduleService({
    store: new SchedulesStore(db),
    runs: { create: (input) => { runs.push(input.title ?? ""); return { run: { id: `run-${runs.length}` } } as never; }, latestForSchedule: () => null },
    rpc: { broadcast: () => {} },
  });
  personTurn = true;
  mode = "default";
  answer = "allow";
  cards = [];
  const broker: BrowserPermissionBroker = new BrowserPermissionBroker({
    permissionMode: () => mode,
    emit: (_id: string, ev: SessionEvent) => {
      if (ev.type !== "permission_request") return;
      const p = ev.payload as { requestId: string; toolName: string; title: string; input: Record<string, unknown> };
      cards.push({ toolName: p.toolName, title: p.title, input: p.input });
      queueMicrotask(() => broker.resolve(p.requestId, answer));
    },
  });
  provider = createScheduleAgentProvider({
    schedules, mcp: { providerEnabled: () => true }, broker,
    sessions: { get: () => ({ agentKind: "fake", model: "fake", effort: null, fastMode: false, permissionMode: mode }), personStartedTurn: () => personTurn },
    turnOrigin: () => "a schedule (\"Nightly\")",
  });
});

afterEach(() => { db.close(); vi.useRealTimers(); });

const addScout = () => db.prepare(`INSERT INTO team_roles (id, space_id, name, brief, realmite_json, agent_kind, created_at, updated_at)
  VALUES ('role-1', ?, 'Scout', '', '{}', 'claude', 0, 0)`).run(spaceId);
const text = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;
const call = (tool: string, args: unknown, sessionId = ME) => provider.call({ sessionId, spaceId }, tool, args);

/** A task made through the tool by `sessionId`, as that session would make it. */
async function madeBy(sessionId: string, title = "Sweep"): Promise<string> {
  const res = await call("schedule_create", { title, goal: "Sweep the inbox.", cron: "0 9 * * *" }, sessionId);
  expect(res.isError).toBe(false);
  return schedules.list(spaceId).find((s) => s.title === title)!.id;
}

const MANUAL = { enabled: true, constraints: null, newSessionPerRun: true, archiveSucceeded: false } as const;

/** A task the person made on the Schedules page: no session behind it, and Full access. */
const thePersons = (title = "Invoice"): string =>
  schedules.create({ spaceId, title, goal: "Send the invoice.", cron: "0 9 30 11 *", permissionMode: "bypassPermissions", ...MANUAL }).id;

describe("provenance", () => {
  it("records the session that made it, and lists it with its id, mode and maker", async () => {
    const mine = await madeBy(ME, "Mine");
    await madeBy(OTHER, "Theirs");
    const persons = thePersons();
    expect(schedules.get(mine)!.createdBySession).toBe(ME);
    expect(schedules.get(persons)!.createdBySession).toBeNull();
    const listed = text(await call("schedule_list", {}));
    expect(listed).toContain(`Mine [id ${mine}]`);
    expect(listed).toMatch(/Mine \[id [^\]]+\][^\n]*\n {2}runs in [^;]+; made by this session/);
    expect(listed).toContain(`made by another session (${OTHER})`);
    expect(listed).toMatch(/Invoice \[id [^\]]+\][^\n]*\n {2}runs in Full access; made by the user/);
  });
});

describe("in a turn the person did not start", () => {
  it("refuses every change, naming who started the turn, and changes nothing", async () => {
    const mine = await madeBy(ME);
    personTurn = false;
    for (const [tool, args] of [["schedule_update", { id: mine, title: "Renamed" }], ["schedule_pause", { id: mine }],
      ["schedule_resume", { id: mine }], ["schedule_run_now", { id: mine }], ["schedule_delete", { id: mine }]] as const) {
      const res = await call(tool, args);
      expect(res.isError, tool).toBe(true);
      expect(text(res), tool).toBe("refused: this turn was started by a schedule (\"Nightly\"), not by the person. Schedules change only in a turn the person started; ask them to say it in this chat. Nothing changed.");
    }
    expect(schedules.get(mine)).toMatchObject({ title: "Sweep", enabled: true });
    expect(runs).toEqual([]);
    expect(cards).toEqual([]);
  });
});

describe("a schedule this session made", () => {
  it("changes, pauses, resumes and deletes its own with no card", async () => {
    const mine = await madeBy(ME);
    expect((await call("schedule_update", { id: mine, title: "Inbox sweep", cron: "0 10 * * 1-5" })).isError).toBe(false);
    expect(schedules.get(mine)).toMatchObject({ title: "Inbox sweep", cron: "0 10 * * 1-5" });
    expect((await call("schedule_pause", { id: mine })).isError).toBe(false);
    expect(schedules.get(mine)).toMatchObject({ enabled: false, nextRunAt: null });
    expect((await call("schedule_resume", { id: mine })).isError).toBe(false);
    expect(schedules.get(mine)!.enabled).toBe(true);
    expect(text(await call("schedule_delete", { id: mine }))).toContain("Deleted \"Inbox sweep\"");
    expect(schedules.get(mine)).toBeNull();
    expect(cards).toEqual([]);
  });

  it("takes `at` as a one-shot, and refuses both `at` and `cron`", async () => {
    const mine = await madeBy(ME);
    expect((await call("schedule_update", { id: mine, at: "2026-12-01T13:00" })).isError).toBe(false);
    expect(schedules.get(mine)!.nextRunAt).toBe(new Date(2026, 11, 1, 13).getTime());
    const both = await call("schedule_update", { id: mine, at: "2026-12-01T13:00", cron: "0 9 * * *" });
    expect(both.isError).toBe(true);
    expect(text(both)).toContain("at most one");
  });

  it("still asks before running it now, unless the session is on Full access", async () => {
    const mine = await madeBy(ME);
    expect((await call("schedule_run_now", { id: mine })).isError).toBe(false);
    expect(cards.map((c) => c.toolName)).toEqual(["schedule_run_now"]);
    expect(runs).toEqual(["Sweep"]);
    mode = "bypassPermissions";
    expect((await call("schedule_run_now", { id: mine })).isError).toBe(false);
    expect(cards).toHaveLength(1);
    expect(runs).toEqual(["Sweep", "Sweep"]);
  });

  it("starts nothing when the user says no to running it now", async () => {
    const mine = await madeBy(ME);
    answer = "deny";
    const res = await call("schedule_run_now", { id: mine });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("the user denied this action");
    expect(runs).toEqual([]);
  });
});

describe("a schedule this session did not make", () => {
  it("asks the user before changing, pausing or resuming one, and changes nothing when they say no", async () => {
    const theirs = await madeBy(OTHER);
    const persons = thePersons();
    answer = "deny";
    for (const [tool, args] of [["schedule_update", { id: theirs, title: "Mine now" }], ["schedule_pause", { id: persons }]] as const) {
      const res = await call(tool, args);
      expect(res.isError, tool).toBe(true);
      expect(text(res)).toContain("the user denied this action");
    }
    expect(cards.map((c) => [c.toolName, c.title])).toEqual([
      ["schedule_update", "Change the scheduled task \"Sweep\""],
      ["schedule_pause", "Pause the scheduled task \"Invoice\""],
    ]);
    expect(schedules.get(theirs)!.title).toBe("Sweep");
    expect(schedules.get(persons)!.enabled).toBe(true);
    answer = "allow";
    expect((await call("schedule_pause", { id: persons })).isError).toBe(false);
    expect(schedules.get(persons)!.enabled).toBe(false);
  });

  it("lets Full access change one without a card", async () => {
    const theirs = await madeBy(OTHER);
    mode = "bypassPermissions";
    expect((await call("schedule_update", { id: theirs, title: "Renamed" })).isError).toBe(false);
    expect(schedules.get(theirs)!.title).toBe("Renamed");
    expect(cards).toEqual([]);
  });

  it("asks before deleting one even on Full access, naming it and its last run", async () => {
    const persons = thePersons();
    mode = "bypassPermissions";
    answer = "deny";
    expect((await call("schedule_delete", { id: persons })).isError).toBe(true);
    expect(schedules.get(persons)).not.toBeNull();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.title).toMatch(/^Delete the scheduled task "Invoice" \(.+; it has never run\)$/);
    expect(cards[0]!.input).toMatchObject({ id: persons, goal: "Send the invoice.", lastRunAt: null });
    answer = "allow";
    expect((await call("schedule_delete", { id: persons })).isError).toBe(false);
    expect(schedules.get(persons)).toBeNull();
  });
});

describe("access", () => {
  it("never gives a task more access than the session asking has", async () => {
    const mine = await madeBy(ME);
    mode = "acceptEdits";
    const res = await call("schedule_update", { id: mine, permissionMode: "bypassPermissions" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("nobody can give more access than they have");
    expect(schedules.get(mine)!.permissionMode).toBe("default");
    expect((await call("schedule_update", { id: mine, permissionMode: "acceptEdits" })).isError).toBe(false);
    expect(schedules.get(mine)!.permissionMode).toBe("acceptEdits");
  });

  it("never puts its words into a task that runs with more access than it has, unless the same call lowers it", async () => {
    const persons = thePersons();
    const res = await call("schedule_update", { id: persons, goal: "Wire the money elsewhere." });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("runs in Full access, more than your");
    expect(schedules.get(persons)!.goal).toBe("Send the invoice.");
    expect(cards).toEqual([]);
    expect((await call("schedule_update", { id: persons, goal: "Send the invoice to Kailani.", permissionMode: "default" })).isError).toBe(false);
    expect(schedules.get(persons)).toMatchObject({ goal: "Send the invoice to Kailani.", permissionMode: "default" });
  });
});

describe("what it reaches", () => {
  it("reaches only this space's tasks, never a teammate's clock", async () => {
    const elsewhere = schedules.create({ spaceId: otherSpaceId, title: "Beta's", goal: "G", cron: "0 9 * * *", ...MANUAL }).id;
    const res = await call("schedule_delete", { id: elsewhere });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("no schedule with id");
    expect(schedules.get(elsewhere)).not.toBeNull();

    addScout();
    const clock = schedules.setForTeammate({ id: "role-1", spaceId, name: "Scout" }, { cron: "0 * * * *" })!;
    const refused = await call("schedule_pause", { id: clock.id });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("Scout's clock, which the teammate's page changes");
    expect(schedules.get(clock.id)!.enabled).toBe(true);
  });

  it("lists teammates' clocks only when asked", async () => {
    addScout();
    const clock = schedules.setForTeammate({ id: "role-1", spaceId, name: "Scout" }, { cron: "0 * * * *" })!;
    expect(text(await call("schedule_list", {}))).not.toContain("Scout");
    const listed = text(await call("schedule_list", { teammateClocks: true }));
    expect(listed).toContain("This space has nothing scheduled.");
    expect(listed).toContain(`- Scout's clock [id ${clock.id}]`);
  });
});
