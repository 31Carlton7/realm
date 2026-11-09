import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { tempDir } from "@realm/test-utils";
import { TEAMMATE_CLOCK_PROMPT, nextFireOf, onceExpr, type Run, type Schedule } from "@realm/contracts";
import { MobileCalls, TASK_ERROR_MAX, type MobileMethod } from "@realm/remote";
import { createApp, type App } from "../app";
import { MobileApi, MobileError } from "./api";
import { channel } from "./api.test-fakes";
import { RpcCallError, type RpcPort } from "./rpc-port";
import { scheduledTask } from "./work";

/**
 * Scheduled as a phone changes it, against a real Mac: the desktop's calls, its gate on an expression
 * that will never fire, and what is kept through an edit the phone's sheet does not show.
 */

let app: App | null = null;
afterEach(async () => { await app?.close(); app = null; vi.unstubAllEnvs(); });

async function rpcOf(port: number): Promise<RpcPort> {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (m: { result?: unknown; error?: { code: string; message: string } }) => void>();
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); });
  let n = 0;
  return {
    call: (method: string, params: unknown) => new Promise((res, rej) => {
      const id = String(++n);
      pending.set(id, (m) => (m.error ? rej(new RpcCallError(m.error.code, m.error.message)) : res(m.result as never)));
      ws.send(JSON.stringify({ id, method, params }));
    }),
  } as RpcPort;
}

/** A Mac with one profile and two spaces, whose agents are the fake one. */
async function mac() {
  const scratch = tempDir("realm-api-schedules-");
  const user = join(scratch, "user");
  mkdirSync(user, { recursive: true });
  vi.stubEnv("REALM_BUNDLED_SKILLS", join(scratch, "no-bundle"));
  vi.stubEnv("REALM_FAKE_STANDS_IN", "claude,codex");
  const home = join(scratch, "realm");
  mkdirSync(home);
  app = await createApp({ home, port: 0, userHome: user, claudeDir: join(user, ".claude"), claudeTemporaryRoots: [] });
  const rpc = await rpcOf(app.port);
  const [profile] = await rpc.call("profiles.list", {});
  const realm = await rpc.call("spaces.create", { profileId: profile!.id, name: "Realm" });
  const survey = await rpc.call("spaces.create", { profileId: profile!.id, name: "Glacier" });
  const phone = new MobileApi({ macName: () => "Test Mac", reportsDir: "/nonexistent", realmHome: home, dev: false });
  const ask = async <M extends MobileMethod>(method: M, params: unknown) => MobileCalls[method].result.parse(await phone.handle(channel(rpc), method, MobileCalls[method].params.parse(params))) as never;
  const refusal = async (method: MobileMethod, params: unknown): Promise<MobileError> => {
    try { await phone.handle(channel(rpc), method, params); } catch (e) { if (e instanceof MobileError) return e; throw e; }
    throw new Error(`${method} was not refused`);
  };
  const onMac = async (spaceId: string, id: string): Promise<Schedule | undefined> => (await rpc.call("schedules.list", { spaceId })).find((s) => s.id === id);
  return { rpc, ask, refusal, onMac, realm, survey };
}

type Task = { task: { id: string; title: string; goal: string; enabled: boolean; nextRunAt: number | null; agentKind: string | null; model: string | null; when: string; teammateId: string | null; spaceId: string; cadence: Record<string, unknown> } };
const brief = (spaceId: string, extra: Record<string, unknown> = {}) => ({ spaceId, title: "  Morning brief ", goal: "  What changed?\n", cron: "0 8 * * 1-5", agent: "fake", ...extra });

