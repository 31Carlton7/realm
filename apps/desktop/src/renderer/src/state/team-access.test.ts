import { describe, expect, it } from "vitest";
import type { TeamAccess, TeamAccessMode, Teammate } from "@realm/contracts";
import { teammatesSlice, type TeammatesApi, type TeammatesSlice } from "./teammates-slice";

/** The slice over a stand-in server holding one space's access, as `teams.access.*` answers it. */
function harness(initial: TeamAccess) {
  let access = initial;
  const calls: string[] = [];
  const api = {
    teammates: async () => [] as Teammate[],
    teamAccess: async (spaceId: string) => { calls.push(`get:${spaceId}`); return access; },
    setTeamAccess: async (spaceId: string, mode: TeamAccessMode | null) => {
      calls.push(`set:${spaceId}:${mode}`);
      access = { mode, mixed: false, teammates: access.teammates.map((t) => ({ ...t, mode: mode ?? t.mode })) };
      return access;
    },
    getSetting: async () => undefined,
    setSetting: async () => undefined,
  } as unknown as TeammatesApi & { getSetting(key: string): Promise<unknown>; setSetting(key: string, value: unknown): Promise<void> };
  let state = { spaces: [{ id: "sp1" }] } as unknown as TeammatesSlice & { spaces: { id: string }[] };
  const slice = teammatesSlice(api, () => state, (p) => { state = { ...state, ...p }; });
  state = { ...state, ...slice };
  return { get: () => state, calls, server: (next: TeamAccess) => { access = next; } };
}

describe("a space's Team access in the window", () => {
  it("is read when a control asks, and answered by the server once set", async () => {
    const h = harness({ mode: null, mixed: true, teammates: [{ handle: "cto", mode: "default" }, { handle: "ops", mode: "acceptEdits" }] });
    expect(h.get().teamAccess).toEqual({});
    await h.get().loadTeamAccess("sp1");
    expect(h.get().teamAccess.sp1).toEqual({ mode: null, mixed: true, teammates: [{ handle: "cto", mode: "default" }, { handle: "ops", mode: "acceptEdits" }] });
    await h.get().setTeamAccess("sp1", "bypassPermissions");
    expect(h.calls).toContain("set:sp1:bypassPermissions");
    expect(h.get().teamAccess.sp1).toEqual({ mode: "bypassPermissions", mixed: false, teammates: [{ handle: "cto", mode: "bypassPermissions" }, { handle: "ops", mode: "bypassPermissions" }] });
  });

  it("is read again with the space's teammates once held, and not before", async () => {
    const h = harness({ mode: "acceptEdits", mixed: false, teammates: [{ handle: "cto", mode: "acceptEdits" }] });
    await h.get().refreshTeammates("sp1");
    expect(h.calls).toEqual([]);
    await h.get().loadTeamAccess("sp1");
    // Edited one by one: the server says `teammates.changed`, and the held access follows.
    h.server({ mode: "acceptEdits", mixed: true, teammates: [{ handle: "cto", mode: "default" }] });
    await h.get().refreshTeammates("sp1");
    expect(h.get().teamAccess.sp1).toEqual({ mode: "acceptEdits", mixed: true, teammates: [{ handle: "cto", mode: "default" }] });
  });
});
