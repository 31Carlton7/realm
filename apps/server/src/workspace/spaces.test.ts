import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SETTING_ACTIVE_SPACE, type Space } from "@realm/contracts";
import { createSpacesTools, type SpacesDeps } from "./spaces";

/**
 * `space_list` and `space_switch` over faked stores and a faked window. What matters: only the
 * caller's profile, the user's card in front of a switch, and an answer that says whether the window
 * actually moved — read back from what the window wrote, never assumed.
 */

const space = (id: string, profileId: string, name: string): Space =>
  ({ id, profileId, name, icon: "", color: "#000000", sortOrder: 0, folderPath: `/spaces/${id}`, groups: null, layout: null, activeItemId: null, createdAt: 1, updatedAt: 1 });
const SPACES = [space("s1", "p1", "Versed"), space("s2", "p1", "Homework"), space("s9", "p2", "Taxes")];

type Opts = { allow?: boolean; windowMoves?: boolean };

function setup(o: Opts = {}) {
  const settings = new Map<string, unknown>([[SETTING_ACTIVE_SPACE, "s1"]]);
  const calls = { gates: [] as { toolKey: string; title: string }[], broadcasts: [] as { event: string; payload: Record<string, unknown> }[], sleeps: 0 };
  const deps: SpacesDeps = {
    spaces: { get: (id) => SPACES.find((s) => s.id === id) ?? null, list: (pid) => SPACES.filter((s) => s.profileId === pid) },
    settings: { get: (k) => settings.get(k) ?? null },
    broker: { gate: async (_sid, toolKey, title) => { calls.gates.push({ toolKey, title }); return o.allow === false ? { allowed: false, reason: "the user denied this action" } : { allowed: true }; } },
    rpc: {
      broadcast: (event: string, payload: Record<string, unknown>) => {
        calls.broadcasts.push({ event, payload });
        // The window writes back the space it moved to, as the renderer's subscription does.
        if (o.windowMoves !== false) settings.set(SETTING_ACTIVE_SPACE, payload.spaceId);
      },
    } as unknown as SpacesDeps["rpc"],
    clock: { sleep: async () => { calls.sleeps++; } },
  };
  const g = createSpacesTools(deps);
  const call = (tool: string, args: unknown = {}) => g.handlers[tool]!({ sessionId: "me", spaceId: "s2" }, args);
  return { call, calls, settings };
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
