import { describe, expect, it } from "vitest";
import { AppPicks, PICTURE_MARGIN, flattenBgra, groundOf, pictureRect, registerAppPick, toDips, type PickWindow, type Rect } from "./app-pick";

const WINDOW = { width: 1400, height: 900 };
/** A browser pane's native view: the right-hand pane, from under its bar to the window's foot. */
const VIEW: Rect = { x: 800, y: 80, width: 600, height: 820 };

describe("pictureRect", () => {
  it("takes the element with a margin of what is around it", () => {
    expect(pictureRect({ x: 100, y: 200, width: 32, height: 32 }, WINDOW, [])).toEqual({
      rect: { x: 100 - PICTURE_MARGIN, y: 200 - PICTURE_MARGIN, width: 32 + PICTURE_MARGIN * 2, height: 32 + PICTURE_MARGIN * 2 }, webView: false,
    });
  });

  it("stays inside the window, and rounds INWARD so a fraction never reaches past an edge", () => {
    expect(pictureRect({ x: 4, y: 870.5, width: 40.25, height: 20 }, WINDOW, [])).toEqual({ rect: { x: 0, y: 847, width: 68, height: 53 }, webView: false });
  });

  it("never reaches into a browser pane's view — the margin gives way on the side the view is", () => {
    // A button in the browser pane's own bar, right above its page: the bar comes, the page does not.
    // THE MUTANT: capture the margin as it is. The window's capture cannot see the page, so the
    // picture would carry the empty placeholder where the page is on screen.
    const { rect } = pictureRect({ x: 900, y: 46, width: 28, height: 28 }, WINDOW, [VIEW]);
    expect(rect).toEqual({ x: 876, y: 22, width: 76, height: 80 - 22 });
    expect(rect!.y + rect!.height).toBeLessThanOrEqual(VIEW.y);
  });

  it("cuts on whichever side keeps more of the picture when the view is off a corner", () => {
    // The view is down and to the right of the element: cutting below keeps the row, cutting right
    // keeps the column. The bigger of the two is the better picture.
    const { rect } = pictureRect({ x: 760, y: 60, width: 30, height: 10 }, WINDOW, [VIEW]);
    expect(rect).toEqual({ x: 736, y: 36, width: 800 - 736, height: 94 - 36 });
  });

  it("has no picture at all for an element under a view, and says that is why", () => {
    expect(pictureRect({ x: 780, y: 60, width: 400, height: 300 }, WINDOW, [VIEW])).toEqual({ rect: null, webView: true });
    // A hidden view (zero size: the pane is showing its own page) is no reason to refuse.
    expect(pictureRect({ x: 780, y: 60, width: 400, height: 300 }, WINDOW, [{ ...VIEW, width: 0 }]).webView).toBe(false);
  });

  it("has nothing to take for a box outside the window or with no size", () => {
    expect(pictureRect({ x: 2000, y: 10, width: 20, height: 20 }, WINDOW, [])).toEqual({ rect: null, webView: false });
    expect(pictureRect({ x: 10, y: 10, width: 0, height: 20 }, WINDOW, [])).toEqual({ rect: null, webView: false });
  });
});

describe("toDips", () => {
  it("scales the renderer's CSS px by the window's zoom", () => {
    expect(toDips({ x: 10, y: 20, w: 30, h: 40 }, 1.25)).toEqual({ x: 12.5, y: 25, width: 37.5, height: 50 });
    expect(toDips({ x: 10, y: 20, w: 30, h: 40 }, Number.NaN)).toEqual({ x: 10, y: 20, width: 30, height: 40 });
  });
});

describe("flattenBgra", () => {
  const GROUND = [23, 24, 26] as const;

  it("lays a clear pixel over the ground, and leaves an opaque one alone", () => {
    expect([...flattenBgra(new Uint8Array([0, 0, 0, 0, 10, 20, 30, 255]), GROUND)]).toEqual([26, 24, 23, 255, 10, 20, 30, 255]);
  });

  it("reads premultiplied pixels as premultiplied — white at half alpha over the ground is half and half", () => {
    // Premultiplied white at 50% is 128,128,128,128. Treated as straight it would come out far too dark.
    const [b, g, r, a] = flattenBgra(new Uint8Array([128, 128, 128, 128]), GROUND);
    expect([r, g, b, a]).toEqual([Math.round(128 + 23 * (127 / 255)), Math.round(128 + 24 * (127 / 255)), Math.round(128 + 26 * (127 / 255)), 255]);
  });

  it("reads straight alpha as straight, which a channel above its alpha gives away", () => {
    // 240 at alpha 128 cannot be premultiplied; flattening it as if it were overflows past white.
    const [, , r] = flattenBgra(new Uint8Array([240, 240, 240, 128]), GROUND);
    expect(r).toBe(Math.round(240 * (128 / 255) + 23 * (127 / 255)));
  });
});

