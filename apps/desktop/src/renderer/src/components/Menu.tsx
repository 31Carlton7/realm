import { Icon } from "@realm/ui";
import { useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPopover } from "./use-anchored-popover";

export type MenuItem =
  | { kind?: "item"; label: ReactNode; onSelect: () => void; disabled?: boolean; title?: string; checked?: boolean; danger?: boolean;
      /** Right-aligned shortcut hint, e.g. "⌘W". Purely visual — the binding lives in hotkeys.ts. */
      kbd?: string;
      /** Selecting keeps the menu open (two-step confirms rebuild their items in place). */
      keepOpen?: boolean }
  | { kind: "separator" };

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
  const pos = useAnchoredPopover({ ref, anchorRef, at, align, placement, onClose, returnFocusRef });

  // Focus-in on open. The hook already captured the restore target at mount, so the roving focus
  // this moves into the menu never becomes the thing focus returns to.
  useLayoutEffect(() => {
    focusItem(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only
  }, []);

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

  const style: CSSProperties = { position: "fixed", left: pos?.left ?? -9999, top: pos?.top ?? -9999,
    visibility: pos ? "visible" : "hidden", transformOrigin: pos?.origin ?? "top left" };
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
