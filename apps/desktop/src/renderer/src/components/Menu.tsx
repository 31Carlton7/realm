import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

export type MenuItem =
  | { kind?: "item"; label: ReactNode; onSelect: () => void; disabled?: boolean; title?: string; checked?: boolean; danger?: boolean }
  | { kind: "separator" };

/** Small popup menu. Anchored (position: absolute inside a relative parent) or placed at a fixed
 *  point (`at`) for context menus. Closes on outside pointerdown, Escape, or after selecting. */
export function Menu({ items, onClose, at, align = "left", label }: {
  items: MenuItem[]; onClose: () => void;
  at?: { x: number; y: number }; align?: "left" | "right"; label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    // Deferred so the click that opened the menu doesn't immediately close it.
    const id = setTimeout(() => { window.addEventListener("pointerdown", onDown); window.addEventListener("keydown", onKey, true); }, 0);
    return () => { clearTimeout(id); window.removeEventListener("pointerdown", onDown); window.removeEventListener("keydown", onKey, true); };
  }, [onClose]);
  const style: CSSProperties | undefined = at ? { position: "fixed", left: at.x, top: at.y } : undefined;
  return (
    <div ref={ref} role="menu" aria-label={label} className={"menu" + (align === "right" ? " menu-right" : "")} style={style}>
      {items.map((it, i) => it.kind === "separator"
        ? <div key={i} className="menu-sep" role="separator" />
        : (
          <button key={i} role="menuitem" disabled={it.disabled} title={it.title} aria-checked={it.checked}
            className={(it.checked ? "checked" : "") + (it.danger ? " danger" : "")}
            onClick={() => { it.onSelect(); onClose(); }}>
            {it.label}
          </button>
        ))}
    </div>
  );
}