describe("a phone's scheduled tasks", () => {
  it("makes a task on the Mac, as the desktop's sheet does, with its goal as typed", async () => {
    const { ask, onMac, realm } = await mac();
    const { task } = await ask("schedules.create", brief(realm.id)) as Task;
    expect(task).toMatchObject({ title: "Morning brief", goal: "  What changed?\n", when: "Weekdays at 8:00 AM", enabled: true, agentKind: "fake", model: null, teammateId: null });
    expect(task.cadence).toEqual({ repeat: "weekdays", hour: 8, minute: 0 });
    expect(task.nextRunAt).toBe(nextFireOf("0 8 * * 1-5", Date.now()));
    const saved = await onMac(realm.id, task.id);
    expect(saved).toMatchObject({ title: "Morning brief", cron: "0 8 * * 1-5", enabled: true, newSessionPerRun: true, archiveSucceeded: false, constraints: { agentKind: "fake" } });
    expect(saved!.constraints).not.toHaveProperty("permissionMode");
    const { tasks } = await ask("schedules.list", {}) as { tasks: { id: string }[] };
    expect(tasks.map((t) => t.id)).toEqual([task.id]);
  });

  it("refuses what the desktop's gate refuses, in the Mac's words, and makes nothing", async () => {
    const { rpc, refusal, realm } = await mac();
    const never = await refusal("schedules.create", brief(realm.id, { cron: "99 9 * * *" }));
    expect([never.code, never.message]).toEqual(["INVALID_PARAMS", "`99 9 * * *` is not a schedule that will ever run — check the expression"]);
    const past = await refusal("schedules.create", brief(realm.id, { cron: onceExpr(Date.now() - 60_000) }));
    expect(past.code).toBe("INVALID_PARAMS");
    expect(past.message).toContain("has already passed");
    expect((await refusal("schedules.create", brief(realm.id, { agent: "nobody" }))).code).toBe("INVALID_PARAMS");
    expect((await refusal("schedules.create", brief(realm.id, { agent: "codex", model: "not-a-model" }))).message).toContain("not-a-model");
    expect((await refusal("schedules.create", brief("01JA0000000000000000000000"))).code).toBe("NOT_FOUND");
    expect(await rpc.call("schedules.list", { spaceId: realm.id })).toEqual([]);
  });

  it("will not take a blank name or blank instructions", () => {
    const params = MobileCalls["schedules.create"].params;
    const good = { spaceId: "01JSPACE00000000000000000", title: "Brief", goal: "Go", cron: "0 8 * * *", agent: "fake" };
    expect(params.safeParse(good).success).toBe(true);
    expect(params.safeParse({ ...good, title: "   " }).success).toBe(false);
    expect(params.safeParse({ ...good, goal: " \n " }).success).toBe(false);
    expect(params.safeParse({ ...good, goal: "x".repeat(20_001) }).success).toBe(false);
  });

  it("pauses and resumes a task, and changes only what is sent", async () => {
    const { ask, onMac, realm } = await mac();
    const { task } = await ask("schedules.create", brief(realm.id)) as Task;
    const paused = (await ask("schedules.update", { id: task.id, enabled: false }) as Task).task;
    expect(paused.enabled).toBe(false);
    expect((await onMac(realm.id, task.id))!.enabled).toBe(false);
    expect((await ask("schedules.update", { id: task.id, enabled: true }) as Task).task.enabled).toBe(true);
    await ask("schedules.update", { id: task.id, title: "Brief", cron: "30 7 * * *" });
    expect(await onMac(realm.id, task.id)).toMatchObject({ title: "Brief", goal: "  What changed?\n", cron: "30 7 * * *", enabled: true });
  });

  it("moves a task to another space", async () => {
    const { ask, onMac, realm, survey } = await mac();
    const { task } = await ask("schedules.create", brief(realm.id)) as Task;
    expect((await ask("schedules.update", { id: task.id, spaceId: survey.id }) as Task).task.spaceId).toBe(survey.id);
    expect(await onMac(realm.id, task.id)).toBeUndefined();
    expect(await onMac(survey.id, task.id)).toBeDefined();
  });

  it("keeps what an edit from the phone does not show, and drops a permission no run reads", async () => {
    const { rpc, ask, onMac, realm } = await mac();
    const made = await rpc.call("schedules.create", { spaceId: realm.id, title: "Sweep", goal: "Go", cron: "0 9 * * *", enabled: true, newSessionPerRun: true, archiveSucceeded: false,
      constraints: { agentKind: "claude", model: "opus", effort: "high", fastMode: true, permissionMode: "acceptEdits", skills: ["skill-a"] } });
    await ask("schedules.update", { id: made.id, goal: "Go on" });
    expect((await onMac(realm.id, made.id))!.constraints).toMatchObject({ agentKind: "claude", model: "opus", effort: "high", permissionMode: "acceptEdits", skills: ["skill-a"] });
    await ask("schedules.update", { id: made.id, agent: "codex", model: null, effort: null });
    const moved = (await onMac(realm.id, made.id))!.constraints!;
    expect(moved).toMatchObject({ agentKind: "codex", fastMode: true, skills: ["skill-a"] });
    expect(moved).not.toHaveProperty("model");
    expect(moved).not.toHaveProperty("effort");
    expect(moved).not.toHaveProperty("permissionMode");
  });

  it("will not re-check a finished one-shot's moment for a rename, and refuses to resume it", async () => {
    const { rpc, ask, refusal, realm } = await mac();
    const soon = Date.now() + 60 * 60_000;
    const { task } = await ask("schedules.create", brief(realm.id, { cron: onceExpr(soon) })) as Task;
    expect(task.cadence).toEqual({ repeat: "once", at: Math.trunc(soon) });
    await ask("schedules.update", { id: task.id, enabled: false });
    vi.spyOn(Date, "now").mockReturnValue(soon + 60_000);
    try {
      expect((await ask("schedules.update", { id: task.id, title: "Renamed" }) as Task).task.title).toBe("Renamed");
    } finally { vi.restoreAllMocks(); }
    // The real clock again, on the Mac's side too: a moment truly behind now is what it refuses.
    const gone = onceExpr(Date.now() - 1000);
    expect((await refusal("schedules.update", { id: task.id, cron: gone })).code).toBe("INVALID_PARAMS");
    expect((await rpc.call("schedules.list", { spaceId: realm.id }))[0]!.enabled).toBe(false);
  });

  it("deletes a task, and says when there was none", async () => {
    const { ask, onMac, realm } = await mac();
    const { task } = await ask("schedules.create", brief(realm.id)) as Task;
    expect(await ask("schedules.delete", { id: task.id })).toEqual({ deleted: true });
    expect(await onMac(realm.id, task.id)).toBeUndefined();
    expect(await ask("schedules.delete", { id: task.id })).toEqual({ deleted: false });
  });

  it("refuses a change to a task that is gone", async () => {
    const { refusal } = await mac();
    const id = "01JB0000000000000000000000";
    expect((await refusal("schedules.update", { id, title: "x" })).code).toBe("NOT_FOUND");
    expect((await refusal("schedules.update", { id, agent: "fake" })).message).toBe("That task is no longer in Realm.");
  });

  it("says when an expression would next fire on the Mac's clock, and null where it never would", async () => {
    const { ask } = await mac();
    expect(await ask("schedules.when", { cron: "15 * * * *" })).toEqual({ next: nextFireOf("15 * * * *", Date.now()), when: "Every hour at :15" });
    expect(await ask("schedules.when", { cron: "0 9 31 2 *" })).toEqual({ next: null, when: "0 9 31 2 *" });
    expect(await ask("schedules.when", { cron: "not cron" })).toEqual({ next: null, when: "not cron" });
    expect(await ask("schedules.when", { cron: "" })).toEqual({ next: null, when: "" });
  });

  it("suggests the page's tasks, each with the rows it opens on", async () => {
    const { ask } = await mac();
    const { suggested } = await ask("schedules.list", {}) as { suggested: { title: string; goal: string; cadence: unknown }[] };
    expect(suggested.map((s) => [s.title, s.cadence])).toEqual([
      ["Weekly review", { repeat: "weekly", weekday: 5, hour: 16, minute: 0 }],
      ["Morning brief", { repeat: "weekdays", hour: 8, minute: 0 }],
      ["Watch CI", { repeat: "weekdays", hour: 9, minute: 0 }],
    ]);
    expect(suggested[0]!.goal).toContain("agent_peers");
  });
});

