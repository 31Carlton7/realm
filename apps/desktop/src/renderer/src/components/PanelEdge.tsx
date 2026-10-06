import { useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { PANEL_MIN_WIDTH, PANEL_SHARE, PANE_DIVIDER } from "@realm/contracts";

/** What one arrow key moves, and with Shift held — the sidebar edge's steps (SidebarResizer). */
const STEP = 16, FINE_STEP = 1;

/**
 * The side panel's left edge, as a control.
 *
 * The pane divider's line and its lit state, with the sidebar edge's semantics: a separator with a
 * value and a range, so the arrows and Home/End do what the drag does and a screen reader hears "Side
 * panel width, 640". The range is the room: never narrower than the panel's floor, never so wide the
 * main panes go below theirs (`PANE_MIN`). What is remembered is the share of the main area the drag
 * ended on, so the panel keeps its proportion as the window and the sidebar change.
 *
 * The drag writes the column's width straight onto it and the store hears once, at the end — through
 * React every move would re-render every pane beside it. The views in the panel follow on their own
 * resize observers, which is what keeps a browser's native view on its pane through the drag. Pointer
 * captured, so it survives the pointer crossing a native view or leaving the window. Double-click
 * puts it back to half.
 */
export function PanelEdge({ width, roomWidth, need, column, onResize }: {
  /** The panel's drawn width. */
  width: number;
  /** The pane host's width: what the share is a share of. */
  roomWidth: number;
  /** The least the main panes need beside it. */
  need: number;
  /** The panel's column, which the drag resizes directly. */
  column: RefObject<HTMLDivElement | null>;
  onResize: (share: number, opts: { commit?: boolean }) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const from = useRef({ x: 0, width, at: width });
  const max = Math.max(PANEL_MIN_WIDTH, roomWidth - need - PANE_DIVIDER);
  const clamp = (px: number) => Math.round(Math.min(max, Math.max(PANEL_MIN_WIDTH, px)));
  const commit = (px: number) => { if (roomWidth > 0) onResize(px / roomWidth, { commit: true }); };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    from.current = { x: e.clientX, width, at: width };
    setDragging(true);
    document.documentElement.setAttribute("data-panel-resizing", "");
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    // The edge is the panel's LEFT edge: the pointer moving left widens it.
    const next = clamp(from.current.width - (e.clientX - from.current.x));
    from.current.at = next;
    if (column.current) column.current.style.width = `${next}px`;
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setDragging(false);
    document.documentElement.removeAttribute("data-panel-resizing");
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    commit(from.current.at);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? FINE_STEP : STEP;
    const to = { ArrowLeft: width + step, ArrowRight: width - step, Home: max, End: PANEL_MIN_WIDTH }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    commit(clamp(to));
  };
  return (
    <div className="resize-handle panel-edge" data-resizing={dragging || undefined}
      role="separator" aria-orientation="vertical" aria-label="Side panel width" aria-controls="side-panel"
      aria-valuenow={width} aria-valuemin={PANEL_MIN_WIDTH} aria-valuemax={max}
      tabIndex={0} title="Drag to resize · double-click for half"
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={end} onPointerCancel={end}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onResize(PANEL_SHARE.default, { commit: true })} />
  );
}
