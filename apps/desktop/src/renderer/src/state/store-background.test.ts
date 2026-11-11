import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_SETTING, LEGACY_BACKGROUND_KEY, migratedBackground } from "@realm/contracts";
import { createAppStore } from "./store";
import { fakeApi, type FakeData } from "./store.test-fakes";

const boot = async (data: FakeData = {}) => {
  const api = fakeApi(data);
  const store = createAppStore(api);
  await store.getState().boot();
  return { api, store };
};

describe("the background setting", () => {
  afterEach(() => window.localStorage.clear());

  it("is Sky with motion off for a home that never chose, and writes nothing to say so", async () => {
    const { api, store } = await boot();
    expect(store.getState().background).toBe("sky");
    expect(store.getState().backgroundMotion).toBe(false);
    expect(api.calls.filter((c) => c.startsWith(`setSetting:${BACKGROUND_SETTING}`))).toEqual([]);
  });

  it("carries phase 1's localStorage look into the setting once, then forgets the old key", async () => {
    window.localStorage.setItem(LEGACY_BACKGROUND_KEY, "silk");
    const { api, store } = await boot();
    expect(store.getState().background).toBe("silk");
    expect(api.calls).toContain(`setSetting:${BACKGROUND_SETTING}=silk`);
    expect(window.localStorage.getItem(LEGACY_BACKGROUND_KEY)).toBeNull();
  });

  it("leaves a stored choice alone, whatever the old key says", async () => {
    window.localStorage.setItem(LEGACY_BACKGROUND_KEY, "silk");
    const { api, store } = await boot({ settings: { [BACKGROUND_SETTING]: "off" } });
    expect(store.getState().background).toBe("off");
    expect(api.calls.filter((c) => c.startsWith(`setSetting:${BACKGROUND_SETTING}`))).toEqual([]);
    expect(window.localStorage.getItem(LEGACY_BACKGROUND_KEY)).toBeNull();
  });

  it("saves a pick and the Motion switch to the settings store", async () => {
    const { api, store } = await boot();
    await store.getState().setBackground("shuffle");
    await store.getState().setBackgroundMotion(true);
    expect(api.calls).toContain(`setSetting:${BACKGROUND_SETTING}=shuffle`);
    expect(api.calls).toContain("setSetting:ui.backgroundMotion=true");
  });
});

describe("migratedBackground", () => {
  const known = (id: string) => id === "haze" || id === "sky";
  it("writes only an unset setting, and only a look that still exists", () => {
    expect(migratedBackground(undefined, null, known)).toBeNull();
    expect(migratedBackground(null, "sky", known)).toBe("sky");
    expect(migratedBackground(undefined, "gone", known)).toBeNull();
    expect(migratedBackground("haze", "sky", known)).toBeNull();
    expect(migratedBackground("off", "sky", known)).toBeNull();
  });
});
