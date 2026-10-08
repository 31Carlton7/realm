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

describe("an agent's space_switch, as the window carries it out", () => {
  function twoSpaces(): FakeApi {
    return fakeApi({
      spaces: [space("s1", "p1", "Versed"), space("s2", "p1", "Homework")],
      items: { s1: [item("i-a", "s1", { kind: "session", refId: "a", title: "A" })], s2: [item("i-b", "s2", { kind: "session", refId: "b", title: "B" })] },
      sessions: [session("a", "s1", { updatedAt: 3 }), session("b", "s2", { updatedAt: 2 })],
    });
  }

  it("moves the window to the space, as the user's own switch would", async () => {
    const store = await withA(twoSpaces());
    expect(store.getState().activeSpaceId).toBe("s1");
    await store.getState().applySpaceSwitchRequested({ spaceId: "s2" }, false);
    expect(store.getState().activeSpaceId).toBe("s2");
  });

  it("stays put while the user is typing", async () => {
    const store = await withA(twoSpaces());
    await store.getState().applySpaceSwitchRequested({ spaceId: "s2" }, true);
    expect(store.getState().activeSpaceId).toBe("s1");
  });
});

describe("a setting an agent changed with settings_set", () => {
  it("takes effect in the window as its own Settings would, for the keys on the list and the values they take", async () => {
    const store = await withA(api());
    store.getState().applySettingChanged({ key: "ui.theme", value: "dark" });
    expect(store.getState().themePref).toBe("dark");
    store.getState().applySettingChanged({ key: "ui.submitKey", value: "cmdEnter" });
    expect(store.getState().submitKey).toBe("cmdEnter");
    store.getState().applySettingChanged({ key: "sessions.midTurnMode", value: "steer" });
    expect(store.getState().midTurnMode).toBe("steer");
    store.getState().applySettingChanged({ key: "ui.theme", value: "plaid" });
    expect(store.getState().themePref).toBe("dark");
    const before = store.getState();
    store.getState().applySettingChanged({ key: "sessions.defaultPermissionMode", value: "bypassPermissions" });
    expect(store.getState()).toBe(before);
  });
});
