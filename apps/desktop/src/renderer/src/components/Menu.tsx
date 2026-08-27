import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

export type MenuItem =
  | { kind?: "item"; label: ReactNode; onSelect: () => void; disabled?: boolean; title?: string; checked?: boolean; danger?: boolean;
      /** Selecting keeps the menu open (two-step confirms rebuild their items in place). */
      keepOpen?: boolean }
  | { kind: "separator" };

const MARGIN = 6;

/** Small popup menu, rendered in a portal with fixed positioning so no ancestor overflow can clip
 *  it. Anchor it to a control via `anchorRef` (opens below, flips above near the bottom edge) or
 *  place it at a point via `at` (context menus). Closes on outside pointerdown, Escape, or select. */
export function Menu({ items, onClose, at, anchorRef, align = "left", label }: {
  items: MenuItem[]; onClose: () => void;
  at?: { x: number; y: number }; anchorRef?: RefObject<HTMLElement | null>;
  align?: "left" | "right"; label?: string;
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
        top = a.bottom + 4;
        if (top + height > window.innerHeight - MARGIN) top = a.top - height - 4; // flip above
      }
    }
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - width - MARGIN));
    top = Math.max(MARGIN, Math.min(top, window.innerHeight - height - MARGIN));
    setPos({ left, top });
  }, [at, anchorRef, align]);

  useLayoutEffect(() => {
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    // Deferred so the click that opened the menu doesn't immediately close it.
    const id = setTimeout(() => { window.addEventListener("pointerdown", onDown); window.addEventListener("keydown", onKey, true); }, 0);
    return () => { clearTimeout(id); window.removeEventListener("pointerdown", onDown); window.removeEventListener("keydown", onKey, true); };
  }, [onClose]);

  const style: CSSProperties = { position: "fixed", left: pos?.left ?? -9999, top: pos?.top ?? -9999, visibility: pos ? "visible" : "hidden" };
  return createPortal(
    <div ref={ref} role="menu" aria-label={label} className="menu" style={style}>
      {items.map((it, i) => it.kind === "separator"
        ? <div key={i} className="menu-sep" role="separator" />
        : (
          <button key={i} role="menuitem" disabled={it.disabled} title={it.title} aria-checked={it.checked}
            className={(it.checked ? "checked" : "") + (it.danger ? " danger" : "")}
            onClick={() => { it.onSelect(); if (!it.keepOpen) onClose(); }}>
            {it.label}
          </button>
        ))}
    </div>,
    document.body,
  );
}
