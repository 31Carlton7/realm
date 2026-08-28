import { Icon } from "@realm/ui";
import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

export type MenuItem =
  | { kind?: "item"; label: ReactNode; onSelect: () => void; disabled?: boolean; title?: string; checked?: boolean; danger?: boolean;
      /** Right-aligned shortcut hint, e.g. "⌘W". Purely visual — the binding lives in hotkeys.ts. */
      kbd?: string;
      /** Selecting keeps the menu open (two-step confirms rebuild their items in place). */
      keepOpen?: boolean }
  | { kind: "separator" };

const MARGIN = 6;

/** Small popup menu, rendered in a portal with fixed positioning so no ancestor overflow can clip
 *  it. Anchor it to a control via `anchorRef` (opens below, flips above near the bottom edge — or
 *  `placement="up"` to open above, flipping below near the top edge; the prompter's chip menus) or
 *  place it at a point via `at` (context menus). Closes on outside pointerdown, Escape, or select.
 *
 *  Keyboard-first (U-M10/A-H3): the first enabled item is focused on open; ArrowUp/Down cycle with
 *  wrap, Home/End jump, Enter/Space select. Focus returns to where it was on close — the element
 *  focused at mount (normally the trigger), or `returnFocusRef` when the caller knows better.
 *  Items with a `checked` boolean render as menuitemcheckbox with aria-checked and a check icon. */
export function Menu({ items, onClose, at, anchorRef, returnFocusRef, align = "left", placement = "down", label }: {
  items: MenuItem[]; onClose: () => void;
  at?: { x: number; y: number }; anchorRef?: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  align?: "left" | "right"; placement?: "down" | "up"; label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    let left: number, top: number;
    if (at) { left = at.x; top = at.y; }
    else {
      const a = anchorRef?.current?.getBoundingClientRect();
      if (!a) { left = MARGIN; top = MARGIN; }
      else {
        left = align === "right" ? a.right - width : a.left;
        if (placement === "up") {
          top = a.top - height - 4;
          if (top < MARGIN) top = a.bottom + 4; // flip below near the top edge
        } else {
          top = a.bottom + 4;
          if (top + height > window.innerHeight - MARGIN) top = a.top - height - 4; // flip above
        }
      }
    }
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - width - MARGIN));
    top = Math.max(MARGIN, Math.min(top, window.innerHeight - height - MARGIN));
    setPos({ left, top });
  }, [at, anchorRef, align, placement]);

  // Focus-in on open + focus restore on close. The restore target is captured once at mount, before
  // the roving focus moves into the menu, so it is the trigger unless the caller overrides it.
  useLayoutEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    focusItem(0);
    return () => {
      const target = returnFocusRef?.current ?? prev;
      // The trigger may have unmounted with the menu (e.g. the menu's own Close/Delete removed the
      // pane): fall back to the focused panel — a deliberate body-safe no-op when it isn't focusable.
      if (target?.isConnected) target.focus?.();
      else document.querySelector<HTMLElement>(".panel[data-focused]")?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount/unmount only
  }, []);

  useLayoutEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      // The trigger lives OUTSIDE the portal, so an anchored menu would otherwise close on its own
      // trigger's pointerdown and the following click would reopen it — flicker, focus ping-pong, and
      // no way to dismiss by clicking the control again. Leave the trigger to its own toggle.
      if (anchorRef?.current?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    // Deferred so the click that opened the menu doesn't immediately close it.
    const id = setTimeout(() => { window.addEventListener("pointerdown", onDown); window.addEventListener("keydown", onKey, true); }, 0);
    return () => { clearTimeout(id); window.removeEventListener("pointerdown", onDown); window.removeEventListener("keydown", onKey, true); };
  }, [onClose, anchorRef]);

  const buttons = () =>
    Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);

  /** Focus the enabled item at index `i`, wrapping both ways (disabled items never match the selector). */
  const focusItem = (i: number) => {
    const bs = buttons(); if (bs.length === 0) return;
    bs[((i % bs.length) + bs.length) % bs.length]?.focus();
  };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const bs = buttons(); if (bs.length === 0) return;
    const cur = bs.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") { e.preventDefault(); focusItem(cur + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); focusItem(cur - 1); }
    else if (e.key === "Home") { e.preventDefault(); focusItem(0); }
    else if (e.key === "End") { e.preventDefault(); focusItem(bs.length - 1); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); bs[cur]?.click(); }
  };

  const style: CSSProperties = { position: "fixed", left: pos?.left ?? -9999, top: pos?.top ?? -9999, visibility: pos ? "visible" : "hidden" };
  return createPortal(
    <div ref={ref} role="menu" aria-label={label} className="menu" style={style} onKeyDown={onKeyDown}>
      {items.map((it, i) => it.kind === "separator"
        ? <div key={i} className="menu-sep" role="separator" />
        : (
          <button key={i} role={it.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
            disabled={it.disabled} title={it.title} aria-checked={it.checked !== undefined ? it.checked : undefined}
            className={(it.checked ? "checked" : "") + (it.danger ? " danger" : "")}
            onClick={() => { it.onSelect(); if (!it.keepOpen) onClose(); }}>
            <span className="menu-label">{it.label}</span>
            {it.kbd && <kbd className="menu-kbd">{it.kbd}</kbd>}
            {it.checked && <Icon name="check" size={13} className="menu-check" />}
          </button>
        ))}
    </div>,
    document.body,
  );
}
