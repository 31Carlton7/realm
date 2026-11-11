import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { BACKGROUND_MOTION_SETTING, BACKGROUND_SETTING, type BackgroundImage } from "@realm/contracts";
import { GALLERY, loopMayRun, parseGallery, prefCanMove, resolveBackdrop } from "./backdrop-gallery";
import { SessionBackdrop } from "./HeroBackdrop";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi } from "../../state/store.test-fakes";
import { resetYourBackgrounds } from "../../state/your-backgrounds";

const urls = { "a.jpg": "/a.jpg", "b.jpg": "/b.jpg" };
const entry = { id: "a", name: "A", mood: "m", light: "a.jpg", dark: "b.jpg", effect: "dither", motion: true };
const mine = (id: string, over: Partial<BackgroundImage> = {}): BackgroundImage =>
  ({ id, name: id, added: 1, effect: "dither-color", asIs: false, width: 10, height: 10, ...over });

describe("gallery.json", () => {
  it("keeps the entries it can draw and drops each bad one on its own", () => {
    const looks = parseGallery([
      entry,
      { ...entry }, // the same id again
      { ...entry, id: "Bad Id" },
      { ...entry, id: "no-name", name: " " },
      { ...entry, id: "sepia", effect: "sepia" },
      { ...entry, id: "missing", light: "nope.jpg" },
      { ...entry, id: "still", effect: "halftone", motion: "yes", mood: 3 },
      null, "x", 7,
    ], urls);
    expect(looks).toEqual([
      { id: "a", name: "A", mood: "m", light: "/a.jpg", dark: "/b.jpg", effect: "dither", motion: true, credit: "" },
      { id: "still", name: "A", mood: "", light: "/a.jpg", dark: "/b.jpg", effect: "halftone", motion: false, credit: "" },
    ]);
    expect(parseGallery({ looks: [entry] }, urls)).toEqual([]);
  });

  it("ships Haze, Silk, Sky and Dunes, every one drawable", () => {
    expect(GALLERY.map((g) => g.id)).toEqual(expect.arrayContaining(["haze", "silk", "sky", "dunes"]));
    for (const g of GALLERY) expect(g.light && g.dark).toBeTruthy();
  });
});

describe("which backdrop a session shows", () => {
  it("is Haze, held still, when nobody has chosen", () => {
    expect(resolveBackdrop("haze", "s1", false, [])).toMatchObject({ key: "haze", effect: "dither", moves: false });
    // Motion only moves a look that can.
    expect(resolveBackdrop("haze", "s1", true, [])?.moves).toBe(true);
    expect(resolveBackdrop("dunes", "s1", true, [])?.moves).toBe(false);
    // A choice naming nothing that exists falls back to the default.
    expect(resolveBackdrop("from-a-newer-build", "s1", false, [])?.key).toBe("brownell");
    expect(resolveBackdrop("mine:gone", "s1", false, [])?.key).toBe("brownell");
  });

  it("is nothing when Off", () => {
    expect(resolveBackdrop("off", "s1", true, [mine("1")])).toBeNull();
  });

  it("is one of the gallery or your images under Shuffle, the same one for a session every time", () => {
    const pool = [mine("0123456789abcdef")];
    const picks = new Map<string, string>();
    for (let i = 0; i < 600; i++) {
      const id = `session-${i}`;
      const a = resolveBackdrop("shuffle", id, false, pool)!;
      expect(resolveBackdrop("shuffle", id, false, pool)!.key).toBe(a.key);
      picks.set(id, a.key);
    }
    const seen = new Set(picks.values());
    // Every look in the pool turns up across six hundred sessions — a shuffle that always lands on one is no shuffle.
    expect(seen).toEqual(new Set([...GALLERY.map((g) => g.id), "mine:0123456789abcdef:dither-color"]));
    // Waits for your images rather than picking without them.
    expect(resolveBackdrop("shuffle", "s1", false, undefined)).toBeNull();
  });

  it("draws your image in the theme's colours by default, and as it is when asked", () => {
    expect(resolveBackdrop("mine:1", "s1", true, [mine("1")])).toMatchObject({ effect: "dither-color", moves: false, image: { mine: "1" } });
    expect(resolveBackdrop("mine:1", "s1", false, [mine("1", { asIs: true, effect: "halftone" })])?.effect).toBe("as-is");
    expect(resolveBackdrop("mine:1", "s1", false, undefined)).toBeNull();
  });

  it("offers Motion only where something can move", () => {
    expect(prefCanMove("haze")).toBe(true);
    expect(prefCanMove("sky")).toBe(false);
    expect(prefCanMove("off")).toBe(false);
    expect(prefCanMove("mine:1")).toBe(false);
    expect(prefCanMove("shuffle")).toBe(true);
  });
});

