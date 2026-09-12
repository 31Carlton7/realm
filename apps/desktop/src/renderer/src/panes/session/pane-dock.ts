import { useEffect, useLayoutEffect, useState } from "react";

/**
 * The strip down the right of a session pane that a panel can dock to, and the two rules every
 * panel that docks there follows.
 *
 * There is ONE such strip per pane, and that is the whole reason this is shared rather than copied:
 * the summary and the sub-agent view are two contents for one place, and two components measuring
 * and claiming it separately would draw one over the other the moment both were open.
 */

/** The transcript column a pinned dock has to leave behind to still be worth reading. */
const DOCK_MIN_COLUMN = 420;
const DOCK_GUTTER = 16;

/** The docked panels' widths, in px, matching the `--summary-w` / `--terminal-dock-w` tokens.
 *  Duplicated here because the pin decision is arithmetic and CSS cannot answer it. */
export const DOCK_W_SUMMARY = 320;
/** The terminal's is far wider on purpose: 320px is about forty columns, which is a shell you cannot
 *  read a stack trace or a `git log` in. */
export const DOCK_W_TERMINAL = 560;

/**
 * Below this pane width the dock FLOATS over the transcript instead of the transcript making room.
 *
 * A pane wide enough to give the panel up and still leave a readable column keeps it pinned beside
 * the transcript, which is what makes it usable while you scroll. Narrower, pinning would squeeze
 * the transcript into a gutter.
 *
 * Per-panel rather than one constant, because the panels are no longer one size: the same pane that
 * can comfortably pin a 320px summary would be left with a 200px transcript by a 560px terminal.
 */
export const dockPinMinPane = (dockWidth: number): number => dockWidth + DOCK_MIN_COLUMN + DOCK_GUTTER;
export const DOCK_PIN_MIN_PANE = dockPinMinPane(DOCK_W_SUMMARY);

export type PaneRect = { right: number; top: number; height: number; width: number; pane: HTMLElement | null };

/**
 * The session PANE's rectangle, in viewport coordinates, as `right`/`top`/`height` insets.
 *
 * A panel docks to the pane rather than to whatever opened it, because a session pane is one column
 * of a split and a panel measured from a button would hang over whatever is beside it. Re-measured
 * on resize for the same reason: dragging a splitter must move the panel with the pane it belongs to.
 */
export function usePaneRect(anchorRef: React.RefObject<HTMLElement | null>): PaneRect | null {
  const [rect, setRect] = useState<PaneRect | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      /* Up to the leaf, then back DOWN to the session body.
         An opener in the PanelBar is in the leaf's CHROME — so `.session-pane` never matched from
         there and the panel fell back to the whole window. Docking to the leaf instead is not right
         either: the leaf includes the bar, so the panel would cover its own toggle. The body is the
         box it should sit beside. Only a real window shows either mistake; in jsdom every rect is
         zero and all three answers look identical. */
      /* An anchor INSIDE the session body is already standing in the box we want, so it answers
         first. Only an anchor in the leaf's chrome — the PanelBar's summary button — has to go up to
         the leaf and back down, and that round trip must not be the general case: it needs a
         `.panel` ancestor to exist, and a session pane rendered without one then measured the whole
         window and pinned itself over the transcript it was meant to sit beside. */
      const leaf = anchorRef.current?.closest(".panel");
      const pane = (anchorRef.current?.closest(".session-pane")
        ?? leaf?.querySelector(".session-pane") ?? leaf) as HTMLElement | null;
      // No pane to dock to (the opener rendered on its own) falls back to the viewport's right edge
      // rather than to nothing. A panel that hides itself when it cannot find its anchor is a panel
      // that vanishes for a reason the user cannot see.
      const b = pane?.getBoundingClientRect();
      setRect(b
        ? { right: Math.max(0, window.innerWidth - b.right), top: b.top, height: b.height, width: b.width, pane }
        : { right: 0, top: 0, height: window.innerHeight, width: window.innerWidth, pane: null });
    };
    measure();
    window.addEventListener("resize", measure);
    // The splitter moves the pane without a window resize, so the pane itself is observed too.
    const observed = anchorRef.current?.closest(".panel");
    const ro = typeof ResizeObserver === "undefined" || !observed ? null : new ResizeObserver(measure);
    ro?.observe(observed!);
    return () => { window.removeEventListener("resize", measure); ro?.disconnect(); };
  }, [anchorRef]);
  return rect;
}

/**
 * Pinning means the TRANSCRIPT gets out of the way, and the transcript is not a panel's to render.
 *
 * The attribute goes on the pane node the measurement already found, and comes off on unmount — a
 * small, reversible write to a node React owns the children of but not the state of, which is
 * cheaper than threading an open flag up through SessionPane and back down.
 */
export function useDockPinned(rect: PaneRect | null, pinned: boolean, widthToken = "--summary-w"): void {
  useEffect(() => {
    const pane = rect?.pane;
    if (!pane || !pinned) return;
    pane.dataset.dockPinned = "";
    /* The width travels with the attribute because the padding has to match whichever panel is
       using the strip, and the pane is the panel's SIBLING — a custom property set on the panel
       would never reach it. Written as a `var()` reference rather than a pixel count so the token's
       own `min(…, vw)` clamp still applies on a narrow window; `--dock-w` has a declared default in
       styles.css, so this narrows an existing property rather than inventing one. */
    pane.style.setProperty("--dock-w", `var(${widthToken})`);
    return () => { delete pane.dataset.dockPinned; pane.style.removeProperty("--dock-w"); };
  }, [rect?.pane, pinned, widthToken]);
}

/**
 * Escape always closes; a click outside closes only while FLOATING.
 *
 * Pinned, a docked panel's whole job is to stay readable while you work in the transcript beside it,
 * and a dismiss-on-any-click panel cannot do that — which is why this was Escape-only before there
 * was a pinned mode to tell it apart from.
 */
export function useDockDismiss(opts: {
  pinned: boolean;
  onClose: () => void;
  /** Nodes a mousedown inside must NOT dismiss: the panel, and whatever opened it. */
  keepOpenIn: readonly React.RefObject<HTMLElement | null>[];
}): void {
  const { pinned, onClose } = opts;
  // Read through a ref-array that is rebuilt each render; depending on the array itself would
  // re-subscribe every render and re-subscribing a mousedown listener mid-click loses the click.
  const inside = opts.keepOpenIn;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => {
    if (pinned) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (inside.some((r) => r.current?.contains(t))) return;
      onClose();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `inside` is a fresh array each render
  }, [pinned, onClose]);
}
