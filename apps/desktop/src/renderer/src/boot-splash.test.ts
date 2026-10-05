import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dismissBootSplash, resetBootSplashForTests } from "./boot-splash";

const html = readFileSync(join(dirname(new URL(import.meta.url).pathname), "../index.html"), "utf8");

describe("the boot mark's markup", () => {
  /* It exists to cover the window between the frame appearing and Realm having anything in it. Every
     assertion here is about that one job: if the mark needed the bundle, the stylesheet, or a file
     from disk, it would arrive on the far side of the gap it is for and show nothing. */
  it("is in the document before #root, not rendered by React", () => {
    expect(html.indexOf('id="boot"')).toBeGreaterThan(-1);
    expect(html.indexOf('id="boot"')).toBeLessThan(html.indexOf('id="root"'));
  });

  it("fetches nothing — the geometry and the style are both inline", () => {
    const body = html.slice(html.indexOf("<body"));
    // No <img>, no external stylesheet, no url() pointing anywhere. An inline <svg> and an inline
    // <style> are the only two forms that are on screen in the first frame.
    expect(body).not.toMatch(/<img\b/);
    expect(body).toMatch(/<svg class="boot-mark"/);
    expect(html).not.toMatch(/<link[^>]+rel="stylesheet"/);
    expect(html.slice(html.indexOf("<style>"), html.indexOf("</style>"))).not.toMatch(/url\(/);
  });

  it("carries no inline script, because the CSP forbids one", () => {
    // `script-src 'self'` — an inline <script> here would be silently blocked, so the dismissal has
    // to come from the bundle (boot-splash.ts) and never from this file.
    expect(html).toMatch(/script-src 'self'/);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
  });

  it("drops the sweep under reduced motion but keeps the mark", () => {
    const rm = html.slice(html.indexOf("prefers-reduced-motion"));
    expect(rm).toMatch(/\.boot-shine\s*\{\s*display:\s*none/);
    // The mutant: hiding #boot entirely, which would answer the preference by deleting the content.
    expect(rm.slice(0, 240)).not.toMatch(/#boot\s*\{\s*display:\s*none/);
  });

  it("clips the sweep to the mark, so it is never a band crossing an empty window", () => {
    expect(html).toMatch(/<g clip-path="url\(#b-silhouette\)"><rect class="boot-shine"/);
    expect(html).toMatch(/<clipPath id="b-silhouette">/);
  });

  it("keeps every gradient the mark's faces reference", () => {
    // The bug this pins: a rename that drops the <linearGradient> definitions leaves six paths
    // filled with url(#…) pointing at nothing, which renders as an INVISIBLE logo — a blank window
    // that looks exactly like the bug the mark was added to fix.
    const declared = new Set([...html.matchAll(/<linearGradient id="([^"]+)"/g)].map((m) => m[1]!));
    const used = [...html.matchAll(/fill="url\(#([^)]+)\)"/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThanOrEqual(7); // three faces, the doorway's three parts, the sweep
    expect(used.filter((id) => !declared.has(id))).toEqual([]);
  });

  /* The boot mark is a copy — it may fetch nothing, so it cannot point at the file — and a copy that
     drifts from the mark is a second logo. render.mjs writes both from resources/icon-src/mark.mjs. */
  it("draws the same mark as resources/icon-src/mark.svg and the renderer's realm-mark.svg", () => {
    const shapes = (svg: string) => [...svg.matchAll(/<path (?:fill="[^"]*" )?d="([^"]+)"/g)].map((m) => m[1]!);
    const boot = html.slice(html.indexOf('<svg class="boot-mark"'), html.indexOf("</svg>", html.indexOf('<svg class="boot-mark"')));
    const mark = readFileSync(join(dirname(new URL(import.meta.url).pathname), "../../../../../resources/icon-src/mark.svg"), "utf8");
    const asset = readFileSync(join(dirname(new URL(import.meta.url).pathname), "assets/realm-mark.svg"), "utf8");
    expect(shapes(mark).length).toBeGreaterThanOrEqual(8); // the silhouette, the doorway's front, three faces, three parts
    expect(shapes(boot)).toEqual(shapes(mark));
    expect(shapes(asset)).toEqual(shapes(mark));
  });

  it("waits before appearing, so a warm launch shows nothing at all", () => {
    expect(html).toMatch(/animation: boot-in [\d.]+ms [^;]*\b\d+ms both/);
  });
});

describe("dismissing it", () => {
  beforeEach(() => { resetBootSplashForTests(); vi.useFakeTimers(); document.body.innerHTML = '<div id="boot"></div>'; });
  afterEach(() => vi.useRealTimers());

  it("fades, then REMOVES — a fixed full-window layer left behind is a permanent sheet", () => {
    dismissBootSplash();
    expect(document.getElementById("boot")?.hasAttribute("data-done")).toBe(true);
    expect(document.getElementById("boot")).not.toBe(null); // still there, fading
    vi.advanceTimersByTime(400);
    expect(document.getElementById("boot")).toBe(null);
  });

  it("removes on a timer, not on animationend", () => {
    // A window that never composites — occluded, or with the animation cut to 1ms by reduced motion
    // — may not fire `animationend` at all, and the node would stay forever.
    dismissBootSplash();
    document.getElementById("boot")?.dispatchEvent(new Event("animationend"));
    expect(document.getElementById("boot")).not.toBe(null);
    vi.advanceTimersByTime(400);
    expect(document.getElementById("boot")).toBe(null);
  });

  it("is idempotent, and survives a document that never had one", () => {
    document.body.innerHTML = "";
    expect(() => { dismissBootSplash(); dismissBootSplash(); }).not.toThrow();
  });
});
