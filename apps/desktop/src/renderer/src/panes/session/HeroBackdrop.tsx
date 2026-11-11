import { useEffect, useMemo, useRef } from "react";
import { useApp } from "../../state/store";
import { BackdropRenderer, LOOKS, readPalette, resolveColor, type Palette, type Rect } from "./hero-backdrop";
import { COLOR_LOOKS, paintColorBackdrop, type ColorRender, type Picture, type TextRun } from "./hero-backdrop-color";
import { loopMayRun, resolveBackdrop, type Backdrop } from "./backdrop-gallery";
import { useYourBackgrounds, yourBackgroundUrl } from "../../state/your-backgrounds";

/** The picture for a face, as a URL: a shipped look's own file, or a kept picture asked of main. */
async function pictureFor(b: Backdrop, dark: boolean): Promise<Picture | null> {
  if ("mine" in b.image) {
    const url = await yourBackgroundUrl(b.image.mine, "full");
    return url ? { key: `mine:${b.image.mine}`, url } : null;
  }
  const url = dark ? b.image.dark : b.image.light;
  return { key: url, url };
}

/** The box round the greeting and the prompter, in the pane's CSS px, with room to breathe. */
function calmRect(pane: Element, box: DOMRect): Rect | null {
  const parts = [pane.querySelector(".hero-greeting"), pane.querySelector(".composer-dock")]
    .filter((e): e is Element => !!e).map((e) => e.getBoundingClientRect());
  if (!parts.length) return null;
  const x0 = Math.min(...parts.map((p) => p.left)), y0 = Math.min(...parts.map((p) => p.top));
  const x1 = Math.max(...parts.map((p) => p.right)), y1 = Math.max(...parts.map((p) => p.bottom));
  return { x: x0 - box.left - 24, y: y0 - box.top - 16, w: x1 - x0 + 48, h: y1 - y0 + 32 };
}

/** A frame every other vsync is plenty for a drift this slow. */
const FRAME_MS = 1000 / 30;

/**
 * The backdrop behind an empty session's greeting and prompter. A canvas laid under the pane's
 * content; it reads the greeting's and the card's boxes so the picture clears round them.
 *
 * A look moves only when it can and Motion is on, and a frame loop is outside the CSS that governs
 * motion (design.md, Motion), so it re-reads each control itself and STOPS rather than throttling:
 * under Reduce motion, while the root is quiet (Low power, a window not in front, idle) and while
 * the document is hidden. The canvas keeps its last frame, so a stopped backdrop is a still one.
 */
/** The background an empty session shows, from Settings ▸ Appearance ▸ Background; nothing when
 *  it is Off. Shuffle's pick is the session's own, from its id. */
export function SessionBackdrop({ sessionId }: { sessionId: string }) {
  const pref = useApp((s) => s.background);
  const motion = useApp((s) => s.backgroundMotion);
  const mine = useYourBackgrounds();
  const backdrop = useMemo(() => resolveBackdrop(pref, sessionId, motion, mine), [pref, sessionId, motion, mine]);
  return backdrop ? <HeroBackdrop backdrop={backdrop} /> : null;
}

export function HeroBackdrop({ backdrop }: { backdrop: Backdrop }) {
  return backdrop.effect === "dither" || backdrop.effect === "halftone"
    ? <ShaderBackdrop backdrop={backdrop} look={backdrop.effect} />
    : <ColorBackdrop backdrop={backdrop} look={backdrop.effect} />;
}

