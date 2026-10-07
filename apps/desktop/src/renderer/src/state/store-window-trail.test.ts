import { describe, expect, it } from "vitest";
import { itemIdOfLeaf, type Layout } from "@realm/contracts";
import { createAppStore } from "./store";
import { fakeApi, item, session, space, type FakeData } from "./store.test-fakes";

const boot = async (overrides: FakeData = {}) => {
  const api = fakeApi(overrides);
  const store = createAppStore(api);
  await store.getState().boot();
  return { api, store };
};
type Store = Awaited<ReturnType<typeof boot>>["store"];
const stops = (store: Store) => store.getState().windowTrail.stops;
const where = (store: Store) => ({ spaceId: store.getState().activeSpaceId, itemId: itemIdOfLeaf(store.getState().layout, store.getState().focusedLeafId) });

/** You are in Versed, in a session; Homework holds another session and a terminal. A fresh copy per
 *  test: the fake writes into the fixture it is handed (a delete, a saved layout), and one test's
 *  delete must not be the next test's starting point. */
const twoSpaces = (): FakeData => ({
  spaces: [space("s1", "p1", "Versed", { layout: { type: "leaf", id: "L1", itemId: "i1" } }), space("s2", "p1", "Homework")],
  items: {
    s1: [item("i1", "s1", { kind: "session", refId: "se1", title: "Mine" })],
    s2: [item("i2", "s2", { kind: "session", refId: "se2", title: "Wants a yes" }), item("i3", "s2", { title: "Shell" })],
  },
  sessions: [session("se1", "s1"), session("se2", "s2", { status: "waiting_permission" })],
});

describe("the window's trail — where you were, across spaces", () => {
  it("starts where the window lands, and making another space current is one stop", async () => {
    const { store } = await boot(twoSpaces());
    expect(stops(store)).toEqual([{ spaceId: "s1", itemId: "i1" }]);
    await store.getState().selectSpace("s2");
    // Its newest session, in the pane that had the keyboard — and the stop names that space.
    expect(stops(store)).toEqual([{ spaceId: "s1", itemId: "i1" }, { spaceId: "s2", itemId: "i2" }]);
  });

  it("opening a session of another space is ONE stop, so Go back is one step to where you were", async () => {
    /* THE MUTANT: record the halfway points. A stop written between the open and the space it makes
       current would sit between you and where you came from — Go back would land you in the right
       space on the wrong pane, and take a second press to leave. */
    const { store } = await boot(twoSpaces());
    await store.getState().revealSession("se2", "s2");
    expect(stops(store)).toEqual([{ spaceId: "s1", itemId: "i1" }, { spaceId: "s2", itemId: "i2" }]);
    await store.getState().stepWindow(-1);
    expect(where(store)).toEqual({ spaceId: "s1", itemId: "i1" });
    await store.getState().stepWindow(1);
    expect(where(store)).toEqual({ spaceId: "s2", itemId: "i2" });
  });

  it("a step does not record itself: two presses of Back move two stops, and Forward is still there", async () => {
    const { store } = await boot(twoSpaces());
    await store.getState().revealSession("se2", "s2");
    await store.getState().openItem("i3");
    const walked = stops(store).map((s) => s.itemId);
    expect(walked).toEqual(["i1", "i2", "i3"]);
    await store.getState().stepWindow(-1);
    await store.getState().stepWindow(-1);
    expect(where(store)).toEqual({ spaceId: "s1", itemId: "i1" });
    expect(stops(store).map((s) => s.itemId)).toEqual(walked);
    expect(store.getState().canStepWindow(-1)).toBe(false);
    expect(store.getState().canStepWindow(1)).toBe(true);
  });

  it("moving the keyboard between panes is a stop of its own", async () => {
    const layout: Layout = { type: "split", id: "S", dir: "row", sizes: [50, 50], children: [
      { type: "leaf", id: "L1", itemId: "i1" }, { type: "leaf", id: "L2", itemId: "i4" }] };
    const base = twoSpaces();
    const { store } = await boot({ ...base,
      spaces: [space("s1", "p1", "Versed", { layout }), space("s2", "p1", "Homework")],
      items: { ...base.items, s1: [item("i1", "s1", { kind: "session", refId: "se1", title: "Mine" }), item("i4", "s1", { title: "Notes" })] } });
    const first = where(store).itemId;
    store.getState().focusLeaf(first === "i1" ? "L2" : "L1");
    expect(stops(store).map((s) => s.itemId)).toEqual([first, first === "i1" ? "i4" : "i1"]);
    await store.getState().stepWindow(-1);
    expect(where(store).itemId).toBe(first);
  });

  it("a stop whose item has gone lands in its space, and the way forward survives what comes after", async () => {
    /* THE MUTANT: leave the stop saying where it used to point. The window stands somewhere the trail
       does not say, so the next write of any kind — a status broadcast, a timer — reads it as
       somewhere new, records it, and drops everything ahead of it. */
    const { api, store } = await boot(twoSpaces());
    await store.getState().revealSession("se2", "s2");
    await store.getState().revealSession("se1", "s1");
    expect(stops(store).map((s) => `${s.spaceId}:${s.itemId}`)).toEqual(["s1:i1", "s2:i2", "s1:i1"]);
    api.data.items.s2 = api.data.items.s2!.filter((i) => i.id !== "i2"); // deleted from another window
    await store.getState().stepWindow(-1);
    expect(where(store).spaceId).toBe("s2");
    store.setState({}); // something else writes
    expect(store.getState().canStepWindow(1)).toBe(true);
    await store.getState().stepWindow(1);
    expect(where(store)).toEqual({ spaceId: "s1", itemId: "i1" });
  });

  it("opening a session from a list hands it the keyboard, and Go back hands it back", async () => {
    const { store } = await boot(twoSpaces());
    expect(store.getState().keyboardFor).toBeNull();
    await store.getState().revealSession("se2", "s2");
    expect(store.getState().keyboardFor).toEqual({ sessionId: "se2", n: 1 });
    await store.getState().stepWindow(-1);
    expect(store.getState().keyboardFor).toEqual({ sessionId: "se1", n: 2 });
  });
});
