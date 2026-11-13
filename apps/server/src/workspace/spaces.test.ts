import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { tempDir } from "@realm/test-utils";
import { SETTING_ACTIVE_SPACE, type SessionEvent, type Space } from "@realm/contracts";
import { createSpacesTools, SPACE_CREATE_PER_TURN, type SpacesDeps } from "./spaces";

/**
 * `space_list`, `space_switch` and `space_create` over faked stores and a faked window. What matters:
 * only the caller's profile, the user's card in front of a switch or a create, and an answer that says
 * whether the window actually moved — read back from what the window wrote, never assumed. A create
 * is refused outside a person's turn, past the per-turn cap, for a twin name and for a folder in a
 * system or secrets location; the folders are real ones, under a scratch home.
 */

const space = (id: string, profileId: string, name: string): Space =>
  ({ id, profileId, name, icon: "", color: "#000000", sortOrder: 0, folderPath: `/spaces/${id}`, groups: null, layout: null, activeItemId: null, createdAt: 1, updatedAt: 1 });
const SPACES = [space("s1", "p1", "Versed"), space("s2", "p1", "Homework"), space("s9", "p2", "Taxes")];

type Opts = { allow?: boolean; windowMoves?: boolean; personTurn?: boolean };

function setup(o: Opts = {}) {
  const all = [...SPACES];
  const settings = new Map<string, unknown>([[SETTING_ACTIVE_SPACE, "s1"]]);
  const calls = {
    gates: [] as { toolKey: string; title: string }[], broadcasts: [] as { event: string; payload: Record<string, unknown> }[], sleeps: 0,
    created: [] as { profileId: string; name: string; icon: string; color?: string }[],
    projects: [] as { spaceId: string; name: string; rootPath: string }[], notices: [] as { sessionId: string; ev: SessionEvent }[],
  };
  const userHome = realpathSync(tempDir("realm-space-create-home-"));
  const realmHome = join(userHome, "Realm");
  mkdirSync(realmHome);
  const turn = { n: 1 };
  const deps: SpacesDeps = {
    spaces: {
      get: (id) => all.find((s) => s.id === id) ?? null,
      list: (pid) => all.filter((s) => s.profileId === pid),
      create: (input) => {
        calls.created.push(input);
        const made = { ...space(`new${calls.created.length}`, input.profileId, input.name), icon: input.icon, folderPath: join(realmHome, "p", input.name) };
        all.push(made);
        return made;
      },
    },
    projects: { create: (input) => { calls.projects.push({ spaceId: input.spaceId, name: input.name, rootPath: input.rootPath }); return { id: `proj${calls.projects.length}` }; } },
    sessions: {
      personStartedTurn: () => o.personTurn !== false,
      publishServerEvent: (sessionId, ev) => { calls.notices.push({ sessionId, ev }); },
    },
    turnOrigin: () => "a message from @polish",
    turnOf: () => turn.n,
    userHome, realmHome,
    settings: { get: (k) => settings.get(k) ?? null },
    broker: { gate: async (_sid, toolKey, title) => { calls.gates.push({ toolKey, title }); return o.allow === false ? { allowed: false, reason: "the user denied this action" } : { allowed: true }; } },
    rpc: {
      broadcast: (event: string, payload: Record<string, unknown>) => {
        calls.broadcasts.push({ event, payload });
        // The window writes back the space it moved to, as the renderer's subscription does.
        if (event === "space.switchRequested" && o.windowMoves !== false) settings.set(SETTING_ACTIVE_SPACE, payload.spaceId);
      },
    } as unknown as SpacesDeps["rpc"],
    clock: { sleep: async () => { calls.sleeps++; } },
  };
  const g = createSpacesTools(deps);
  const call = (tool: string, args: unknown = {}) => g.handlers[tool]!({ sessionId: "me", spaceId: "s2" }, args);
  return { call, calls, settings, userHome, realmHome, turn };
}

const text = (r: CallToolResult) => r.content.map((c) => (c as { text: string }).text).join("\n");

describe("space_list", () => {
  it("lists this profile's spaces, marking the caller's and the window's, and nothing of another profile", async () => {
    const r = await setup().call("space_list");
    expect(text(r)).toContain(`- "Versed" — spaceId s1, folder /spaces/s1 [the window is showing it]`);
    expect(text(r)).toContain(`- "Homework" — spaceId s2, folder /spaces/s2 [you are here]`);
    expect(text(r)).not.toContain("Taxes");
  });
});

