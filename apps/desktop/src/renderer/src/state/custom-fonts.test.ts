import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppStore } from "./store";
import { fakeApi, type FakeData } from "./store.test-fakes";
import { loadInstalledFaces, localFamilies, publishFontFaces } from "./font-sources";

const FONT = { family: "Iosevka", weights: [400, 500], bytes: 2048 };

const boot = async (overrides: FakeData = {}) => {
  const api = fakeApi(overrides);
  const store = createAppStore(api);
  await store.getState().boot();
  return { api, store };
};

afterEach(() => {
  document.getElementById("realm-installed-fonts")?.remove();
  delete (window as { queryLocalFonts?: unknown }).queryLocalFonts;
});

describe("fonts already on this Mac", () => {
  it("are read as FAMILIES, not as the faces the API answers with", async () => {
    /* `queryLocalFonts()` returns seven hundred faces on a real machine — "Al Bayan Plain" and
       "Al Bayan Bold" as separate entries — and a picker wants families. */
    (window as { queryLocalFonts?: unknown }).queryLocalFonts = async () => [
      { family: "Al Bayan" }, { family: "Al Bayan" }, { family: "Iosevka" },
    ];
    expect(await localFamilies()).toEqual(["Al Bayan", "Iosevka"]);
  });

  it("are simply absent where the API is missing or refused — never an error", async () => {
    // THE MUTANT: let it throw. This is an extra source of choices, and losing it must not cost the
    // user the bundled and Google ones beside it.
    expect(await localFamilies()).toEqual([]);
    (window as { queryLocalFonts?: unknown }).queryLocalFonts = async () => { throw new Error("denied"); };
    expect(await localFamilies()).toEqual([]);
  });
});

describe("fonts downloaded from Google", () => {
  it("reach the document as @font-face rules before the state says they exist", async () => {
    /* THE MUTANT: set the state first. A preference naming a family whose `@font-face` is not in the
       document yet paints one frame in the fallback and then reflows every label in the window. */
    const { store } = await boot({ installedFonts: [FONT] });
    const css = document.getElementById("realm-installed-fonts")!.textContent!;
    expect(css).toContain('font-family:"Iosevka"');
    expect(css).toContain("url(data:font/woff2;base64,");
    expect(store.getState().installedFonts).toEqual([FONT]);
  });

  it("block rather than swap, because the bytes are already here", async () => {
    // A swap at boot paints the whole app in the fallback and reflows it a moment later, for a
    // download that has already happened.
    await boot({ installedFonts: [FONT] });
    expect(document.getElementById("realm-installed-fonts")!.textContent).toContain("font-display:block");
  });

  it("one family that will not read costs that family, not the set", async () => {
    const faces = await loadInstalledFaces(
      [FONT, { family: "Broken", weights: [400], bytes: 1 }],
      async (family) => { if (family === "Broken") throw new Error("gone"); return { faces: [{ weight: 400, base64: "AA==" }] }; },
    );
    expect(faces.map((f) => f.family)).toEqual(["Iosevka"]);
  });

  it("replace the whole rule set rather than appending to it", () => {
    // One element, replaced wholesale: a per-family element would be a set of nodes to reconcile,
    // and a removed family's rule would outlive it.
    publishFontFaces([{ family: "A", weight: 400, base64: "AA==" }]);
    publishFontFaces([{ family: "B", weight: 400, base64: "AA==" }]);
    const css = document.getElementById("realm-installed-fonts")!.textContent!;
    expect(css).toContain('"B"');
    expect(css).not.toContain('"A"');
    expect(document.querySelectorAll("#realm-installed-fonts")).toHaveLength(1);
  });

  it("installing one publishes it without a reload", async () => {
    const { api, store } = await boot();
    await store.getState().installFont("Iosevka");
    expect(api.calls).toContain("installFont:Iosevka");
    expect(store.getState().installedFonts.map((f) => f.family)).toEqual(["Iosevka"]);
    expect(document.getElementById("realm-installed-fonts")!.textContent).toContain('"Iosevka"');
  });

  it("removing one moves any role that was wearing it back to the bundled face", async () => {
    /* THE MUTANT: delete the files and stop. The CSS stack would quietly land on the system face
       while the SETTING went on naming a family whose files are gone — the state that survives a
       restart and confuses everyone. */
    const { store } = await boot({ installedFonts: [FONT] });
    await store.getState().setFonts({ ui: "Iosevka", code: "Iosevka" });
    await store.getState().removeFont("Iosevka");
    expect(store.getState().fonts.ui).toBe("bundled");
    expect(store.getState().fonts.code).toBe("bundled");
    expect(store.getState().installedFonts).toEqual([]);
  });

  it("leaves a role alone when it was wearing something else", async () => {
    const { store } = await boot({ installedFonts: [FONT] });
    await store.getState().setFonts({ ui: "system", code: "Iosevka" });
    await store.getState().removeFont("Iosevka");
    expect(store.getState().fonts.ui).toBe("system");
    expect(store.getState().fonts.code).toBe("bundled");
  });

  it("fetches the catalogue once per launch, not once per picker", async () => {
    // Two thousand entries and a 2.7MB download, for a list most launches never look at.
    const { api, store } = await boot({ fontCatalog: [{ family: "Inter", category: "Sans Serif", mono: false }] });
    await store.getState().refreshFontCatalog();
    await store.getState().refreshFontCatalog();
    expect(api.calls.filter((c) => c === "fontCatalog")).toHaveLength(1);
    expect(store.getState().fontCatalog).toHaveLength(1);
  });
});
