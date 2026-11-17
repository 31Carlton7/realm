import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { BACKGROUND_MOTION_SETTING, BACKGROUND_SETTING, DEFAULT_BACKGROUND, type BackgroundImage } from "@realm/contracts";
import { GALLERY, loopMayRun, parseGallery, prefCanMove, resolveBackdrop } from "./backdrop-gallery";
import { SessionBackdrop } from "./HeroBackdrop";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi } from "../../state/store.test-fakes";
import { resetYourBackgrounds } from "../../state/your-backgrounds";

const urls = { "a.jpg": "/a.jpg", "b.jpg": "/b.jpg" };
const entry = { id: "a", name: "A", mood: "m", light: "a.jpg", dark: "b.jpg", effect: "dither", motion: true };
const mine = (id: string, over: Partial<BackgroundImage> = {}): BackgroundImage =>
  ({ id, name: id, added: 1, effect: "dither-color", asIs: false, width: 10, height: 10, loop: null, ...over });

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
      { id: "a", name: "A", mood: "m", light: "/a.jpg", dark: "/b.jpg", effect: "dither", motion: true, loop: null, credit: "" },
      { id: "still", name: "A", mood: "", light: "/a.jpg", dark: "/b.jpg", effect: "halftone", motion: false, loop: null, credit: "" },
    ]);
    expect(parseGallery({ looks: [entry] }, urls)).toEqual([]);
  });

  it("keeps a loop for each face whose video was shipped with its poster, on a moving colour-kept look", () => {
    const files = { ...urls, "a.mp4": "/a.mp4", "a.jpg": "/a.jpg", "b.mp4": "/b.mp4", "nopost.mp4": "/n.mp4" };
    const colour = { ...entry, effect: "dither-color", loop: { light: "a.mp4", dark: "b.mp4" } };
    const [both, oneFace, unposted, still, drifting] = parseGallery([
      colour,
      { ...colour, id: "one", loop: { light: "a.mp4", dark: "gone.mp4" } },
      { ...colour, id: "unposted", loop: { light: "nopost.mp4", dark: 7 } },
      { ...colour, id: "still", motion: false },
      { ...colour, id: "drifting", effect: "dither" },
    ], files);
    expect(both!.loop).toEqual({ light: { video: "/a.mp4", poster: "/a.jpg" }, dark: { video: "/b.mp4", poster: "/b.jpg" } });
    expect(oneFace!.loop).toEqual({ light: { video: "/a.mp4", poster: "/a.jpg" }, dark: null });
    expect([unposted, still, drifting].map((g) => g!.loop)).toEqual([null, null, null]);
    // The face with a loop is drawn still from its poster; the other keeps its picture.
    const b = resolveBackdrop("one", "s", true, [], [oneFace!])!;
    expect(b).toMatchObject({ moves: false, image: { light: "/a.jpg", dark: "/b.jpg" }, loop: { light: { kind: "video", url: "/a.mp4" }, dark: null } });
  });

  it("ships Haze, Silk, Sky and Dunes, every one drawable, and Sky's loop for both faces", () => {
    expect(GALLERY.map((g) => g.id)).toEqual(expect.arrayContaining(["haze", "silk", "sky", "dunes"]));
    for (const g of GALLERY) expect(g.light && g.dark).toBeTruthy();
    const sky = GALLERY.find((g) => g.id === "sky")!.loop!;
    expect([sky.light?.video, sky.dark?.video, sky.light?.poster, sky.dark?.poster].every(Boolean)).toBe(true);
  });
});

