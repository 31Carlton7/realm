import { useLayoutEffect, type RefObject } from "react";

/**
 * The quick chat panel's frame on the page side: how tall its shapes are, where they are for the
 * material cut to them, and its way in and out. The window itself is main's
 * (main/quick-chat-panel.ts), which takes the height this measures and keeps the bottom edge where
 * it is, and so is the material (main/panel-material.ts).
 */

/** The gap between the panel's shapes, as in ChatGPT's companion. */
const PANEL_GAP = 8;
/** The most the shapes grow to (main's QUICK_CHAT_PANEL_MAX_HEIGHT). */
const PANEL_MAX_HEIGHT = 520;
/** What needs the whole height while it is open: a menu, the model list, a toast or a sheet opens
 *  above the bar and would be cut off by a window the bar's height. */
export const PANEL_ROOMY = ".menu, .model-picker, .mention-picker, .toast, .sheet-backdrop";

/** The shapes the material is cut to, top to bottom, and the outline of each: a capsule's ends are
 *  half circles, and the card wears the card rung on the painter's curve. */
const PANEL_SHAPES: readonly (readonly [selector: string, outline: "capsule" | "card"])[] = [
  [".quick-chat-card", "card"],
  [".quick-chat-answer", "capsule"],
  [".quick-chat-foot .composer", "capsule"],
  [".quick-chat-tools", "capsule"],
];
/** The card rung (`--r-squircle-card`). */
const CARD_RADIUS = 20;
/** How much of a shape's right end shows at the start of its way in, and at the end of its way out. */
const REVEAL_FROM = 120;

const TWEEN_MS = 200;

export function isPanel(): boolean {
  return document.documentElement.dataset.surface === "quick-chat" && !!window.realm?.quickChatPanel;
}

/** The height the panel's shapes want: the card or the answer above the foot, at their content's
 *  height, with the gap between each. */
function panelShapesHeight(root: HTMLElement): number {
  if (root.dataset.roomy !== undefined || document.querySelector(PANEL_ROOMY)) return PANEL_MAX_HEIGHT;
  const foot = root.querySelector<HTMLElement>(".quick-chat-foot");
  let height = foot?.offsetHeight ?? 0;
  const answer = root.querySelector<HTMLElement>(".quick-chat-answer");
  if (answer) height += PANEL_GAP + answer.offsetHeight;
  const card = root.querySelector<HTMLElement>(".quick-chat-card");
  if (root.dataset.expanded !== undefined && card) {
    // The card is squeezed while the window is still short, and only its scroller gives way.
    const scroller = card.querySelector<HTMLElement>(".transcript");
    const hidden = scroller ? scroller.scrollHeight - scroller.clientHeight : 0;
    height += PANEL_GAP + card.offsetHeight + hidden;
  }
  return Math.min(PANEL_MAX_HEIGHT, height);
}

type PanelShape = { x: number; y: number; width: number; height: number; radius: number; squircle?: boolean; alpha?: number };

/**
 * Where the panel's shapes are, as the material should be cut. `reveal` is the way in or out, 0 to 1:
 * each shape shows its right end, widening to its whole width, and fades in from 0.4, or out to
 * nothing (`leaving`), the same numbers the stylesheet clips and fades the page's shapes by. A shape
 * that is not laid out (hidden, or not there) has no rect and is left out.
 */
export function panelShapes(root: ParentNode, reveal = 1, leaving = false): PanelShape[] {
  const shapes: PanelShape[] = [];
  for (const [selector, outline] of PANEL_SHAPES) {
    const el = root.querySelector<HTMLElement>(selector);
    const rect = el?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) continue;
    const shown = Math.min(rect.width, REVEAL_FROM + reveal * Math.max(0, rect.width - REVEAL_FROM));
    shapes.push({
      x: rect.x + rect.width - shown, y: rect.y, width: shown, height: rect.height,
      radius: outline === "card" ? CARD_RADIUS : rect.height / 2, squircle: outline === "card",
      alpha: leaving ? reveal : 0.4 + 0.6 * reveal,
    });
  }
  return shapes;
}

/** Reduce Transparency takes the material away, and the shapes stand on the solid ground. */
function solid(): boolean {
  return window.matchMedia?.("(prefers-reduced-transparency: reduce)").matches ?? false;
}

let sendShapes: (() => void) | null = null;

/** Tells main the shapes' height, and where they are, whenever either changes, on the panel's page
 *  only. */
