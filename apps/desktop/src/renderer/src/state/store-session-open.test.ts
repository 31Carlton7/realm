import { describe, expect, it } from "vitest";
import { createAppStore } from "./store";
import { findLeafOfItem, primaryLeaves, type Layout } from "@realm/contracts";
import { fakeApi, item, session, space, type FakeApi } from "./store.test-fakes";

/**
 * `session.openRequested`: a session an agent opened for the user with `session_open` goes on screen
 * beside THAT agent's pane, on the edge it asked for, without moving the keyboard.
 */

function api(): FakeApi {
  return fakeApi({
    spaces: [space("s1", "p1", "Versed")],
    items: { s1: [item("i-a", "s1", { kind: "session", refId: "a", title: "A" }), item("i-c", "s1", { kind: "session", refId: "c", title: "C" })] },
    sessions: [session("a", "s1", { updatedAt: 3 }), session("c", "s1", { updatedAt: 1 })],
  });
}

async function withA(a: FakeApi) {
  const store = createAppStore(a);
  await store.getState().boot();
  await store.getState().openItem("i-a");
  return store;
}

/** The new session's row arriving, as `items.changed` would bring it. */
const arrive = (a: FakeApi) => { a.data.items.s1!.push(item("i-n", "s1", { kind: "session", refId: "n", title: "N" })); a.data.sessions.push(session("n", "s1")); };

const splitDir = (l: Layout) => (l.type === "split" ? l.dir : null);

describe("a session an agent opened with session_open", () => {
  it("goes below the agent's pane when asked, and the keyboard stays put", async () => {
    const a = api();
    const store = await withA(a);
    const focus = store.getState().focusedLeafId;
    arrive(a);
    await store.getState().applySessionOpenRequested({ spaceId: "s1", sessionId: "n", itemId: "i-n", openedBy: "a", edge: "bottom" });
    const layout = store.getState().layout!;
    expect(primaryLeaves(layout).map((l) => l.itemId)).toEqual(["i-a", "i-n"]);
    expect(splitDir(layout)).toBe("col");
    expect(store.getState().focusedLeafId).toBe(focus);
  });

  it("goes to the right by the agent's pane, not the one with focus", async () => {
    const a = api();
    const store = await withA(a);
    await store.getState().openItemAt("i-c", findLeafOfItem(store.getState().layout!, "i-a")!.id, "right");
    const cLeaf = findLeafOfItem(store.getState().layout!, "i-c")!.id;
    store.setState({ focusedLeafId: cLeaf });
    arrive(a);
    await store.getState().applySessionOpenRequested({ spaceId: "s1", sessionId: "n", itemId: "i-n", openedBy: "a", edge: "right" });
    expect(primaryLeaves(store.getState().layout!).map((l) => l.itemId)).toEqual(["i-a", "i-n", "i-c"]);
    expect(store.getState().focusedLeafId).toBe(cLeaf);
  });

  it("stays a sidebar row when the agent's own pane is not on screen", async () => {
    const a = api();
    const store = await withA(a);
    arrive(a);
    const before = store.getState().layout;
    await store.getState().applySessionOpenRequested({ spaceId: "s1", sessionId: "n", itemId: "i-n", openedBy: "c", edge: "right" });
    expect(store.getState().layout).toBe(before);
    expect(store.getState().items.some((i) => i.id === "i-n")).toBe(true);
  });
});
