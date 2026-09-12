import { afterEach, describe, expect, it } from "vitest";
import { allThemes, isThemeName, setCustomThemes, themeModes, themeSwatches } from "@realm/ui";
import { createAppStore } from "./store";
import { fakeApi, type FakeData } from "./store.test-fakes";

const DARK_IMPORT = {
  id: "night-owl", label: "Night Owl", mode: "dark" as const,
  seed: { bg: "#011627", ink: "#d6deeb", accent: "#82aaff", green: "#addb67", orange: "#ecc48d", red: "#ef5350",
    syntax: { comment: "#637777", keyword: "#c792ea", string: "#ecc48d", number: "#f78c6c", title: "#82aaff", type: "#ffcb8b", attr: "#addb67" } },
  source: { file: "/x/Night Owl.json", derived: [] },
};

const boot = async (overrides: FakeData = {}) => {
  const api = fakeApi(overrides);
  const store = createAppStore(api);
  await store.getState().boot();
  return { api, store };
};

// The registry is module state in @realm/ui, so a test that leaves one behind poisons the next.
afterEach(() => setCustomThemes([]));

describe("imported VS Code themes", () => {
  it("are loaded at boot and become real palette names", async () => {
    /* THE MUTANT: load them after the spaces are published. `applyTheme` resolves a palette name
       through the registry, so a saved selection naming an import would fall back to `realm` for a
       frame and then repaint — one frame of the wrong colours on every launch. */
    const { store } = await boot({ customThemes: [DARK_IMPORT] });
    expect(store.getState().customThemes).toHaveLength(1);
    expect(isThemeName("night-owl")).toBe(true);
    expect(allThemes().some((t) => t.name === "night-owl")).toBe(true);
  });

  it("offer only the face the VS Code file actually stated", async () => {
    // A VS Code theme states one face. Offering a dark import to the light slot would derive a light
    // palette from a dark ground, whose surface ramp climbs the wrong way.
    await boot({ customThemes: [DARK_IMPORT] });
    expect(themeModes("night-owl")).toEqual(["dark"]);
  });

  it("derive a full palette from the thirteen, like any vendored one", async () => {
    await boot({ customThemes: [DARK_IMPORT] });
    const [page, surface, accent] = themeSwatches("night-owl", "dark");
    for (const c of [page, surface, accent]) expect(c).toMatch(/^oklch|^#|^color/);
    // The ground is the theme's, not Realm's — the whole point of the import.
    expect(themeSwatches("night-owl", "dark")[0]).not.toBe(themeSwatches("realm", "dark")[0]);
  });

  it("importing selects the new theme for the face it has", async () => {
    const { api, store } = await boot({ pickedThemeFile: "/x/Night Owl.json", importedTheme: DARK_IMPORT });
    const id = await store.getState().importThemeFile();
    expect(id).toBe("night-owl");
    expect(api.calls).toContain("importTheme:/x/Night Owl.json");
    await store.getState().setThemeName("dark", id!);
    expect(store.getState().themeNames.dark).toBe("night-owl");
  });

  it("a cancelled picker imports nothing at all", async () => {
    const { api, store } = await boot({ pickedThemeFile: null });
    expect(await store.getState().importThemeFile()).toBeNull();
    expect(api.calls.some((c) => c.startsWith("importTheme:"))).toBe(false);
  });

  it("removing one moves any face that was wearing it back to Realm", async () => {
    /* THE MUTANT: delete the file and stop. `paletteFor` would quietly answer `realm` for a name
       that no longer resolves — the window would look right and the SETTING would still name a
       theme that is gone, which is the state that survives a restart and confuses everyone. */
    const { store } = await boot({ customThemes: [DARK_IMPORT] });
    await store.getState().setThemeName("dark", "night-owl");
    await store.getState().removeCustomTheme("night-owl");
    expect(store.getState().themeNames.dark).toBe("realm");
    expect(store.getState().customThemes).toEqual([]);
    expect(isThemeName("night-owl")).toBe(false);
  });

  it("an import cannot shadow a vendored palette by naming itself after one", async () => {
    // A file drop replacing a shipped theme is not something an import should be able to do.
    await boot({ customThemes: [{ ...DARK_IMPORT, id: "monokai", label: "Not Monokai" }] });
    expect(allThemes().filter((t) => t.name === "monokai")).toHaveLength(1);
    expect(allThemes().find((t) => t.name === "monokai")!.label).toBe("Monokai");
  });
});
