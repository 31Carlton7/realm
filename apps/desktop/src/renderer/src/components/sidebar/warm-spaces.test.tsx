import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Rail } from "./Rail";
import { spacesToRead } from "./use-warm-spaces";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session, space, type FakeApi } from "../../state/store.test-fakes";

/** Three spaces of one profile: the window lands in Versed, Homework was used before Errands. */
function home() {
  return fakeApi({
    spaces: [space("s1", "p1", "Versed"), space("s2", "p1", "Homework"), space("s3", "p1", "Errands")],
    items: { s1: [item("i1", "s1")], s2: [item("i2", "s2")], s3: [item("i3", "s3")] },
    sessions: [session("se2", "s2", { activityAt: 300 }), session("se3", "s3", { activityAt: 200 })],
  });
}

const LISTS = ["listItems", "listSessions", "listEnvironments", "listProjects"] as const;

/** Each list read of a space as it starts and ends, so a test can see two spaces read at once. */
function traceReads(api: FakeApi) {
  const trace: string[] = [];
  for (const name of LISTS) {
    const real = api[name] as (sid: string) => Promise<unknown>;
    (api as unknown as Record<string, unknown>)[name] = async (sid: string) => {
      trace.push(`start:${sid}`);
      try { return await real(sid); } finally { trace.push(`end:${sid}`); }
    };
  }
  return trace;
}

async function mount(api: FakeApi) {
  const store = createAppStore(api);
  await store.getState().boot();
  const r = render(<StoreContext.Provider value={store}><Rail /></StoreContext.Provider>);
  return { store, ...r };
}

const itemReads = (api: FakeApi, sid: string) => api.calls.filter((c) => c === `listItems:${sid}`).length;
const tile = (name: string) => screen.getByRole("button", { name });

afterEach(() => cleanup());

describe("warming the other spaces", () => {
  it("reads every space the window has not read once its own space is up, most recently used first", async () => {
    const api = home();
    const { store } = await mount(api);
    expect(store.getState().heldSpaces).toEqual(["s1"]);
    // THE MUTANT: the background read never starts, and the first switch waits on the read.
    await waitFor(() => expect([...store.getState().heldSpaces].sort()).toEqual(["s1", "s2", "s3"]));
    const order = api.calls.filter((c) => /^listItems:s[23]$/.test(c));
    expect(order).toEqual(["listItems:s2", "listItems:s3"]);
    expect(itemReads(api, "s1")).toBe(1);
  });

  it("goes by when a space was last used, not where it sits in the rail", async () => {
    const api = home();
    api.data.sessions = [session("se2", "s2", { activityAt: 100 }), session("se3", "s3", { activityAt: 400 })];
    const { store } = await mount(api);
    await waitFor(() => expect(store.getState().heldSpaces).toHaveLength(3));
    expect(api.calls.filter((c) => /^listItems:s[23]$/.test(c))).toEqual(["listItems:s3", "listItems:s2"]);
  });

  it("waits for the window to be idle before each space", async () => {
    const pending: (() => void)[] = [];
    vi.stubGlobal("requestIdleCallback", (cb: () => void) => { pending.push(cb); return pending.length; });
    try {
      const api = home();
      const { store } = await mount(api);
      await new Promise((r) => setTimeout(r, 20));
      expect(itemReads(api, "s2")).toBe(0);
      pending.shift()!();
      await waitFor(() => expect(store.getState().heldSpaces).toContain("s2"));
      await new Promise((r) => setTimeout(r, 20));
      expect(itemReads(api, "s3")).toBe(0);
      pending.shift()!();
      await waitFor(() => expect(store.getState().heldSpaces).toContain("s3"));
    } finally { vi.unstubAllGlobals(); }
  });

  it("reads one space at a time", async () => {
    const api = home();
    api.delays["listItems:s2"] = 30;
    const trace = traceReads(api);
    const { store } = await mount(api);
    trace.length = 0;
    await waitFor(() => expect(store.getState().heldSpaces).toHaveLength(3));
    // Every read of Homework ends before the first read of Errands starts.
    const lastOfS2 = trace.lastIndexOf("end:s2");
    const firstOfS3 = trace.indexOf("start:s3");
    expect(lastOfS2).toBeGreaterThanOrEqual(0);
    expect(firstOfS3).toBeGreaterThan(lastOfS2);
  });

  it("moves on from a space whose read fails, and does not ask it again", async () => {
    const api = home();
    const real = api.listItems;
    api.listItems = async (sid) => { if (sid === "s2") { api.calls.push("listItems:s2"); throw new Error("gone"); } return real(sid); };
    const { store } = await mount(api);
    await waitFor(() => expect(store.getState().heldSpaces).toContain("s3"));
    await new Promise((r) => setTimeout(r, 40));
    expect(itemReads(api, "s2")).toBe(1);
  });

  it("stops when the rail goes away", async () => {
    const api = home();
    api.delays["listItems:s2"] = 300;
    const { store, unmount } = await mount(api);
    await waitFor(() => expect(itemReads(api, "s2")).toBe(1));
    expect(store.getState().heldSpaces).not.toContain("s2");
    unmount();
    await waitFor(() => expect(store.getState().heldSpaces).toContain("s2"));
    await new Promise((r) => setTimeout(r, 40));
    expect(itemReads(api, "s3")).toBe(0);
  });

  it("starts a space's read when the pointer comes onto its tile, and never a second one alongside it", async () => {
    const api = home();
    // The pass is held on Homework, so Errands is read only because the pointer asked.
    api.delays["listItems:s2"] = 60;
    api.delays["listItems:s3"] = 30;
    const { store } = await mount(api);
    await waitFor(() => expect(itemReads(api, "s2")).toBe(1));
    expect(itemReads(api, "s3")).toBe(0);
    fireEvent.pointerEnter(tile("Errands"));
    expect(itemReads(api, "s3")).toBe(1);
    fireEvent.pointerEnter(tile("Errands"));
    fireEvent.pointerEnter(tile("Homework"));
    expect(itemReads(api, "s3")).toBe(1);
    expect(itemReads(api, "s2")).toBe(1);
    await waitFor(() => expect(store.getState().heldSpaces).toHaveLength(3));
    // The pass, reaching Errands after Homework, finds it read and reads nothing.
    await new Promise((r) => setTimeout(r, 20));
    expect(itemReads(api, "s3")).toBe(1);
    expect(itemReads(api, "s2")).toBe(1);
    fireEvent.pointerEnter(tile("Versed"));
    expect(itemReads(api, "s1")).toBe(1);
  });

  it("lists only the window's profile's spaces it does not hold", async () => {
    const api = home();
    api.data.spaces.push({ ...api.data.spaces[1]!, id: "s9", profileId: "p2", name: "School" });
    const store = createAppStore(api);
    await store.getState().boot();
    expect(spacesToRead(store.getState())).toEqual(["s2", "s3"]);
  });
});
