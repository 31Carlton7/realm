import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter, type FakeScript } from "@realm/adapters";
import type { SessionEvent, StoredSessionEvent } from "@realm/contracts";
import { createApp, type App } from "../app";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { waitFor } from "../test-utils";

/**
 * `space_create` over the real app, its store and the scripted agent: a space made in the person's
 * turn is the same row the New space sheet makes — the folder Realm allocates, made on disk, in the
 * caller's profile — with a line in the chat; the same ask in a teammate's turn makes nothing.
 */

let app: App;
afterEach(async () => { await app?.close(); app = undefined!; });

const SCRIPT: FakeScript = [
  { on: "make a space called Taxes", emit: [{ kind: "call", tool: "realm-workspace__space_create", input: { name: "Taxes" } }, { kind: "text", text: "Done." }] },
];

async function boot() {
  const home = tempDir("realm-space-create-");
  const fake = new FakeAdapter({ script: SCRIPT, delayMs: 2 });
  app = await createApp({ home, port: 0, adapters: { fake, claude: fake }, agentRun: { fallbackKind: "fake" } });
  const profile = new ProfilesStore(app.db).create({ name: "Carlton", icon: "x", color: "#000" });
  const other = new ProfilesStore(app.db).create({ name: "Work", icon: "x", color: "#000" });
  const space = new SpacesStore(app.db, home).create({ profileId: profile.id, name: "Realm", icon: "folder" });
  const captain = app.team.create({ spaceId: space.id, name: "Captain", brief: "You are Captain.", agentKind: "fake", lead: true, permissionMode: "bypassPermissions" });
  const polish = app.team.create({ spaceId: space.id, name: "Polish", brief: "You are Polish.", agentKind: "fake", permissionMode: "bypassPermissions" });
  return { home, profile, other, space, captain, polish };
}

const spacesIn = (profileId: string) => new SpacesStore(app.db, "").list(profileId);
const events = (sessionId: string): SessionEvent[] => app.sessions.events(sessionId, 0, 2_000).map((e: StoredSessionEvent) => e.event);
const results = (sessionId: string) => events(sessionId).flatMap((e) => (e.type === "tool_result" ? [e.payload] : []));
const answered = async (sessionId: string) => {
  await waitFor(() => results(sessionId).length >= 1 && app.sessions.get(sessionId).status === "idle");
  return results(sessionId)[0]!;
};

describe("space_create, end to end", () => {
  it("makes the sheet's space in the caller's profile, in the person's turn, with a line in the chat", async () => {
    const { home, profile, other, captain } = await boot();
    const changed: string[] = [];
    const broadcast = app.rpc.broadcast.bind(app.rpc);
    app.rpc.broadcast = ((event: string, payload: never) => { changed.push(event); broadcast(event as never, payload); }) as typeof app.rpc.broadcast;
    await app.team.message(captain.id, "please make a space called Taxes");
    const r = await answered(captain.homeSessionId!);
    expect(r.isError).toBe(false);
    const made = spacesIn(profile.id).find((s) => s.name === "Taxes")!;
    expect(made).toBeDefined();
    expect(made.folderPath).toBe(join(home, "carlton", "taxes"));
    expect(existsSync(made.folderPath)).toBe(true);
    expect(made.icon).toBe("folder");
    expect(spacesIn(other.id)).toEqual([]);
    expect(r.content).toContain(`spaceId ${made.id}`);
    const lines = events(captain.homeSessionId!).flatMap((e) => (e.type === "space_made" ? [e.payload] : []));
    expect(lines).toEqual([{ spaceId: made.id, name: "Taxes", note: "Made the space Taxes" }]);
    expect(changed).toContain("spaces.changed");
  });

  it("makes nothing in a turn a teammate's message started, and says so", async () => {
    const { profile, captain, polish } = await boot();
    await app.team.teamMessage({ sessionId: polish.homeSessionId!, spaceId: captain.spaceId }, { to: "lead", message: "make a space called Taxes" });
    const r = await answered(captain.homeSessionId!);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("this turn was started by a message from @polish, not by the person");
    expect(spacesIn(profile.id).map((s) => s.name)).toEqual(["Realm"]);
  });
});
