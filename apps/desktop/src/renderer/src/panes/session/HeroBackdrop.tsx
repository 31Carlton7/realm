import { useEffect, useRef } from "react";
import { BackdropRenderer, LOOKS, readPalette, type BackdropId, type Palette, type Rect } from "./hero-backdrop";

/** Phase 1 picks the look from localStorage; Settings ▸ App takes this over. Unset is off. */
export function chosenBackdrop(): BackdropId | null {
  const v = window.localStorage?.getItem("realm.heroBackdrop");
  return v && v in LOOKS ? (v as BackdropId) : null;
}

/** A frame every other vsync is plenty for a drift this slow. */
const FRAME_MS = 1000 / 30;

/**
 * The backdrop behind an empty session's greeting and prompter. A canvas laid under the pane's
 * content; it reads the greeting's and the card's boxes so the dither thins out behind them.
 *
 * A frame loop is outside the CSS that governs motion (design.md, Motion), so it re-reads each
 * control itself and STOPS rather than throttling: under Reduce motion, while the root is quiet
 * (Low power, a window not in front, idle) and while the document is hidden. The canvas keeps its
 * last frame, so a stopped backdrop is a still one.
 */
export function HeroBackdrop({ look: id }: { look: BackdropId }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const pane = canvas?.parentElement;
    if (!canvas || !pane) return;
    const look = LOOKS[id];
    const root = document.documentElement;
    let r: BackdropRenderer;
    try { r = new BackdropRenderer(canvas); } catch { canvas.hidden = true; return; }
    let pal: Palette = readPalette(root);
    let calm: Rect = { x: 0, y: 0, w: 0, h: 0 };
    let dpr = 1;
    let raf = 0;
    let last = 0;
    let disposed = false;
    const t0 = performance.now();
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
    const profile = window.localStorage?.getItem("realm.heroBackdropProfile") === "1";
    const stats = { frames: 0, drawMs: [] as number[] };
    if (profile) {
      // A frame's whole cost, CPU and GPU, read back n times in a row: an upper bound, since each
      // read waits out the GPU process's round trip as well as the draw.
      const bench = (n: number) => { const s = performance.now(); for (let i = 0; i < n; i++) { r.draw(look, pal, calm, dpr, i / 30); r.sync(); } return (performance.now() - s) / n; };
      Object.assign(window, { __heroBackdrop: stats, __heroBackdropBench: bench });
    }

    const measure = () => {
      const box = pane.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.round(box.width * dpr), h = Math.round(box.height * dpr);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      const parts = [pane.querySelector(".hero-greeting"), pane.querySelector(".composer-dock")]
        .filter((e): e is Element => !!e).map((e) => e.getBoundingClientRect());
      if (!parts.length) return;
      const x0 = Math.min(...parts.map((p) => p.left)), y0 = Math.min(...parts.map((p) => p.top));
      const x1 = Math.max(...parts.map((p) => p.right)), y1 = Math.max(...parts.map((p) => p.bottom));
      calm = { x: x0 - box.left - 24, y: y0 - box.top - 16, w: x1 - x0 + 48, h: y1 - y0 + 32 };
    };
    const paint = (now: number) => {
      const s = profile ? performance.now() : 0;
      r.draw(look, pal, calm, dpr, (now - t0) / 1000);
      if (profile) { stats.frames++; stats.drawMs.push(performance.now() - s); }
    };
    const moving = () => look.speed > 0 && !reduce?.matches && !root.hasAttribute("data-quiet") && !document.hidden;
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

    const resize = new ResizeObserver(refresh);
    resize.observe(pane);
    const dock = pane.querySelector(".composer-dock");
    if (dock) resize.observe(dock);
    dock?.addEventListener("transitionend", refresh);
    const watch = new MutationObserver(() => { pal = readPalette(root); refresh(); });
    watch.observe(root, { attributes: true, attributeFilter: ["data-mode", "data-theme", "data-quiet", "style"] });
    reduce?.addEventListener?.("change", refresh);
    document.addEventListener("visibilitychange", refresh);
    void r.load(look.image).then(refresh);

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
  }, [id]);
  return <canvas ref={ref} className="hero-backdrop" aria-hidden="true" data-look={id} />;
}