export function usePanelFit(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const root = ref.current;
    const panel = window.realm?.quickChatPanel;
    if (!root || !panel || !isPanel()) return;
    let last = -1;
    let lastShapes = "";
    /* The shapes stand on macOS's material where main can cut it to them, and on the page's own
       ground where it cannot, or under Reduce Transparency (the stylesheet's `data-panel-material`). */
    const html = document.documentElement;
    const material = () => {
      if (window.realm?.panelMaterial && !solid()) html.dataset.panelMaterial = "";
      else delete html.dataset.panelMaterial;
    };
    material();
    const transparency = window.matchMedia?.("(prefers-reduced-transparency: reduce)");
    const onTransparency = () => { material(); lastShapes = ""; send(); };
    transparency?.addEventListener?.("change", onTransparency);
    let frame = 0;
    const send = () => {
      const t = tween;
      const shapes = solid() ? [] : panelShapes(root, t?.reveal ?? 1, t?.leaving ?? false);
      const key = JSON.stringify(shapes);
      if (key === lastShapes) return;
      lastShapes = key;
      panel.shapes?.({ shapes, width: window.innerWidth, height: window.innerHeight });
    };
    const measure = () => {
      frame = 0;
      const height = panelShapesHeight(root);
      if (height !== last) { last = height; panel.fit(height); }
      send();
    };
    const later = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    sendShapes = send;
    const sizes = new ResizeObserver(later);
    sizes.observe(root);
    for (const [selector] of PANEL_SHAPES) for (const el of root.querySelectorAll(selector)) sizes.observe(el);
    const changes = new MutationObserver(() => {
      for (const [selector] of PANEL_SHAPES) for (const el of root.querySelectorAll(selector)) sizes.observe(el);
      later();
    });
    changes.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-grown", "data-expanded", "data-roomy"] });
    window.addEventListener("resize", later);
    return () => {
      sizes.disconnect();
      changes.disconnect();
      window.removeEventListener("resize", later);
      transparency?.removeEventListener?.("change", onTransparency);
      if (frame) cancelAnimationFrame(frame);
      if (sendShapes === send) sendShapes = null;
    };
  }, [ref]);
}

/** The way in or out in progress: the stylesheet reads `--panel-reveal` and `--panel-alpha` off the
 *  root, and the material is sent the same numbers each frame, so the two cannot drift apart. */
let tween: { reveal: number; leaving: boolean } | null = null;
let tweenFrame = 0;
let tweenGuard: ReturnType<typeof setTimeout> | null = null;

function runTween(out: boolean, done: () => void): void {
  const root = document.documentElement;
  if (tweenFrame) cancelAnimationFrame(tweenFrame);
  if (tweenGuard) clearTimeout(tweenGuard);
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  /* Gone, the shapes stay folded away until the next way in, so a window shown again does not draw
     them whole for a frame before they widen. */
  const finish = () => {
    if (tweenFrame) cancelAnimationFrame(tweenFrame);
    if (tweenGuard) clearTimeout(tweenGuard);
    tweenFrame = 0;
    tweenGuard = null;
    if (out) {
      tween = { reveal: 0, leaving: true };
      root.dataset.panelTween = "out";
      root.style.setProperty("--panel-reveal", "0");
      root.style.setProperty("--panel-alpha", "0");
    } else {
      tween = null;
      delete root.dataset.panelTween;
      root.style.removeProperty("--panel-reveal");
      root.style.removeProperty("--panel-alpha");
    }
    sendShapes?.();
    done();
  };
  if (reduced) { finish(); return; }
  const start = performance.now();
  root.dataset.panelTween = out ? "out" : "in";
  // A window Chromium thinks is hidden or covered gets no frames, and the panel must still go.
  tweenGuard = setTimeout(finish, TWEEN_MS + 100);
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / TWEEN_MS);
    // Out eases in, as an exit does; in settles, as the spring does.
    const reveal = out ? 1 - t * t : 1 - (1 - t) ** 3;
    tween = { reveal, leaving: out };
    root.style.setProperty("--panel-reveal", String(reveal));
    root.style.setProperty("--panel-alpha", String(out ? reveal : 0.4 + 0.6 * reveal));
    sendShapes?.();
    if (t < 1) tweenFrame = requestAnimationFrame(step);
    else finish();
  };
  step(start);
}

/** The bar's way in: it widens out of its right end, as ChatGPT's does on Option+Space. */
export function panelCameIn(): void {
  hiding = null;
  runTween(false, () => {});
}

let hiding: (() => void) | null = null;

/** Put the panel away the way ChatGPT's goes: the shapes narrow into their right end and fade, and
 *  then the window hides. */
export function putPanelAway(hide: () => void): void {
  if (hiding) return;
  hiding = hide;
  runTween(true, () => {
    const done = hiding;
    hiding = null;
    done?.();
  });
}
