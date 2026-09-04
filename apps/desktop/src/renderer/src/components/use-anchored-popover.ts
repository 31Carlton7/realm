import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { placeAnchored } from "../state/no-overlay";
import { useBrowserRects } from "../state/store";

export type PopoverPosition = { left: number; top: number; origin: string };
export type AnchoredPopover = {
  /** `null` until the surface has been measured. */
  pos: PopoverPosition | null;
  /** The exit is running: the surface is still in the DOM but is on its way out. */
  closing: boolean;
  /** Dismiss. Where the surface has an exit this holds it on screen for `EXIT_MS` first. */
  close: () => void;
};

const MARGIN = 6;
/** How long a closing surface stays in the DOM. This is the same fact as `rl-menu-out`'s duration —
 *  a timer shorter than the animation clips the exit, a longer one parks a finished surface on
 *  screen — so styles.test.ts pins the two together against the `--dur-press` rung. */
const EXIT_MS = 120;

const reducedMotion = (): boolean => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * Placement and dismissal for a portalled surface anchored to a control — everything `Menu` and the
 * prompter's `ModelPicker` share, minus the contents and minus each one's own focus model (a menu
 * roves across its items; the picker starts in its search field).
 *
 * `pos` is `null` until the surface has been measured; render at `-9999` and `visibility: hidden`
 * until then, so the flip decision is never visible as a jump.
 *
 * `exit` opts the surface into §6's popover exit. React unmounts a `{open && <Popover/>}` child the
 * instant its parent says so, which leaves no frame for an exit to run in, so the delay lives here:
 * `close()` marks the surface closing, hands focus back, and only then tells the parent. The caller
 * must render that state as inert and pointer-transparent — a surface that is visually gone but
 * still hit-testable is worse than no exit at all. Surfaces that enter instantly close instantly:
 * enter and exit are one decision per surface, not two.
 */
