import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter, type FakeScript } from "@realm/adapters";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Teammate } from "@realm/contracts";
import { createApp, type App } from "../app";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { waitFor } from "../test-utils";
import { createTeammatesProvider } from "./agent-tools";

/**
 * The read half of the team tools: `team_list` with how each teammate is set up, `teammate_get` for
 * one in full, and `teammate_sessions` for the work it started and what came of it.
 */

let app: App;
afterEach(async () => { await app?.close(); app = undefined!; });

const SCRIPT: FakeScript = [
  { on: "open the pr", emit: [{ kind: "call", tool: "realm-agent__agent_start", input: { goal: "Open the search PR", title: "search pr" } }, { kind: "text", text: "Started it." }] },
  { on: "Open the search PR", emit: [{ kind: "tool", name: "Bash", input: { command: "gh pr create --fill" }, result: "https://github.com/acme/app/pull/42" }, { kind: "text", text: "Opened it." }] },
];

async function boot() {
  const home = tempDir("realm-team-read-");
  const fake = new FakeAdapter({ script: SCRIPT, delayMs: 2 });
  app = await createApp({ home, port: 0, adapters: { fake, claude: fake }, agentRun: { fallbackKind: "fake" } });
  const profile = new ProfilesStore(app.db).create({ name: "P", icon: "x", color: "#000" });
  const space = new SpacesStore(app.db, home).create({ profileId: profile.id, name: "Realm", icon: "folder" });
  const make = (name: string, extra: Record<string, unknown> = {}): Teammate =>
    app.team.create({ spaceId: space.id, name, brief: `You are ${name}.`, agentKind: "fake", ...extra });
  return { spaceId: space.id, home, make };
}

const text = (r: CallToolResult) => r.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");

describe("team_list", () => {
  it("says under each teammate how it is set up: id, model, effort, access, folder, group, clock and chat", async () => {
    const { spaceId, home, make } = await boot();
    const captain = make("Captain", { lead: true, permissionMode: "bypassPermissions", effort: "high", group: "Ship" });
    const scout = make("Scout", { model: "claude-sonnet-5-5", permissionMode: "default", folder: home, schedule: { cron: "0 9 * * 1-5", prompt: "Check the inbox." } });
    const listed = text(app.team.teamList({ sessionId: captain.homeSessionId!, spaceId }));
    expect(listed).toContain(`  id ${captain.id} · fake · effort high · access Full access (bypassPermissions) · folder ${captain.folder} · group "Ship" · no clock · chat ${captain.homeSessionId}`);
    const clock = app.team.get(scout.id).schedule!;
    expect(listed).toContain(`  id ${scout.id} · fake claude-sonnet-5-5 · effort default · access Ask each time (default) · folder ${home} · no group · clock "0 9 * * 1-5" (schedule ${clock.id}), next ${new Date(clock.nextRunAt!).toISOString()} · chat ${scout.homeSessionId}`);
  });

  it("says a paused clock is paused, and lists the archived teammates only when asked", async () => {
    const { spaceId, make } = await boot();
    const captain = make("Captain", { lead: true });
    const old = make("Old", { schedule: { cron: "0 9 * * *", enabled: false } });
    expect(text(app.team.teamList({ sessionId: captain.homeSessionId!, spaceId }))).toMatch(/@old — .*\n {2}.*clock "0 9 \* \* \*" \(schedule \w+\), paused/);
    app.team.archive(old.id, true);
    const current = text(app.team.teamList({ sessionId: captain.homeSessionId!, spaceId }));
    expect(current).not.toContain("@old");
    const archived = text(app.team.teamList({ sessionId: captain.homeSessionId!, spaceId }, { archived: true }));
    expect(archived).toContain("@old — Old");
    expect(archived).toContain(" · archived");
    expect(archived).not.toContain("@captain");
  });
});

describe("teammate_get", () => {
  it("reads one teammate in full, its whole brief and its clock's prompt, archived ones too", async () => {
    const { spaceId, make } = await boot();
    const captain = make("Captain", { lead: true });
    const scout = make("Scout", { brief: "You scout.\nSecond line of the brief.", schedule: { cron: "0 9 * * *", prompt: "Check the inbox." } });
    const got = text(app.team.teammateGet({ sessionId: captain.homeSessionId!, spaceId }, { to: "@scout" }));
    expect(got).toContain(`@scout — Scout\nid ${scout.id} · fake`);
    expect(got).toContain("Its clock says: Check the inbox.");
    expect(got).toContain("Brief:\nYou scout.\nSecond line of the brief.");
    app.team.archive(scout.id, true);
    expect(text(app.team.teammateGet({ sessionId: captain.homeSessionId!, spaceId }, { to: "scout" }))).toContain("@scout (archived) — Scout");
    const lead = text(app.team.teammateGet({ sessionId: captain.homeSessionId!, spaceId }, { to: "lead" }));
    expect(lead).toContain("@captain (Lead) (you) — Captain");
  });

  it("names the teammates there are when the handle is wrong", async () => {
    const { spaceId, make } = await boot();
    const captain = make("Captain", { lead: true });
    const r = app.team.teammateGet({ sessionId: captain.homeSessionId!, spaceId }, { to: "nobody" });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("there is no @nobody here. Teammates here: @captain (team_list says what each does).");
  });
});

describe("teammate_sessions", () => {
  it("lists the task sessions a teammate started, newest first, with the PR each one opened", async () => {
    const { spaceId, make } = await boot();
    const captain = make("Captain", { lead: true, permissionMode: "bypassPermissions" });
    expect(text(app.team.teammateSessions({ sessionId: captain.homeSessionId!, spaceId }, { to: "captain" }))).toBe("@captain has started no task sessions.");
    await app.team.message(captain.id, "please open the pr");
    await waitFor(() => {
      const [task] = app.team.sessions(captain.id);
      return task?.state === "idle" && task.outcome?.kind === "pr";
    }, { timeout: 10_000 });
    const [task] = app.team.sessions(captain.id);
    const listed = text(app.team.teammateSessions({ sessionId: captain.homeSessionId!, spaceId }, { to: "lead" }));
    expect(listed).toContain(`@captain's task sessions (1), newest first.`);
    expect(listed).toContain(`- "${task!.title}" (${task!.id}) · idle · last active `);
    expect(listed).toContain(" · PR #42 https://github.com/acme/app/pull/42");
  });
});

describe("the realm-team provider", () => {
  it("lists teammate_get and teammate_sessions, and routes them", async () => {
    const { spaceId, make } = await boot();
    const captain = make("Captain", { lead: true });
    const ctx = { sessionId: captain.homeSessionId!, spaceId };
    const none = async () => ({ content: [] });
    const provider = createTeammatesProvider({ store: { hasAny: () => true }, teammates: app.team, manage: { create: none, update: none, archive: none, setLead: none, reorder: none, runClock: none }, mcp: { providerEnabled: () => true } });
    expect((await provider.tools(ctx)).map((t) => t.name)).toEqual(["team_list", "teammate_get", "teammate_sessions", "teammate_create", "teammate_update", "teammate_archive", "teammate_set_lead", "teammate_reorder", "teammate_run_clock", "team_message", "team_set_access"]);
    expect(text(await provider.call(ctx, "teammate_get", { to: "captain" }))).toContain("@captain (Lead) (you) — Captain");
    expect(text(await provider.call(ctx, "teammate_sessions", { to: "captain" }))).toBe("@captain has started no task sessions.");
    expect(text(await provider.call(ctx, "team_list", { archived: true }))).toBe("This space has no archived teammates.");
  });
});