describe("groundOf", () => {
  it("takes three bytes and nothing else", () => {
    expect(groundOf([23, 24, 26])).toEqual([23, 24, 26]);
    for (const bad of [[1, 2], [1, 2, 256], [1, 2, 3.5], "rgb(1,2,3)", null]) expect(groundOf(bad)).toBeNull();
  });
});

describe("registerAppPick", () => {
  function harness(over: Partial<PickWindow> = {}) {
    const on = new Map<string, (e: { sender: unknown }, ...a: unknown[]) => void>();
    const handle = new Map<string, (e: { sender: unknown }, ...a: unknown[]) => unknown>();
    const captured: Rect[] = [];
    const saved: string[] = [];
    const window: PickWindow = {
      size: () => WINDOW, views: () => [VIEW], zoom: () => 1,
      capture: async (rect) => { captured.push(rect); return { bgra: new Uint8Array(rect.width * rect.height * 4).fill(255), width: rect.width, height: rect.height }; },
      ...over,
    };
    const picks = registerAppPick({
      on: (c, fn) => on.set(c, fn), handle: (c, fn) => handle.set(c, fn),
      windowOf: (sender) => (sender === "realm" ? { key: 7, window } : null),
      save: async (_bitmap, name) => { saved.push(name); return { path: `/home/tmp/attachments/abc-${name}`, mime: "image/png", name, size: 10 }; },
    });
    const arm = (v: boolean, sender = "realm") => on.get("app-pick:arm")!({ sender }, v);
    const capture = (rect: unknown, sender = "realm") => handle.get("app-pick:capture")!({ sender }, rect, [23, 24, 26], "realm-send-button.png") as Promise<{ file: unknown; webView: boolean }>;
    return { picks, arm, capture, captured, saved };
  }
  const SEND = { x: 600, y: 840, w: 32, h: 32 };

  it("takes the picture while the person is picking, and keeps it where a pasted image goes", async () => {
    const h = harness();
    h.arm(true);
    expect(await h.capture(SEND)).toEqual({ file: { path: "/home/tmp/attachments/abc-realm-send-button.png", mime: "image/png", name: "realm-send-button.png", size: 10 }, webView: false });
    expect(h.captured).toEqual([{ x: 576, y: 816, width: 80, height: 80 }]);
  });

  it("refuses a capture asked for when nobody is picking — the picture is part of a pick, never a thing of its own", async () => {
    // THE MUTANT: drop the armed check. Any renderer code could then photograph the window at will.
    const h = harness();
    expect(await h.capture(SEND)).toEqual({ file: null, webView: false });
    h.arm(true); h.arm(false);
    expect(await h.capture(SEND)).toEqual({ file: null, webView: false });
    expect(h.captured).toEqual([]);
  });

  it("answers only Realm's own windows", async () => {
    const h = harness();
    h.arm(true, "a page");
    expect(h.picks.isPicking(7)).toBe(false);
    h.arm(true);
    expect(await h.capture(SEND, "a page")).toEqual({ file: null, webView: false });
  });

  it("never captures an element that lies under a browser view, and says so", async () => {
    const h = harness();
    h.arm(true);
    expect(await h.capture({ x: 900, y: 300, w: 100, h: 40 })).toEqual({ file: null, webView: true });
    expect(h.captured).toEqual([]);
  });

  it("measures the element in the window's zoom", async () => {
    const h = harness({ zoom: () => 2 });
    h.arm(true);
    await h.capture({ x: 100, y: 100, w: 10, h: 10 });
    expect(h.captured).toEqual([{ x: 176, y: 176, width: 68, height: 68 }]);
  });
});

describe("AppPicks", () => {
  it("knows whether any window is picking, for the app drive that stands down meanwhile", () => {
    const p = new AppPicks();
    expect(p.any()).toBe(false);
    p.set(1, true);
    expect(p.any()).toBe(true);
    p.set(1, false);
    expect(p.any()).toBe(false);
  });
});
