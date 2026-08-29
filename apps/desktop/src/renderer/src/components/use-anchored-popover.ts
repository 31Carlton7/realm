import { useLayoutEffect, useRef, useState, type RefObject } from "react";

export type PopoverPosition = { left: number; top: number; origin: string };

const MARGIN = 6;

/**
 * Placement and dismissal for a portalled surface anchored to a control — everything `Menu` and the
 * prompter's `ModelPicker` share, minus the contents and minus each one's own focus model (a menu
 * roves across its items; the picker starts in its search field).
 *
 * Returns `null` until the surface has been measured; render at `-9999` and `visibility: hidden`
 * until then, so the flip decision is never visible as a jump.
 */
export function useAnchoredPopover({ ref, anchorRef, at, align = "left", placement = "down", onClose, returnFocusRef }: {
  ref: RefObject<HTMLElement | null>;
  anchorRef?: RefObject<HTMLElement | null>;
  /** Place at a point instead of against an anchor (context menus). */
  at?: { x: number; y: number };
  align?: "left" | "right";
  placement?: "down" | "up";
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}): PopoverPosition | null {
  const [pos, setPos] = useState<PopoverPosition | null>(null);

  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    let left: number, top: number;
    // §6: the 140ms scale-in is origin-aware — the surface grows out of the corner nearest its
    // trigger. The vertical half flips with the surface itself (one that flipped above its anchor
    // grows upward); the horizontal half follows `align`. A point-placed menu grows from its point.
    let origin = "top left";
    if (at) { left = at.x; top = at.y; }
    else {
      const a = anchorRef?.current?.getBoundingClientRect();
      if (!a) { left = MARGIN; top = MARGIN; }
      else {
        left = align === "right" ? a.right - width : a.left;
        let above: boolean;
        if (placement === "up") {
          top = a.top - height - 4;
          above = true;
          if (top < MARGIN) { top = a.bottom + 4; above = false; } // flip below near the top edge
        } else {
          top = a.bottom + 4;
          above = false;
          if (top + height > window.innerHeight - MARGIN) { top = a.top - height - 4; above = true; } // flip above
        }
        origin = `${above ? "bottom" : "top"} ${align === "right" ? "right" : "left"}`;
      }
    }
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - width - MARGIN));
    top = Math.max(MARGIN, Math.min(top, window.innerHeight - height - MARGIN));
    setPos({ left, top, origin });
  }, [ref, at, anchorRef, align, placement]);

  // Focus restore on close. The target is captured once at mount, before any roving focus moves into
  // the surface, so it is the trigger unless the caller overrides it.
  const restore = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      const target = returnFocusRef?.current ?? restore.current;
      // The trigger may have unmounted with the surface (e.g. a menu's own Close removed the pane):
      // fall back to the focused panel — a deliberate body-safe no-op when it isn't focusable.
      if (target?.isConnected) target.focus?.();
      else document.querySelector<HTMLElement>(".panel[data-focused]")?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount/unmount only
  }, []);

  useLayoutEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      // The trigger lives OUTSIDE the portal, so an anchored surface would otherwise close on its own
      // trigger's pointerdown and the following click would reopen it — flicker, focus ping-pong, and
      // no way to dismiss by clicking the control again. Leave the trigger to its own toggle.
      if (anchorRef?.current?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    // Deferred so the click that opened the surface doesn't immediately close it.
    const id = setTimeout(() => { window.addEventListener("pointerdown", onDown); window.addEventListener("keydown", onKey, true); }, 0);
    return () => { clearTimeout(id); window.removeEventListener("pointerdown", onDown); window.removeEventListener("keydown", onKey, true); };
  }, [ref, onClose, anchorRef]);

  return pos;
}
