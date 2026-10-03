import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppStore } from "./store";
import { fakeApi } from "./store.test-fakes";

/** A stand-in for main's window registry: `owned` is the spaces other windows show. */
const install = ({ owned = [] as string[], assigned = null as string | null } = {}) => {
  const claims: { spaceId: string; intent: unknown }[] = [];
  const windows = {
    claimSpace: vi.fn(async (spaceId: string, intent?: unknown) => { claims.push({ spaceId, intent }); return { ok: !owned.includes(spaceId) }; }),
    assignedSpace: vi.fn(async () => assigned),
    claimedSpaces: vi.fn(async () => owned),
    newWindow: vi.fn(async () => {}),
  };
  (window as { realm?: unknown }).realm = { windows };
  return { windows, claims };
};
afterEach(() => { delete (window as { realm?: unknown }).realm; });

describe("one space per window", () => {
  /* THE mutant: switching anyway. The window would show a space another window already shows, and
     the two would mirror each other's layout through the server. */
  it("does not switch to a space another window shows; that window is brought forward instead", async () => {
    install({ owned: ["s2"] });
    const store = createAppStore(fakeApi());
    await store.getState().boot();
    expect(store.getState().activeSpaceId).toBe("s1");
    expect(await store.getState().selectSpace("s2")).toBe(false);
    expect(store.getState().activeSpaceId).toBe("s1");
  });

  it("hands a session to reveal to the window that owns its space, and counts that as landed", async () => {
    const { claims } = install({ owned: ["s2"] });
    const store = createAppStore(fakeApi());
    await store.getState().boot();
    expect(await store.getState().revealSession("sess-x", "s2")).toBe(true);
    expect(claims.at(-1)).toEqual({ spaceId: "s2", intent: { sessionId: "sess-x" } });
    expect(store.getState().activeSpaceId).toBe("s1");
  });

  it("comes back on the space it showed before a relaunch", async () => {
    install({ assigned: "s2" });
    const store = createAppStore(fakeApi());
    await store.getState().boot();
    expect(store.getState().activeSpaceId).toBe("s2");
  });

  /* A new window looks for a space quietly: refusals must not yank every other window forward. */
  it("opens a new window on a space no other window shows, asking quietly", async () => {
    const { claims } = install({ owned: ["s1"] });
    const store = createAppStore(fakeApi());
    await store.getState().boot();
    expect(store.getState().activeSpaceId).toBe("s2");
    expect(claims.every((c) => (c.intent as { raise?: boolean } | null)?.raise === false)).toBe(true);
  });

  it("offers to make a space when every space is already open in another window", async () => {
    install({ owned: ["s1", "s2"] });
    const store = createAppStore(fakeApi());
    await store.getState().boot();
    expect(store.getState().activeSpaceId).toBe(null);
    expect(store.getState().sheet).toEqual({ kind: "new-space" });
  });

  it("behaves as the only window where there is no bridge", async () => {
    const store = createAppStore(fakeApi());
    await store.getState().boot();
    expect(await store.getState().selectSpace("s2")).toBe(true);
    expect(store.getState().activeSpaceId).toBe("s2");
  });
});

describe("two switches in flight", () => {
  /* The claim is a round trip. THE mutant: an older switch, whose claim came back late, landing after
     a newer one — the window would end on the space the person switched AWAY from. */
  it("ends on the newer one even when the older one's claim answers last", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    (window as { realm?: unknown }).realm = { windows: {
      claimSpace: vi.fn(async (spaceId: string) => { if (spaceId === "s2") await gate; return { ok: true }; }),
      assignedSpace: async () => null, claimedSpaces: async () => [], newWindow: async () => {},
    } };
    const store = createAppStore(fakeApi());
    await store.getState().boot();
    const older = store.getState().selectSpace("s2");
    await store.getState().selectSpace("s1");
    release();
    await older;
    expect(store.getState().activeSpaceId).toBe("s1");
  });
});
