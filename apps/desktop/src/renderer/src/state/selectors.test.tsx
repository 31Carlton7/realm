import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { StoreContext, createAppStore } from "./store";
import { currentSpaceId, pinnedItems, sessionsBySpace, useCurrentSpaceId, usePinnedItems, useSessionsBySpace } from "./selectors";
import { fakeApi, item, profile, session, space } from "./store.test-fakes";

/** Two spaces of Work — Homework sorted first — and one of School, which this window does not show. */
function home() {
  return fakeApi({
    profiles: [profile("p1", "Work"), profile("p2", "School")],
    spaces: [space("s2", "p1", "Homework", { sortOrder: 0 }), space("s1", "p1", "Versed", { sortOrder: 1 }), space("s9", "p2", "Thesis")],
    items: {
      s1: [item("a", "s1", { kind: "session", refId: "sa", pinned: true }), item("t", "s1", { kind: "terminal", pinned: true, sortOrder: 2 }),
        item("old", "s1", { kind: "session", refId: "so", archived: true, pinned: true })],
      s2: [item("b", "s2", { kind: "session", refId: "sb" }), item("c", "s2", { kind: "session", refId: "sc", pinned: true })],
      s9: [item("z", "s9", { kind: "session", refId: "sz", pinned: true })],
    },
    sessions: [session("sa", "s1", { updatedAt: 1 }), session("sb", "s2", { updatedAt: 5 }), session("sc", "s2", { updatedAt: 9 }),
      session("so", "s1", { updatedAt: 99 }), session("sz", "s9", { updatedAt: 50 })],
  });
}

async function booted() {
  const api = home();
  const store = createAppStore(api);
  await store.getState().boot();
  return { api, store };
}

describe("the sidebar's selectors", () => {
  it("lists the profile's spaces as sections, in their order, each with its sessions newest first", async () => {
    const { store } = await booted();
    const sections = sessionsBySpace(store.getState());
    // THE MUTANTS: list every profile's spaces, or keep the room's one — and archived rows in the list.
    expect(sections.map((x) => x.space.id)).toEqual(["s2", "s1"]);
    expect(sections.map((x) => x.sessions.map((i) => i.id))).toEqual([["c", "b"], ["a"]]);
  });

  it("re-sorts a section when a session moves — a status change is activity", async () => {
    const { store } = await booted();
    store.getState().applySessionStatus("sb", "running");
    expect(sessionsBySpace(store.getState())[0]!.sessions.map((i) => i.id)).toEqual(["b", "c"]);
  });

  it("gathers the pins across every space of the profile, in the spaces' order", async () => {
    const { store } = await booted();
    // Not the archived one, and not another profile's.
    expect(pinnedItems(store.getState()).map((i) => i.id)).toEqual(["c", "a", "t"]);
  });

  it("names the current space, following the focus", async () => {
    const { store } = await booted();
    await store.getState().openItem("a");
    expect(currentSpaceId(store.getState())).toBe("s1");
    await store.getState().openItemBeside("b");
    expect(currentSpaceId(store.getState())).toBe("s2");
  });

  it("is empty before a profile is the window's", () => {
    const store = createAppStore(home());
    expect(sessionsBySpace(store.getState())).toEqual([]);
    expect(pinnedItems(store.getState())).toEqual([]);
  });

  it("hands React the same answer until something it reads changes", async () => {
    const { store } = await booted();
    const wrapper = ({ children }: { children: ReactNode }) => <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
    const { result } = renderHook(() => ({ sections: useSessionsBySpace(), pins: usePinnedItems(), current: useCurrentSpaceId() }), { wrapper });
    const first = result.current;
    act(() => { store.setState({ paletteOpen: true }); }); // an unrelated write
    expect(result.current.sections).toBe(first.sections);
    expect(result.current.pins).toBe(first.pins);
    await act(async () => { await store.getState().updateItem({ id: "b", pinned: true }); });
    expect(result.current.pins.map((i) => i.id)).toEqual(["b", "c", "a", "t"]);
    expect(result.current.current).toBe(store.getState().activeSpaceId);
  });
});