export function useAnchoredPopover({ ref, anchorRef, at, align = "left", placement = "down", onClose, returnFocusRef, exit = false }: {
  ref: RefObject<HTMLElement | null>;
  anchorRef?: RefObject<HTMLElement | null>;
  /** Place at a point instead of against an anchor (context menus). */
  at?: { x: number; y: number };
  align?: "left" | "right";
  placement?: "down" | "up";
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  exit?: boolean;
}): AnchoredPopover {
  const [pos, setPos] = useState<PopoverPosition | null>(null);
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  // W2's no-overlay invariant, enforced in the primitive: browser view rects are avoided by every
  // anchored surface (preferred side → flip → slide along the anchor edge → complement fallback).
  // [] outside the provider, which makes placeAnchored the pre-W2 placement exactly.
  const browserRects = useBrowserRects();

  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const place = () => {
      // A closing surface is frozen where it was dismissed. Its anchor may already have gone with
      // the action that dismissed it (a menu item that closes its own pane), and re-placing against
      // a missing anchor would fling the surface to the window corner mid-fade.
      if (closingRef.current) return;
      const { width, height } = el.getBoundingClientRect();
      const a = at ? { x: at.x, y: at.y, width: 0, height: 0 } : anchorRef?.current?.getBoundingClientRect();
      if (!a) { setPos({ left: MARGIN, top: MARGIN, origin: "top left" }); return; }
      const placed = placeAnchored({
        anchor: { x: a.x, y: a.y, width: a.width, height: a.height },
        size: { width, height },
        win: { width: window.innerWidth, height: window.innerHeight },
        align, placement: at ? "down" : placement, gap: at ? 0 : 4, margin: MARGIN,
        avoid: browserRects,
      });
      // §6: the 140ms scale-in is origin-aware — the surface grows out of the corner nearest its
      // trigger. The vertical half flips with the surface itself (one that flipped above its anchor
      // grows upward); the horizontal half follows `align`. A point-placed menu grows from its point.
      const origin = `${placed.above ? "bottom" : "top"} ${align === "right" ? "right" : "left"}`;
      // Same numbers → same object, so the ResizeObserver's synchronous first callback (and any
      // resize that does not actually move the surface) costs nothing and cannot cycle.
      setPos((prev) => prev && prev.left === placed.left && prev.top === placed.top && prev.origin === origin
        ? prev : { left: placed.left, top: placed.top, origin });
    };
    place();
    // A surface whose CONTENT changes height after mount was placed against the height it had at
    // mount, and the flip/clamp decision goes stale: the icon picker's tabs swing it between ~150px
    // (Generated) and ~470px (Emoji), which off a low anchor hangs it off the bottom of the window.
    // Re-place on its own resize — menus, whose contents never move, observe a size that never fires.
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, at, anchorRef, align, placement, browserRects]);

  // Focus restore. The target is captured once at mount, before any roving focus moves into the
  // surface, so it is the trigger unless the caller overrides it. It runs exactly once: an exiting
  // surface hands focus back when it is dismissed rather than when it finally unmounts, so the two
  // paths both come through here and the second one is a no-op.
  const restore = useRef<HTMLElement | null>(null);
  const restored = useRef(false);
  const restoreFocus = useCallback(() => {
    if (restored.current) return;
    restored.current = true;
    const target = returnFocusRef?.current ?? restore.current;
    // The trigger may have unmounted with the surface (e.g. a menu's own Close removed the pane):
    // fall back to the focused panel — a deliberate body-safe no-op when it isn't focusable.
    if (target?.isConnected) target.focus?.();
    else document.querySelector<HTMLElement>(".panel[data-focused]")?.focus?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- returnFocusRef is a ref, read at call time
  }, []);

  // `onClose` is read through a ref so the exit timer, armed once, cannot fire a stale one.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Commit a running exit now. An exit is a courtesy and it stops being one the moment the user
   *  does something else, so the next press ends it rather than waiting it out.
   *
   *  Called from pointerdown and keydown, and deliberately NOT from the click that follows a
   *  pointerdown: the parent has to be told BETWEEN the two events. React then unmounts the surface
   *  before the click toggles it back open, and the re-opened one is a fresh mount with its own
   *  focus and its own state. Told during the click instead, the parent re-opens the very element
   *  that is mid-exit — React reuses it, `closing` never clears, and the menu is stuck invisible and
   *  inert forever, which is precisely the leak this feature must not introduce. */
  const flush = useCallback(() => {
    if (!closingRef.current || !timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
    onCloseRef.current();
  }, []);

  const close = useCallback(() => {
    if (closingRef.current) return;
    // Reduced motion skips the hold rather than running it at zero duration. The global
    // `animation: none !important` would otherwise leave the surface fully painted and merely
    // unusable for the length of an exit nobody asked to see.
    if (!exit || reducedMotion()) { onCloseRef.current(); return; }
    closingRef.current = true;
    setClosing(true);
    // Focus leaves with the gesture, not with the unmount: the surface goes inert this frame, and a
    // keystroke in the gap between the two would otherwise land on <body>.
    restoreFocus();
    timer.current = setTimeout(() => onCloseRef.current(), EXIT_MS);
  }, [exit, restoreFocus]);

  useLayoutEffect(() => {
    restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      // The parent may unmount the surface out from under a running exit (its pane closed, the
      // session switched). Dropping the timer here is what keeps that from calling `onClose` on a
      // parent that has already moved on.
      if (timer.current) clearTimeout(timer.current);
      restoreFocus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount/unmount only
  }, []);

  useLayoutEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (closingRef.current) { flush(); return; }
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      // The trigger lives OUTSIDE the portal, so an anchored surface would otherwise close on its own
      // trigger's pointerdown and the following click would reopen it — flicker, focus ping-pong, and
      // no way to dismiss by clicking the control again. Leave the trigger to its own toggle.
      if (anchorRef?.current?.contains(target)) return;
      close();
    };
    // A surface already on its way out must not keep swallowing Escape: the key belongs to whatever
    // is behind it for the rest of the exit.
    const onKey = (e: KeyboardEvent) => {
      if (closingRef.current) { flush(); return; } // and Escape passes through: the key is the app's again
      if (e.key !== "Escape") return;
      e.stopPropagation(); close();
    };
    // Deferred so the click that opened the surface doesn't immediately close it.
    const id = setTimeout(() => { window.addEventListener("pointerdown", onDown); window.addEventListener("keydown", onKey, true); }, 0);
    return () => { clearTimeout(id); window.removeEventListener("pointerdown", onDown); window.removeEventListener("keydown", onKey, true); };
  }, [ref, close, flush, anchorRef]);

  return { pos, closing, close };
}