describe("which backdrop a session shows", () => {
  it("is Haze, held still, when nobody has chosen", () => {
    expect(resolveBackdrop("haze", "s1", false, [])).toMatchObject({ key: "haze", effect: "dither", moves: false });
    // Motion only moves a look that can.
    expect(resolveBackdrop("haze", "s1", true, [])?.moves).toBe(true);
    expect(resolveBackdrop("dunes", "s1", true, [])?.moves).toBe(false);
    // A choice naming nothing that exists falls back to the default.
    expect(resolveBackdrop("from-a-newer-build", "s1", false, [])?.key).toBe("sky-and-cliffs");
    expect(resolveBackdrop("mine:gone", "s1", false, [])?.key).toBe("sky-and-cliffs");
  });

  it("is Sky in light and Webb's Cosmic Cliffs in dark by default", () => {
    const pair = GALLERY.find((g) => g.id === DEFAULT_BACKGROUND)!;
    expect(pair.light).toBe(GALLERY.find((g) => g.id === "sky")!.light);
    expect(pair.dark).toBe(GALLERY.find((g) => g.id === "webb")!.dark);
    expect(pair.credit).toMatch(/NASA, ESA, CSA, STScI/);
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
    expect(resolveBackdrop("mine:1", "s1", true, [mine("1")])).toMatchObject({ effect: "dither-color", moves: false, image: { mine: "1" }, loop: null });
    expect(resolveBackdrop("mine:1", "s1", false, [mine("1", { asIs: true, effect: "halftone" })])?.effect).toBe("as-is");
    expect(resolveBackdrop("mine:1", "s1", false, undefined)).toBeNull();
  });

  it("plays your video or GIF over its first frame, printed in colour or as it is", () => {
    const video = { kind: "video", url: "realm-background://loop/1" };
    expect(resolveBackdrop("mine:1", "s1", true, [mine("1", { loop: "mp4" })])?.loop).toEqual({ light: video, dark: video });
    expect(resolveBackdrop("mine:1", "s1", true, [mine("1", { loop: "webm", asIs: true })])?.loop?.dark).toEqual(video);
    expect(resolveBackdrop("mine:1", "s1", true, [mine("1", { loop: "gif" })])?.loop?.light).toEqual({ kind: "gif", id: "1" });
    // Two-tone and halftone are printed from the still alone.
    expect(resolveBackdrop("mine:1", "s1", true, [mine("1", { loop: "mp4", effect: "halftone" })])?.loop).toBeNull();
  });

  it("offers Motion only where something can move", () => {
    expect(prefCanMove("haze")).toBe(true);
    expect(prefCanMove("sky")).toBe(true);
    expect(prefCanMove("dunes")).toBe(false);
    expect(prefCanMove("off")).toBe(false);
    expect(prefCanMove("mine:1")).toBe(false);
    expect(prefCanMove("mine:1", GALLERY, [mine("1", { loop: "mov" })])).toBe(true);
    expect(prefCanMove("mine:2", GALLERY, [mine("1", { loop: "mov" })])).toBe(false);
    expect(prefCanMove("shuffle")).toBe(true);
    expect(prefCanMove("shuffle", [], [mine("1", { loop: "gif" })])).toBe(true);
    expect(prefCanMove("shuffle", [], [mine("1")])).toBe(false);
  });
});

describe("the frame loop", () => {
  const root = () => document.documentElement;
  afterEach(() => {
    root().removeAttribute("data-quiet");
    root().removeAttribute("data-low-power-mode");
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
  });

  it("runs only for a moving look, and stops under Reduce motion, Low power, an idle or unfocused window, and a hidden one", () => {
    expect(loopMayRun(true, root(), { matches: false })).toBe(true);
    expect(loopMayRun(false, root(), { matches: false })).toBe(false);
    expect(loopMayRun(true, root(), { matches: true })).toBe(false);
    for (const quiet of ["always", "idle", "unfocused"]) {
      root().setAttribute("data-quiet", quiet);
      expect(loopMayRun(true, root(), null)).toBe(false);
    }
    root().removeAttribute("data-quiet");
    root().setAttribute("data-low-power-mode", "");
    expect(loopMayRun(true, root(), null)).toBe(false);
    root().removeAttribute("data-low-power-mode");
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    expect(loopMayRun(true, root(), null)).toBe(false);
  });
});

describe("SessionBackdrop", () => {
  // jsdom draws nothing; the canvas is what is under test, and the renderer stands down without WebGL.
  beforeEach(() => { vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null); });
  afterEach(() => { cleanup(); resetYourBackgrounds(); vi.restoreAllMocks(); });
  const mount = async (settings: Record<string, unknown>, hero = true) => {
    const store = createAppStore(fakeApi({ settings }));
    await store.getState().boot();
    return render(<StoreContext.Provider value={store}><SessionBackdrop sessionId="s1" hero={hero} /></StoreContext.Provider>);
  };

  it("draws the default painting for a home that never chose, empty or mid-chat", async () => {
    const { container } = await mount({});
    expect(container.querySelector("canvas.hero-backdrop")?.getAttribute("data-look")).toBe("sky-and-cliffs");
    cleanup();
    const chat = await mount({}, false);
    expect(chat.container.querySelector("canvas.hero-backdrop[data-phase=chat]")?.getAttribute("data-look")).toBe("sky-and-cliffs");
  });

  it("draws nothing at all when Off, empty or mid-chat", async () => {
    const { container } = await mount({ [BACKGROUND_SETTING]: "off", [BACKGROUND_MOTION_SETTING]: true });
    expect(container.innerHTML).toBe("");
    cleanup();
    const chat = await mount({ [BACKGROUND_SETTING]: "off" }, false);
    expect(chat.container.innerHTML).toBe("");
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
