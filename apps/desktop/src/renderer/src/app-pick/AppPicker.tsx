import { appElementName, type AppPickedElement, type PickedElement } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { StoreApi } from "zustand";
import { getBrowserBridges } from "../panes/browser/browser-client";
import { centerOverComplement } from "../state/no-overlay";
import { useApp, useAppStore, useBrowserRects, type AppState, type PickedAttachment } from "../state/store";
import { accessibleName, componentChain, describeAppElement, roleOf, selectorFor, type AppPickDescription } from "./describe";
import { armAppPicker, type AppPicker } from "./picker";

/**
 * Select in Realm: point at a part of the app and it goes into a prompter, the way the web picker
 * sends a part of a page. The + menu's row and ⌘⇧C start it (start.ts); this owns one pick's
 * whole life — the overlay (picker.ts), the picture main takes of what was picked (main/app-pick.ts),
 * and the chip and its picture landing in the session's draft.
 *
 * A browser pane's page is a native view the window's DOM cannot reach, so while a pick is up every
 * page on screen is armed with the web picker too: the pointer crosses from Realm's chrome into a page
 * and the outline follows it there, drawn by that page, and a click in it is a pick of the page's
 * element into the same prompter. Whichever answers first is the pick, and the rest are taken down.
 */

/** The hint's width, for standing it over the part of the window no browser view covers. */
const HINT_WIDTH = 300;

/** The label's words for an element: what its chip will be called, and the component that drew it. */
function labelFor(el: Element): { name: string; component: string | null } {
  const components = componentChain(el, 1);
  const name = appElementName({ role: roleOf(el), name: accessibleName(el), text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
    tag: el.localName, selector: selectorFor(el), app: { components } });
  return { name, component: components[0] && components[0] !== name ? components[0] : null };
}

/** The theme's page colour as bytes, for main to lay the capture's translucency over. A colour the
 *  stylesheet writes in OKLCH has no sRGB until something paints it, so a one-pixel canvas does.
 *  The simulator pane's picks are laid over it too. */
export function groundRgb(): [number, number, number] | null {
  const page = getComputedStyle(document.documentElement).getPropertyValue("--page").trim();
  const ctx = page ? document.createElement("canvas").getContext("2d", { willReadFrequently: true }) : null;
  if (!ctx) return null;
  ctx.fillStyle = page;
  ctx.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}

/** `realm-send-button.png`: what the attachment tile and the agent both read the picture as. */
const pictureName = (name: string): string =>
  `realm-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "element"}.png`;

/** Two frames: the picker's chrome has been taken off the screen by the time the window is captured. */
export const painted = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

const titleOf = (s: AppState, sessionId: string): string =>
  s.items.find((i) => i.kind === "session" && i.refId === sessionId)?.title ?? s.sessions[sessionId]?.title ?? "the prompter";

/** The chip, and the picture beside it, in the session's draft — and a word about where it went. One
 *  delivery for every picker, so a pick off a device lands the way a part of Realm does. */
export function deliver(store: StoreApi<AppState>, sessionId: string, element: PickedElement, file: PickedAttachment | null): void {
  const s = store.getState();
  const title = titleOf(s, sessionId);
  const label = s.addElementChip(sessionId, element);
  if (label === null) { s.toast({ tone: "warning", text: `${title} is already carrying as many picked elements as one message can.` }); return; }
  if (file) s.attachPicked(sessionId, [file]);
  s.toast({ text: `Added ${label} to ${title}.`, icon: "target" });
}

/**
 * One pick, from the overlay going up to the chip landing. Answers its teardown, which the bridge calls
 * when the pick is put away from outside — ⌘⇧C again, or the window going — and which leaves the store
 * alone, since whatever put it away has already said so there.
 */
function runAppPick(store: StoreApi<AppState>, sessionId: string): () => void {
  const bridge = window.realm?.appPick;
  let phase: "aiming" | "taking" | "done" = "aiming";
  const pages: string[] = [];
  /* Main hears the person is picking FIRST, so a capture is never asked of a window it thinks idle,
     and hears it is over LAST, after the capture — not before, or main would refuse the picture. */
  bridge?.arm(true);
  const stand = () => {
    if (phase === "done") return false;
    phase = "done";
    bridge?.arm(false);
    for (const id of pages) void getBrowserBridges().host.cancelPick(id).catch(() => {});
    return true;
  };
  const finish = () => { if (stand() && store.getState().appPick?.sessionId === sessionId) store.getState().setAppPick(null); };

  const take = async (el: Element, picker: AppPicker) => {
    if (phase !== "aiming") return;
    phase = "taking";
    const described: AppPickDescription = describeAppElement(el);
    picker.hide();
    let shot: { file: PickedAttachment | null; webView: boolean } | null = null;
    if (bridge) {
      await painted();
      const name = appElementName(described);
      shot = await bridge.capture(described.rect, groundRgb(), pictureName(name)).catch(() => null);
    }
    picker.leave(described.rect);
    finish();
    deliver(store, sessionId, { ...described, app: { ...described.app, shot: shot?.file?.path ?? null, webView: shot?.webView ?? false } }, shot?.file ?? null);
  };

  const picker = armAppPicker(document, {
    describe: labelFor,
    onPick: (el) => { void take(el, picker); },
    onCancel: () => { picker.leave(); finish(); },
  });

  // Every page on screen keeps the web picker. Escape in a page, or the page going away, ends the
  // whole pick, as Escape over Realm's own chrome does.
  const s = store.getState();
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--rl-accent").trim() || undefined;
  for (const rect of s.browserRects) {
    const item = s.items.find((i) => i.id === rect.itemId) ?? (s.peek?.item.id === rect.itemId ? s.peek.item : undefined);
    if (item?.kind !== "browser") continue;
    pages.push(item.refId);
    void getBrowserBridges().host.pickElement(item.refId, accent).then((picked) => {
      if (phase !== "aiming") return;
      phase = "taking";
      picker.leave();
      finish();
      if (picked) deliver(store, sessionId, picked, null);
    }, () => { /* a page DevTools holds simply does not take part */ });
  }

  return () => { if (phase === "aiming") { picker.leave(); stand(); } };
}

/**
 * The bridge: runs a pick while the store says one is up, and says how to get out of it. The hint is
 * the picker's own chrome — never a pick — and stands over the part of the window no browser view
 * covers, where it can be seen.
 */
export function AppPickerBridge() {
  const store = useAppStore();
  const pick = useApp((s) => s.appPick);
  const views = useBrowserRects();
  useEffect(() => (pick ? runAppPick(store, pick.sessionId) : undefined), [store, pick]);
  if (!pick) return null;
  const spot = centerOverComplement({ width: window.innerWidth, height: window.innerHeight }, views, HINT_WIDTH);
  return createPortal(
    <div className="app-picker-hint" data-app-picker="" role="status"
      style={spot ? { left: spot.left + spot.width / 2 } : undefined}>
      <Icon name="select" size={14} />
      <span>Click a part of Realm</span>
      <span className="app-picker-sep" aria-hidden="true">·</span>
      <span><kbd>Esc</kbd> to cancel</span>
    </div>,
    document.body,
  );
}