describe("the frame loop", () => {
  const root = () => document.documentElement;
  afterEach(() => { root().removeAttribute("data-quiet"); Object.defineProperty(document, "hidden", { value: false, configurable: true }); });

  it("runs only for a moving look, and stops under Reduce motion, Low power, an idle or unfocused window, and a hidden one", () => {
    expect(loopMayRun(true, root(), { matches: false })).toBe(true);
    expect(loopMayRun(false, root(), { matches: false })).toBe(false);
    expect(loopMayRun(true, root(), { matches: true })).toBe(false);
    for (const quiet of ["always", "idle", "unfocused"]) {
      root().setAttribute("data-quiet", quiet);
      expect(loopMayRun(true, root(), null)).toBe(false);
    }
    root().removeAttribute("data-quiet");
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    expect(loopMayRun(true, root(), null)).toBe(false);
  });
});

describe("SessionBackdrop", () => {
  // jsdom draws nothing; the canvas is what is under test, and the renderer stands down without WebGL.
  beforeEach(() => { vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null); });
  afterEach(() => { cleanup(); resetYourBackgrounds(); vi.restoreAllMocks(); });
  const mount = async (settings: Record<string, unknown>) => {
    const store = createAppStore(fakeApi({ settings }));
    await store.getState().boot();
    return render(<StoreContext.Provider value={store}><SessionBackdrop sessionId="s1" /></StoreContext.Provider>);
  };

  it("draws the default painting for a home that never chose", async () => {
    const { container } = await mount({});
    expect(container.querySelector("canvas.hero-backdrop")?.getAttribute("data-look")).toBe("brownell");
  });

  it("draws nothing at all when Off", async () => {
    const { container } = await mount({ [BACKGROUND_SETTING]: "off", [BACKGROUND_MOTION_SETTING]: true });
    expect(container.innerHTML).toBe("");
  });
});

describe("picture credits", () => {
  it("credits every shipped painting and photograph with its maker and source", () => {
    const pictures = GALLERY.filter((g) => !g.credit.startsWith("Made for Realm"));
    expect(pictures.map((g) => g.id)).toEqual(expect.arrayContaining(["brownell", "church", "webb", "cross", "van-gogh", "heade"]));
    for (const g of pictures) expect(g.credit).toMatch(/(CC0|NASA)/);
    // NASA's own credit lines, word for word, and nothing that reads as an endorsement.
    expect(GALLERY.find((g) => g.id === "webb")?.credit).toMatch(/Image: NASA, ESA, CSA, STScI$/);
    expect(GALLERY.find((g) => g.id === "hubble")?.credit).toMatch(/NASA\/ESA\/STScI$/);
    for (const g of GALLERY) expect(g.credit).not.toMatch(/endorse|partner|official|in collaboration with/i);
  });
  it("keeps a look without a credit", () => {
    expect(parseGallery([{ id: "a", name: "A", light: "x.jpg", dark: "x.jpg", effect: "dither" }], { "x.jpg": "u" })[0]?.credit).toBe("");
  });
});
