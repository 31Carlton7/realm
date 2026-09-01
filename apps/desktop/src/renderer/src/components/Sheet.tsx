import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { centerOverComplement } from "../state/no-overlay";
import { useBrowserRects } from "../state/store";

const FOCUSABLE = 'input, select, textarea, button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/** Generic modal: dimmed backdrop + centered panel. Escape or backdrop click closes; Tab wraps
 *  inside the panel; the first focusable control receives focus on open.
 *
 *  W2 (no-overlay): while a browser pane is open, the panel centers over the widest non-browser
 *  column instead of the window — the native view paints over anything window-centered. The store
 *  side (openSheet) has already snapped an over-wide browser leaf to a ≤50% split by the time this
 *  renders, so the column is normally sheet-sized; the width cap is the backstop. */
export function Sheet({ title, onClose, children, width = 420 }: { title: string; onClose: () => void; children: ReactNode; width?: number }) {
  const panel = useRef<HTMLDivElement>(null);
  const browserRects = useBrowserRects();
  const spot = centerOverComplement({ width: window.innerWidth, height: window.innerHeight }, browserRects, width);
  const style: CSSProperties = spot
    ? { width: spot.width, position: "absolute", left: spot.left, top: "50%", transform: "translateY(-50%)" }
    : { width };
  useEffect(() => {
    const el = panel.current; if (!el) return;
    const prev = document.activeElement as HTMLElement | null;
    ((el.querySelector(".sheet-body") ?? el).querySelector<HTMLElement>(FOCUSABLE) ?? el).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
      if (e.key !== "Tab") return;
      const nodes = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)); if (nodes.length === 0) return;
      const first = nodes[0]!, last = nodes[nodes.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("keydown", onKey, true); prev?.focus?.(); };
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={panel} role="dialog" aria-modal="true" aria-label={title} className="sheet" style={style} tabIndex={-1}>
        <div className="sheet-head"><h3>{title}</h3><button className="icon-btn" aria-label="Close" onClick={onClose}>✕</button></div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}