function ShaderBackdrop({ backdrop, look: lookId }: { backdrop: Backdrop; look: keyof typeof LOOKS }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const pane = canvas?.parentElement;
    if (!canvas || !pane) return;
    const look = LOOKS[lookId];
    const root = document.documentElement;
    let r: BackdropRenderer;
    try { r = new BackdropRenderer(canvas); } catch { canvas.hidden = true; return; }
    let pal: Palette = readPalette(root);
    let calm: Rect = { x: 0, y: 0, w: 0, h: 0 };
    let dpr = 1;
    let raf = 0;
    let last = 0;
    let disposed = false;
    let loaded = "";
    const t0 = performance.now();
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
    const profile = window.localStorage?.getItem("realm.heroBackdropProfile") === "1";
    const stats = { frames: 0, drawMs: [] as number[] };
    const time = (now: number) => (backdrop.moves ? ((now - t0) / 1000) * look.speed : 0);
    if (profile) {
      // A frame's whole cost, CPU and GPU, read back n times in a row: an upper bound, since each
      // read waits out the GPU process's round trip as well as the draw.
      const bench = (n: number) => { const s = performance.now(); for (let i = 0; i < n; i++) { r.draw(look, pal, calm, dpr, (i / 30) * look.speed); r.sync(); } return (performance.now() - s) / n; };
      Object.assign(window, { __heroBackdrop: stats, __heroBackdropBench: bench });
    }

    const measure = () => {
      const box = pane.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.round(box.width * dpr), h = Math.round(box.height * dpr);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      calm = calmRect(pane, box) ?? calm;
    };
    const paint = (now: number) => {
      const s = profile ? performance.now() : 0;
      r.draw(look, pal, calm, dpr, time(now));
      if (profile) { stats.frames++; stats.drawMs.push(performance.now() - s); }
    };
    const moving = () => loopMayRun(backdrop.moves, root, reduce);
    const tick = (now: number) => {
      raf = 0;
      if (disposed || !moving()) return;
      if (now - last >= FRAME_MS - 1) { last = now; paint(now); }
      raf = requestAnimationFrame(tick);
    };
    const refresh = () => {
      if (disposed) return;
      measure();
      paint(performance.now());
      if (!raf && moving()) raf = requestAnimationFrame(tick);
    };
    // The face's picture, loaded again only when the face changes to one with another picture.
    const load = async () => {
      const pic = await pictureFor(backdrop, pal.dark);
      if (disposed || !pic || pic.key === loaded) return;
      loaded = pic.key;
      await r.load(pic.url);
      refresh();
    };

    const resize = new ResizeObserver(refresh);
    resize.observe(pane);
    const dock = pane.querySelector(".composer-dock");
    if (dock) resize.observe(dock);
    dock?.addEventListener("transitionend", refresh);
    const watch = new MutationObserver(() => { pal = readPalette(root); refresh(); void load(); });
    watch.observe(root, { attributes: true, attributeFilter: ["data-mode", "data-theme", "data-quiet", "style"] });
    reduce?.addEventListener?.("change", refresh);
    document.addEventListener("visibilitychange", refresh);
    void load();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      resize.disconnect();
      watch.disconnect();
      dock?.removeEventListener("transitionend", refresh);
      reduce?.removeEventListener?.("change", refresh);
      document.removeEventListener("visibilitychange", refresh);
      r.destroy();
    };
  // The key names the picture and its treatment; a new object for the same backdrop is not a new one.
  }, [backdrop.key, backdrop.moves, lookId]);
  return <canvas ref={ref} className="hero-backdrop" aria-hidden="true" data-look={backdrop.key} />;
}

/** The prompter, in the pane's CSS px: its card with the tabs above and the strip below, which
 *  stand on one surface. It is the one thing the picture clears round; the greeting, laid out of
 *  the dock's flow, is not in this box. */
function cardRect(pane: Element, box: DOMRect): Rect | null {
  const card = pane.querySelector(".composer-dock")?.getBoundingClientRect();
  return card ? { x: card.left - box.left, y: card.top - box.top, w: card.width, h: card.height } : null;
}

/** Every run of text the picture could sit behind, with the ratio it needs: 3 for large text, 4.5
 *  otherwise. The prompter's own text stands on its surface, so only the greeting's is in the dock;
 *  its words are one group. Rects are in the pane's CSS px. */