describe("a teammate's check-in from a phone", () => {
  async function withTeammate() {
    const m = await mac();
    const teammate = await m.rpc.call("teammates.create", { spaceId: m.realm.id, name: "Mira", agentKind: "fake", brief: "" } as never);
    return { ...m, teammate };
  }

  it("sets it through the teammate, lists it beside the tasks, and fires into its chat rather than a run", async () => {
    const { rpc, ask, teammate, realm } = await withTeammate();
    const { task } = await ask("teammate.checkIn", { id: teammate.id, schedule: { cron: "0 9 * * *", prompt: "How is it going?", enabled: true } }) as Task;
    expect(task).toMatchObject({ title: "Mira", goal: "How is it going?", when: "Every day at 9:00 AM", enabled: true, teammateId: teammate.id, agentKind: null, spaceId: realm.id });
    expect((await rpc.call("teammates.list", { spaceId: realm.id, archived: false }))[0]!.schedule).toMatchObject({ id: task.id, cron: "0 9 * * *", prompt: "How is it going?" });
    const { tasks } = await ask("schedules.list", {}) as { tasks: { id: string; teammateId: string | null }[] };
    expect(tasks).toMatchObject([{ id: task.id, teammateId: teammate.id }]);
    // The desktop's Scheduled page keeps it off its own list.
    expect(await rpc.call("schedules.list", { spaceId: realm.id })).toEqual([]);
  });

  it("pauses it, gives blank words the words a check-in starts with, and removes it", async () => {
    const { ask, teammate } = await withTeammate();
    await ask("teammate.checkIn", { id: teammate.id, schedule: { cron: "0 9 * * *", prompt: "Hello", enabled: true } });
    expect((await ask("teammate.checkIn", { id: teammate.id, schedule: { enabled: false } }) as Task).task).toMatchObject({ enabled: false, goal: "Hello" });
    expect((await ask("teammate.checkIn", { id: teammate.id, schedule: { prompt: "  " } }) as Task).task.goal).toBe(TEAMMATE_CLOCK_PROMPT);
    expect(await ask("teammate.checkIn", { id: teammate.id, schedule: null })).toEqual({ task: null });
    expect((await ask("schedules.list", {}) as { tasks: unknown[] }).tasks).toEqual([]);
  });

  it("refuses a check-in that will never fire, or none to change, and keeps the task calls off it", async () => {
    const { ask, refusal, teammate } = await withTeammate();
    expect((await refusal("teammate.checkIn", { id: teammate.id, schedule: { cron: "99 9 * * *" } })).code).toBe("INVALID_PARAMS");
    expect((await refusal("teammate.checkIn", { id: teammate.id, schedule: { enabled: true } })).code).toBe("INVALID_PARAMS");
    const { task } = await ask("teammate.checkIn", { id: teammate.id, schedule: { cron: "0 9 * * *" } }) as Task;
    expect((await refusal("schedules.update", { id: task.id, title: "x" })).code).toBe("FORBIDDEN");
    expect((await refusal("schedules.delete", { id: task.id })).code).toBe("FORBIDDEN");
    expect((await refusal("teammate.checkIn", { id: "01JC0000000000000000000000", schedule: null })).code).toBe("NOT_FOUND");
  });
});

