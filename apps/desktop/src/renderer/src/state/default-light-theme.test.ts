import { describe, expect, it } from "vitest";
import { createAppStore } from "./store";
import { fakeApi, type FakeData } from "./store.test-fakes";

const boot = async (overrides: FakeData = {}) => {
  const api = fakeApi(overrides);
  const store = createAppStore(api);
  await store.getState().boot();
  return { api, store };
};

describe("the light palette a home boots into", () => {
  it("is Codex for a home that never chose one", async () => {
    // THE old-default mutant: fall back to `realm` in storedPalette. A fresh install would boot into
    // Realm's palette while the picker's default says Codex.
    const { api, store } = await boot();
    expect(store.getState().themeNames).toEqual({ light: "codex", dark: "realm" });
    // Defaulted, not saved: nothing is written, so a later default can still reach this home.
    expect(api.calls.filter((c) => c.startsWith("setSetting:ui.themeName"))).toEqual([]);
  });

  it("is the saved one when the home has chosen — One stays One", async () => {
    // THE override-the-owner mutant: force Codex on every boot. The owner's saved palette is the
    // choice the default exists to stand in for, never to replace.
    const { store } = await boot({ settings: { "ui.themeName.light": "one" } });
    expect(store.getState().themeNames.light).toBe("one");
  });

  it("keeps Realm for a home that chose Realm", async () => {
    const { store } = await boot({ settings: { "ui.themeName.light": "realm" } });
    expect(store.getState().themeNames.light).toBe("realm");
  });

  it("reads the single selection an older build saved, where that palette has a light face", async () => {
    expect((await boot({ settings: { "ui.themeName": "solarized" } })).store.getState().themeNames.light).toBe("solarized");
    // A dark-only palette in the old key says nothing about light, so light takes the default.
    expect((await boot({ settings: { "ui.themeName": "monokai" } })).store.getState().themeNames).toEqual({ light: "codex", dark: "monokai" });
  });
});