function textRuns(pane: Element): TextRun[] {
  const box = pane.getBoundingClientRect();
  const runs: TextRun[] = [];
  const walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!n.textContent?.trim() || !el || (el.closest(".composer-dock") && !el.closest(".hero-greeting"))) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    const size = parseFloat(cs.fontSize), weight = Number(cs.fontWeight) || 400;
    const need = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
    const range = document.createRange();
    range.selectNodeContents(n);
    const alpha = Number(/rgba?\([^)]*,\s*([\d.]+)\)/.exec(cs.color)?.[1] ?? 1) * Number(cs.opacity);
    const [r, g, b] = resolveColor(cs.color);
    const group = el.closest(".hero-greeting") ? "greeting" : String(runs.length);
    for (const rect of range.getClientRects()) {
      if (rect.width < 1 || rect.height < 1) continue;
      runs.push({ rect: { x: rect.left - box.left, y: rect.top - box.top, w: rect.width, h: rect.height }, color: [r, g, b, alpha], need, group });
    }
  }
  return runs;
}

/**
 * A colour-kept look (hero-backdrop-color.ts), or a picture shown as it is: drawn once into a 2D
 * canvas, with no frame loop, so there is nothing to stop under Reduce motion or Low power. It is
 * drawn again only when the pane changes size, the face or theme changes, or the prompter moves,
 * and a move re-lays the mask over the screened picture rather than screening it again.
 */
function ColorBackdrop({ backdrop, look: lookId }: { backdrop: Backdrop; look: keyof typeof COLOR_LOOKS }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const pane = canvas?.parentElement;
    if (!canvas || !pane) return;
    const look = COLOR_LOOKS[lookId];
    const root = document.documentElement;
    const profile = window.localStorage?.getItem("realm.heroBackdropProfile") === "1";
    const renders: ColorRender[] = [];
    if (profile) Object.assign(window, { __heroBackdrop: { renders, runs: () => textRuns(pane) } });
    let disposed = false;
    let pending = false;
    let drawn = "";
    const draw = async () => {
      if (pending) return;
      pending = true;
      await new Promise(requestAnimationFrame);
      pending = false;
      if (disposed) return;
      const box = pane.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.round(box.width * dpr), h = Math.round(box.height * dpr);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      const pal: Palette = readPalette(root);
      const card = cardRect(pane, box) ?? { x: 0, y: 0, w: 0, h: 0 };
      // The dock's box changes as its tabs' text does; only a real move of the card or the greeting
      // (which reflows on its own as its words change or wrap), a new size or a new face draws again.
      const words = pane.querySelector(".hero-greeting")?.getBoundingClientRect();
      const key = JSON.stringify([w, h, pal, [card.x, card.y, card.w, card.h, words?.left, words?.top, words?.width, words?.height].map((v) => Math.round(v ?? 0))]);
      if (key === drawn) return;
      drawn = key;
      const pic = await pictureFor(backdrop, pal.dark);
      if (!pic || disposed) return;
      const done = await paintColorBackdrop(canvas, look, pic, card, dpr, pal.ground, () => textRuns(pane));
      if (done && profile) renders.push(done);
    };
    const refresh = () => void draw();
    const resize = new ResizeObserver(refresh);
    resize.observe(pane);
    const dock = pane.querySelector(".composer-dock");
    if (dock) resize.observe(dock);
    const greeting = pane.querySelector(".hero-greeting");
    if (greeting) resize.observe(greeting);
    dock?.addEventListener("transitionend", refresh);
    const watch = new MutationObserver(refresh);
    watch.observe(root, { attributes: true, attributeFilter: ["data-mode", "data-theme", "style"] });
    refresh();
    return () => {
      disposed = true;
      resize.disconnect();
      watch.disconnect();
      dock?.removeEventListener("transitionend", refresh);
    };
  // The key names the picture and its treatment; a new object for the same backdrop is not a new one.
  }, [backdrop.key, backdrop.moves, lookId]);
  return <canvas ref={ref} className="hero-backdrop" aria-hidden="true" data-look={backdrop.key} />;
}
