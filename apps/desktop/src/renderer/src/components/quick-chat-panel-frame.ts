import { useLayoutEffect, type RefObject } from "react";

/**
 * The quick chat panel's frame on the page side: how tall its shapes are, and its way in and out.
 * The window itself is main's (main/quick-chat-panel.ts), which takes the height this measures and
 * keeps the bar's bottom edge where it is.
 */

/** The gap between the conversation card and the bar, as in ChatGPT's companion. */
export const PANEL_GAP = 8;
/** The most the shapes grow to (main's QUICK_CHAT_PANEL_MAX_HEIGHT). */
export const PANEL_MAX_HEIGHT = 520;
/** What needs the whole height while it is open: a menu, the model list, a toast or a sheet opens
 *  above the bar and would be cut off by a window the bar's height. */
export const PANEL_ROOMY = ".menu, .model-picker, .mention-picker, .toast, .sheet-backdrop";

const OUT_MS = 200;

function isPanel(): boolean {
  return document.documentElement.dataset.surface === "quick-chat" && !!window.realm?.quickChatPanel;
}

/** The height the panel's shapes want: the bar, and the card above it at its content's height. */
export function panelShapesHeight(root: HTMLElement): number {
  if (root.dataset.roomy !== undefined || document.querySelector(PANEL_ROOMY)) return PANEL_MAX_HEIGHT;
  const foot = root.querySelector<HTMLElement>(".quick-chat-foot");
  let height = foot?.offsetHeight ?? 0;
  const card = root.querySelector<HTMLElement>(".quick-chat-card");
  if (root.dataset.grown !== undefined && card) {
    // The card is squeezed while the window is still short, and only its scroller gives way.
    const scroller = card.querySelector<HTMLElement>(".transcript");
    const hidden = scroller ? scroller.scrollHeight - scroller.clientHeight : 0;
    height += PANEL_GAP + card.offsetHeight + hidden;
  }
  return Math.min(PANEL_MAX_HEIGHT, height);
}

/** Tells main the shapes' height whenever it changes, on the panel's page only. */
export function usePanelFit(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const root = ref.current;
    const panel = window.realm?.quickChatPanel;
    if (!root || !panel || !isPanel()) return;
    let last = -1;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const height = panelShapesHeight(root);
      if (height !== last) { last = height; panel.fit(height); }
    };
    const later = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    const sizes = new ResizeObserver(later);
    sizes.observe(root);
    const changes = new MutationObserver(later);
    changes.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-grown", "data-roomy"] });
    return () => {
      sizes.disconnect();
      changes.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [ref]);
}

/** The bar's way in: it widens out of its right end, as ChatGPT's does on Option+Space. */
export function panelCameIn(): void {
  const root = document.documentElement;
  delete root.dataset.panelOut;
  delete root.dataset.panelIn;
  void root.offsetWidth;
  root.dataset.panelIn = "";
}

let leaving: ReturnType<typeof setTimeout> | null = null;

/** Put the panel away the way ChatGPT's goes: the shapes narrow into their right end and fade, and
 *  then the window hides. */
export function putPanelAway(hide: () => void): void {
  if (leaving) return;
  document.documentElement.dataset.panelOut = "";
  leaving = setTimeout(() => {
    leaving = null;
    hide();
  }, window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : OUT_MS);
}