describe("a task's row", () => {
  const schedule: Schedule = {
    id: "t", spaceId: "s", title: "t", goal: "g", cron: "0 9 * * *", enabled: true, constraints: { agentKind: "codex", model: "gpt", effort: "high" }, nextRunAt: 5, lastRunAt: 4, lastRunId: "r",
    lastSkippedAt: 3, newSessionPerRun: false, archiveSucceeded: true, roleId: null, createdAt: 0, updatedAt: 0,
  };
  const failed = { state: "failed", sessionId: "se", error: "x".repeat(TASK_ERROR_MAX + 50) } as unknown as Run;

  it("carries what the sheet edits, and at most so much of why its last run failed", () => {
    const row = scheduledTask(schedule, "Space", failed, undefined);
    expect(row).toMatchObject({ goal: "g", cron: "0 9 * * *", agentKind: "codex", model: "gpt", effort: "high", newSessionPerRun: false, archiveSucceeded: true, lastSkippedAt: 3, teammateId: null });
    expect(row.lastRun!.state).toBe("Failed");
    expect(row.lastRun!.error).toHaveLength(TASK_ERROR_MAX);
    expect(row.lastRun!.error!.endsWith("…")).toBe(true);
  });

  it("names the Mac's own agent where the task names none", () => {
    expect(scheduledTask({ ...schedule, constraints: null }, "Space", null, undefined).agentKind).toBe("claude");
  });
});
