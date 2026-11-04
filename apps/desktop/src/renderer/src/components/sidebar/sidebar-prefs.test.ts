import { describe, expect, it } from "vitest";
import { createAppStore } from "../../state/store";
import { fakeApi, space } from "../../state/store.test-fakes";

/** The sidebar's remembered choice (Plan 27's store block): the lens. */
async function booted(settings: Record<string, unknown> = {}) {
  const api = fakeApi({ settings, spaces: [space("s1", "p1", "Versed"), space("s2", "p1", "Homework")] });
  const store = createAppStore(api);
  await store.getState().boot();
  return { api, store };
}

describe("the sidebar's remembered choices", () => {

  it("reads anything else a settings file holds as the resting state", async () => {
    for (const lens of ["sideways", 7, null] as const) {
      const { store } = await booted({ "ui.sidebarLens": lens });
      await store.getState().hydrateSidebarPrefs();
      expect(store.getState().sidebarLens, `lens ${JSON.stringify(lens)}`).toBe("spaces");
    }
  });

  it("lets a choice made while the settings are read win over what they said", async () => {
    const { store } = await booted({ "ui.sidebarLens": "spaces" });
    // The read is in flight when the person picks: the pick lands before it answers.
    const reading = store.getState().hydrateSidebarPrefs();
    await store.getState().setSidebarLens("recent");
    await reading;
    expect(store.getState().sidebarLens).toBe("recent");
  });
});
