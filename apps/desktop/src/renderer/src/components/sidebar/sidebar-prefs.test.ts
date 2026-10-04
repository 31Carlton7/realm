import { describe, expect, it } from "vitest";
import { createAppStore } from "../../state/store";
import { fakeApi, space } from "../../state/store.test-fakes";

/** The sidebar's two remembered choices (Plan 27's store block): the lens, and the folded sections. */
async function booted(settings: Record<string, unknown> = {}) {
  const api = fakeApi({ settings, spaces: [space("s1", "p1", "Versed"), space("s2", "p1", "Homework")] });
  const store = createAppStore(api);
  await store.getState().boot();
  return { api, store };
}

describe("the sidebar's remembered choices", () => {
  it("rests on Spaces with every section open until anything is remembered", async () => {
    const { store } = await booted();
    await store.getState().hydrateSidebarPrefs();
    expect(store.getState().sidebarLens).toBe("spaces");
    expect(store.getState().sidebarCollapsedSpaces).toEqual([]);
  });

  it("comes back as it was left", async () => {
    const { store } = await booted({ "ui.sidebarLens": "recent", "ui.sidebarCollapsedSpaces": ["s2"] });
    await store.getState().hydrateSidebarPrefs();
    expect(store.getState().sidebarLens).toBe("recent");
    expect(store.getState().sidebarCollapsedSpaces).toEqual(["s2"]);
  });

  it("reads anything else a settings file holds as the resting state", async () => {
    for (const [lens, folded] of [["sideways", "s2"], [7, [3, "s1"]], [null, null]] as const) {
      const { store } = await booted({ "ui.sidebarLens": lens, "ui.sidebarCollapsedSpaces": folded });
      await store.getState().hydrateSidebarPrefs();
      expect(store.getState().sidebarLens, `lens ${JSON.stringify(lens)}`).toBe("spaces");
      expect(store.getState().sidebarCollapsedSpaces, `folded ${JSON.stringify(folded)}`).toEqual(Array.isArray(folded) ? ["s1"] : []);
    }
  });

  it("writes the lens when it changes", async () => {
    const { api, store } = await booted();
    await store.getState().setSidebarLens("recent");
    expect(store.getState().sidebarLens).toBe("recent");
    expect(api.calls).toContain("setSetting:ui.sidebarLens=recent");
  });

  it("remembers a folded section, and forgets it when it is opened again", async () => {
    const { api, store } = await booted();
    await store.getState().setSpaceSectionCollapsed("s2", true);
    expect(store.getState().sidebarCollapsedSpaces).toEqual(["s2"]);
    expect(api.data.settings["ui.sidebarCollapsedSpaces"]).toEqual(["s2"]);
    await store.getState().setSpaceSectionCollapsed("s2", false);
    expect(store.getState().sidebarCollapsedSpaces).toEqual([]);
  });

  it("drops a deleted space's id on the way past", async () => {
    const { store } = await booted({ "ui.sidebarCollapsedSpaces": ["gone"] });
    await store.getState().hydrateSidebarPrefs();
    await store.getState().setSpaceSectionCollapsed("s1", true);
    expect(store.getState().sidebarCollapsedSpaces).toEqual(["s1"]);
  });
});