describe("space_switch", () => {
  it("asks, asks the window, and says it moved once the window says so", async () => {
    const s = setup();
    const r = await s.call("space_switch", { name: "Homework" });
    expect(r.isError).toBe(false);
    expect(s.calls.gates).toEqual([{ toolKey: "space_switch", title: `Move the window to the space "Homework"` }]);
    expect(s.calls.broadcasts).toEqual([{ event: "space.switchRequested", payload: { spaceId: "s2", requestedBy: "me" } }]);
    expect(text(r)).toBe(`The window is in "Homework" now.`);
  });

  it("says the window did not move when it does not — the user typing — and stops waiting", async () => {
    const s = setup({ windowMoves: false });
    const r = await s.call("space_switch", { spaceId: "s2" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(`the window did not move to "Homework": the user is typing`);
    expect(s.calls.sleeps).toBe(30);
  });

  it("moves nothing when the user says no", async () => {
    const s = setup({ allow: false });
    const r = await s.call("space_switch", { spaceId: "s2" });
    expect(text(r)).toBe("the user denied this action");
    expect(s.calls.broadcasts).toEqual([]);
  });

  it("refuses a space of another profile as one that is not there, before asking", async () => {
    const s = setup();
    const r = await s.call("space_switch", { spaceId: "s9" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(`there is no space id s9 in this profile`);
    expect(text(r)).not.toContain("Taxes");
    expect(s.calls.gates).toEqual([]);
  });

  it("asks nobody when the window is already there", async () => {
    const s = setup();
    const r = await s.call("space_switch", { spaceId: "s1" });
    expect(text(r)).toBe(`The window is already in "Versed".`);
    expect(s.calls.gates).toEqual([]);
  });
});

describe("space_create", () => {
  it("makes the space through the store with the sheet's defaults, tells every window, and says where it is", async () => {
    const s = setup();
    const r = await s.call("space_create", { name: "  Taxes 2026 " });
    expect(r.isError).toBe(false);
    expect(s.calls.created).toEqual([{ profileId: "p1", name: "Taxes 2026", icon: "folder", color: undefined }]);
    expect(s.calls.gates).toEqual([{ toolKey: "space_create", title: `Make a space "Taxes 2026"` }]);
    expect(s.calls.broadcasts).toEqual([{ event: "spaces.changed", payload: {} }]);
    expect(s.calls.notices.map((n) => [n.sessionId, n.ev.type, n.ev.payload])).toEqual([["me", "space_made", { spaceId: "new1", name: "Taxes 2026", note: "Made the space Taxes 2026" }]]);
    expect(text(r)).toBe(`Made the space "Taxes 2026" — spaceId new1. Its folder is ${join(s.realmHome, "p", "Taxes 2026")}. The window stays where it is: space_switch moves it there, and team_message can tell a teammate about it.`);
    expect(s.settings.get(SETTING_ACTIVE_SPACE)).toBe("s1");
  });

  it("moves the window there when asked, asking for the first session the sheet would open", async () => {
    const s = setup();
    const r = await s.call("space_create", { name: "Taxes", switchTo: true });
    expect(r.isError).toBe(false);
    expect(s.calls.gates[0]!.title).toBe(`Make a space "Taxes", and move the window there`);
    expect(s.calls.broadcasts).toEqual([{ event: "spaces.changed", payload: {} }, { event: "space.switchRequested", payload: { spaceId: "new1", requestedBy: "me", firstSession: { projectId: null } } }]);
    expect(s.settings.get(SETTING_ACTIVE_SPACE)).toBe("new1");
    expect(text(r)).toContain(`The window is in "Taxes" now.`);
  });

  it("refuses in a turn the person did not start, saying whose it was, and makes nothing", async () => {
    const s = setup({ personTurn: false });
    const r = await s.call("space_create", { name: "Taxes" });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("refused: this turn was started by a message from @polish, not by the person. Spaces are made only in a turn the person started; ask them to say it in this chat. Nothing was made.");
    expect(s.calls.created).toEqual([]);
    expect(s.calls.gates).toEqual([]);
  });

  it("makes no twin: a name the profile has, in any case and spacing, gives that space's id", async () => {
    const s = setup();
    const r = await s.call("space_create", { name: " homework " });
    expect(r.isError).toBe(false);
    expect(text(r)).toBe(`There is already a space "Homework" in this profile (spaceId s2, folder /spaces/s2), so nothing was made. space_switch moves the window to it.`);
    expect(s.calls.created).toEqual([]);
    expect(s.calls.gates).toEqual([]);
    // Another profile's "Taxes" is not this one's.
    expect((await s.call("space_create", { name: "Taxes" })).isError).toBe(false);
    expect(s.calls.created.map((c) => c.name)).toEqual(["Taxes"]);
  });

  it(`makes at most ${SPACE_CREATE_PER_TURN} in one turn, and counts again in the next`, async () => {
    const s = setup();
    for (const n of ["A", "B", "C"]) expect((await s.call("space_create", { name: n })).isError).toBe(false);
    const fourth = await s.call("space_create", { name: "D" });
    expect(fourth.isError).toBe(true);
    expect(text(fourth)).toContain(`this turn has already made ${SPACE_CREATE_PER_TURN} spaces`);
    expect(s.calls.created.map((c) => c.name)).toEqual(["A", "B", "C"]);
    expect(s.calls.gates).toHaveLength(3);
    s.turn.n = 2;
    expect((await s.call("space_create", { name: "D" })).isError).toBe(false);
  });

  it("does not count a space the user said no to", async () => {
    const s = setup({ allow: false });
    for (let i = 0; i < 4; i++) expect(text(await s.call("space_create", { name: `N${i}` }))).toBe("the user denied this action");
    expect(s.calls.gates).toHaveLength(4);
    expect(s.calls.created).toEqual([]);
    expect(s.calls.broadcasts).toEqual([]);
  });

  it("makes a folder of the user's the space's first project, ~ expanded and links resolved, writing nothing into it", async () => {
    const s = setup();
    mkdirSync(join(s.userHome, "code", "taxes"), { recursive: true });
    symlinkSync(join(s.userHome, "code", "taxes"), join(s.userHome, "taxes-link"));
    const r = await s.call("space_create", { name: "Taxes", folder: "~/taxes-link/" });
    expect(r.isError).toBe(false);
    const root = join(s.userHome, "code", "taxes");
    expect(s.calls.projects).toEqual([{ spaceId: "new1", name: "taxes", rootPath: root }]);
    expect(s.calls.broadcasts).toEqual([{ event: "items.changed", payload: { spaceId: "new1" } }, { event: "spaces.changed", payload: {} }]);
    expect(s.calls.gates[0]!.title).toBe(`Make a space "Taxes" working in ${root}`);
    expect(text(r)).toContain(`It works in ${root} (its first project)`);
  });

  it("asks for that first session in the folder's project when the space is made on one", async () => {
    const s = setup();
    mkdirSync(join(s.userHome, "taxes"));
    expect((await s.call("space_create", { name: "Taxes", folder: "~/taxes", switchTo: true })).isError).toBe(false);
    expect(s.calls.broadcasts.find((b) => b.event === "space.switchRequested")!.payload.firstSession).toEqual({ projectId: "proj1" });
  });

  it("refuses a folder that is not there, or is a file, without making it", async () => {
    const s = setup();
    writeFileSync(join(s.userHome, "notes.txt"), "x");
    expect(text(await s.call("space_create", { name: "A", folder: "~/nowhere" }))).toBe(`there is no folder at ${join(s.userHome, "nowhere")}. Name a folder that is there, or leave folder out and Realm makes the space one of its own. Nothing was made.`);
    expect(text(await s.call("space_create", { name: "A", folder: "~/notes.txt" }))).toContain("is a file, not a folder");
    expect(text(await s.call("space_create", { name: "A", folder: "code/taxes" }))).toContain("is not an absolute path");
    expect(s.calls.created).toEqual([]);
    expect(s.calls.gates).toEqual([]);
  });

  it("refuses system and secrets locations, through a link or a .. too, and Realm's own home", async () => {
    const s = setup();
    for (const d of [".ssh/keys", ".config", ".aws", ".gnupg", ".kube", ".docker", ".claude", ".codex", ".cursor", "Library/Caches", "work"]) mkdirSync(join(s.userHome, d), { recursive: true });
    symlinkSync(join(s.userHome, ".ssh", "keys"), join(s.userHome, "work", "keys"));
    const refused = async (folder: string, why: string) => {
      const r = await s.call("space_create", { name: "A", folder });
      expect(r.isError, folder).toBe(true);
      expect(text(r), folder).toContain(why);
    };
    await refused("/", "is the root of the disk");
    await refused("/System", "belongs to macOS");
    await refused("/Library", "belongs to macOS");
    await refused("~/Library/Caches", "belongs to macOS");
    await refused("~/.ssh", "holds keys and credentials");
    await refused("~/work/keys", `${join(s.userHome, "work", "keys")} is ${join(s.userHome, ".ssh", "keys")}, which is inside ~/.ssh`);
    await refused("~/work/../.config", "holds keys and credentials");
    for (const d of [".aws", ".gnupg", ".kube", ".docker"]) await refused(`~/${d}`, `is inside ~/${d}, which holds keys and credentials`);
    for (const d of [".claude", ".codex", ".cursor"]) await refused(`~/${d}`, `inside ~/${d}, an agent's own settings`);
    await refused(s.realmHome, "is Realm's own home");
    expect(s.calls.created).toEqual([]);
    expect(s.calls.gates).toEqual([]);
    // A space's own folder under Realm's home, and the folder holding it, are not the home itself.
    expect((await s.call("space_create", { name: "B", folder: "~/work" })).isError).toBe(false);
  });

  it("takes an icon from the picker's set or an emoji, and refuses another", async () => {
    const s = setup();
    expect((await s.call("space_create", { name: "A", icon: "rocket", color: "#ff0000" })).isError).toBe(false);
    expect((await s.call("space_create", { name: "B", icon: "emoji:🧾" })).isError).toBe(false);
    expect(text(await s.call("space_create", { name: "C", icon: "asset:01X" }))).toContain("invalid arguments: icon");
    expect(s.calls.created.map((c) => [c.icon, c.color])).toEqual([["rocket", "#ff0000"], ["emoji:🧾", undefined]]);
  });
});
