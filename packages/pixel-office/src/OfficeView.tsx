import { useEffect, useRef } from "react";
import { OfficeState } from "./vendor/office/engine/officeState.js";
import { renderFrame } from "./vendor/office/engine/renderer.js";
import { deserializeLayout } from "./vendor/office/layout/layoutSerializer.js";
import { CHARACTER_COUNT, installOfficeAssets } from "./assets.js";
import { reconcileOffice, type OfficeAgent, type OfficeCast } from "./bridge.js";
import { checkWorld, worldBounds } from "./world.js";
import { TILE_SIZE } from "./vendor/office/types.js";

export type { OfficeAgent } from "./bridge.js";

/**
 * The office, rendering Realm's live agents.
 *
 * Realm's canvas rather than upstream's `OfficeCanvas`, and the reason is the frame loop rather than
 * taste. Upstream's `startGameLoop` is an unconditional `requestAnimationFrame` — correct in a VS
 * Code webview, wrong here, because a rAF loop is outside both of the mechanisms Realm governs
 * motion with. Reduced motion is an app-wide `* { animation: none }`; the `data-quiet` pause the
 * power audit measured at half a core per pane is `animation-play-state`. Both are CSS. A canvas
 * answers to neither, so a ported loop would keep running under a preference that silenced
 * everything else and burn a core in a window nobody is looking at.
 *
 * So the loop is re-implemented here and both conditions are read in JS, and it is STOPPED rather
 * than throttled: a canvas holds its last frame for free, which is the same "freezes where it
 * stands, resumes where it was" the stylesheet gives everything else.
 *
 * The office is otherwise entirely upstream's — `OfficeState` owns the world, the seating and the
 * character FSM, and `renderFrame` draws it. What this adds is the loop, the viewport, and the
 * reconcile against Realm's sessions (`bridge.ts`).
 */
export function OfficeView({ agents, layout, visible, className, onPick }: {
  agents: readonly OfficeAgent[];
  /** The world. Taken as `unknown` on purpose: every world that is not the one Realm ships came out
   *  of a language model, so this prop IS the trust boundary and `checkWorld` is what guards it. A
   *  world that does not survive the check is not drawn — the office falls back to the default
   *  rather than rendering a room with holes in the floor. */
  layout: unknown;
  /** The pane is on screen. An office in a background tab animates nothing. */
  visible: boolean;
  className?: string;
  /** A click that landed on a character, by session id. */
  onPick?: (sessionId: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const office = useRef<OfficeState | null>(null);
  const cast = useRef<OfficeCast>(new Map());
  /* Read by the loop rather than closed over: `agents` changes on every status broadcast, and
     rebuilding the loop on each one would restart the world. */
  const live = useRef(agents);
  live.current = agents;
  const pick = useRef(onPick);
  pick.current = onPick;

  // The world. Rebuilt only when the layout itself changes, which is what keeps a theme change or a
  // new agent from resetting everyone's seat.
  useEffect(() => {
    installOfficeAssets();
    const raw = typeof layout === "string" ? deserializeLayout(layout) : layout;
    const checked = raw == null ? null : checkWorld(raw);
    const parsed = checked?.ok ? checked.layout : null;
    if (!office.current) office.current = new OfficeState(parsed ?? undefined);
    else if (parsed) office.current.rebuildFromLayout(parsed);
    cast.current = new Map();
  }, [layout]);

  useEffect(() => {
    const el = canvas.current;
    if (!el || !visible) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    installOfficeAssets();
    if (!office.current) office.current = new OfficeState();

    let raf = 0;
    let last = 0;
    const view = { panX: 0, panY: 0 };

    const size = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = el.clientWidth, h = el.clientHeight;
      if (w === 0 || h === 0) return false;
      // Assigning width/height clears the canvas, so it is only done when it actually changes —
      // otherwise a paused office would lose the frame it is holding on screen.
      if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
        el.width = Math.round(w * dpr);
        el.height = Math.round(h * dpr);
      }
      ctx.imageSmoothingEnabled = false; // a scaled-up pixel is a square, not a blur
      return true;
    };

    const draw = (dt: number) => {
      const state = office.current;
      if (!state || !size()) return;
      cast.current = reconcileOffice(state, cast.current, live.current, CHARACTER_COUNT);
      state.update(dt);
      /* Fit the ROOM to the pane, not the grid it was declared with. The two differ by a lot on a
         hand-authored layout — the one Realm ships declares 21×22 and fills eleven rows — and
         fitting the declared grid there halves the zoom and centres the empty half along with the
         room. `worldBounds` is what the eye would call the office.
         Snapped to whole numbers above 1× because a pixel scaled by 2.4 is three different widths
         across one sprite, and a room drawn that way reads as a bad photograph of pixel art. */
      const b = worldBounds(state.layout);
      const pad = TILE_SIZE; // a tile of air so the walls are not flush with the pane
      const fit = Math.min(el.width / (b.cols * TILE_SIZE + pad), el.height / (b.rows * TILE_SIZE + pad));
      const zoom = fit >= 1 ? Math.max(1, Math.floor(fit)) : Math.max(0.25, fit);
      /* `renderFrame` centres the DECLARED grid, so the pan is what moves the room's own centre onto
         the pane's. Without it the office sits wherever its padding happens to put it. */
      const panX = ((state.layout.cols - (b.minCol + b.maxCol + 1)) / 2) * TILE_SIZE * zoom;
      const panY = ((state.layout.rows - (b.minRow + b.maxRow + 1)) / 2) * TILE_SIZE * zoom;
      renderFrame(
        ctx, el.width, el.height, state.tileMap, state.furniture, state.getCharacters(),
        zoom, panX + view.panX, panY + view.panY,
        undefined, undefined, state.layout.tileColors, state.layout.cols, state.layout.rows,
        state.layout.carpetTiles,
      );
    };

    const quiet = () => document.documentElement.hasAttribute("data-quiet");
    const still = window.matchMedia("(prefers-reduced-motion: reduce)");

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.05, last === 0 ? 0 : (now - last) / 1000); // a backgrounded tab returns one huge delta
      last = now;
      draw(dt);
    };

    const stop = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; } };
    const start = () => { if (raf) return; last = 0; raf = requestAnimationFrame(tick); };
    /** One frame, standing still — what an office looks like when it is not allowed to move. */
    const settle = () => { if (still.matches || quiet()) { stop(); draw(0); } else start(); };

    settle();
    // `data-quiet` is set on <html> for two reasons — Low power, and the window losing focus — and
    // this treats them the same, exactly as the stylesheet does.
    const watchQuiet = new MutationObserver(settle);
    watchQuiet.observe(document.documentElement, { attributes: true, attributeFilter: ["data-quiet"] });
    still.addEventListener("change", settle);
    const watchSize = new ResizeObserver(() => { if (raf === 0) draw(0); });
    watchSize.observe(el);

    return () => {
      stop(); watchQuiet.disconnect(); watchSize.disconnect();
      still.removeEventListener("change", settle);
    };
  }, [visible]);

  return <canvas ref={canvas} className={className} aria-hidden="true" />;
}
