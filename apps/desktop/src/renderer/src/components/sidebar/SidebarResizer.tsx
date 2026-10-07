import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useApp } from "../../state/store";
import { SIDEBAR_WIDTH, clampSidebarWidth } from "./sidebar-width";

/** What one arrow key moves, and what it moves with Shift held. 16 is the shell's own spacing step,
 *  so a few presses land on the numbers the rows were designed against; 1px is there because the
 *  point of a keyboard path is that it can do what the pointer can. */
const STEP = 16, FINE_STEP = 1;

/**
 * The sidebar's right edge, as a control.
 *
 * A separator you can focus — the window-splitter pattern — rather than a button: it has a value and
 * a range, and a screen reader saying "Sidebar width, 280, minimum 200, maximum 400" is the whole
 * state of it. Everything the pointer can do here the keyboard can too, which is why the arrows and
 * Home/End are wired rather than left to the drag.
 *
 * Nothing is painted at rest. The seam between the sidebar and the panes is `.main`'s border and
 * belongs to `.main`; a second line drawn here to advertise the handle would make the app's one
 * boundary 2px wide at rest, which is the gridded look design.md §3 spent a pass removing. What says
 * "this is draggable" is the cursor, which is the same answer every sidebar on the platform gives.
 *
 * The drag is pointer-captured, so it survives the pointer crossing into a pane, over a native
 * browser view, or off the window entirely — none of which would deliver a move event here
 * otherwise, and all of which are a normal way to throw a sidebar wide.
 */
export function SidebarResizer() {
  const width = useApp((s) => s.sidebarWidth);
  const setSidebarWidth = useApp((s) => s.setSidebarWidth);
  const run = useApp((s) => s.run);
  const [dragging, setDragging] = useState(false);
  /** Where the gesture began, and where it has reached. The start width rather than the live one:
   *  adding each step to the current value compounds the rounding, and a drag that came back to
   *  where it started would not land where it started. */
  const from = useRef({ x: 0, width, at: width });

  const commit = (px: number) => run(() => setSidebarWidth(px));

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    from.current = { x: e.clientX, width, at: width };
    setDragging(true);
    // The attribute is on the document because the cursor has to hold across the whole window: the
    // pointer spends the drag over the panes, and every row it passes has a cursor of its own.
    document.documentElement.setAttribute("data-sidebar-resizing", "");
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  /**
   * The column follows the pointer through the CSS variable directly, and the store hears about it
   * once, at the end.
   *
   * Through React it would be a `set` per pointer move, and the variable lives on `.app` — so every
   * move would re-render the shell, which is the sidebar, the pane host and every pane inside it.
   * The one thing that has to change during a drag is a number in a style attribute; nothing in the
   * tree below is a function of it. (`aria-valuenow` therefore lands on release rather than
   * continuously, which is the right trade: a reader who needs the value uses the arrow keys, and
   * those commit on every press.)
   */
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const next = clampSidebarWidth(from.current.width + (e.clientX - from.current.x));
    from.current.at = next;
    e.currentTarget.closest<HTMLElement>(".app")?.style.setProperty("--sidebar-w", `${next}px`);
  };

  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setDragging(false);
    document.documentElement.removeAttribute("data-sidebar-resizing");
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    // Even on a cancelled gesture: the column is already at this width on screen, and a cancel that
    // silently left the store behind would put it back on the next render of the shell.
    commit(from.current.at);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? FINE_STEP : STEP;
    const to = { ArrowLeft: width - step, ArrowRight: width + step, Home: SIDEBAR_WIDTH.min, End: SIDEBAR_WIDTH.max }[e.key];
    if (to === undefined) return;
    // Arrows scroll whatever is behind a focused element that does not want them, and Home/End jump
    // a list to its ends. This one wants them.
    e.preventDefault();
    commit(to);
  };

  return (
    <div className="sb-resize" data-resizing={dragging || undefined}
      role="separator" aria-orientation="vertical" aria-label="Sidebar width" aria-controls="app-sidebar"
      aria-valuenow={width} aria-valuemin={SIDEBAR_WIDTH.min} aria-valuemax={SIDEBAR_WIDTH.max}
      tabIndex={0} title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown} onPointerMove={onPointerMove}
      onPointerUp={end} onPointerCancel={end}
      onKeyDown={onKeyDown}
      // The way back, and the only way to hit the shipped width exactly: it is the one number in the
      // range nothing else can name.
      onDoubleClick={() => commit(SIDEBAR_WIDTH.default)} />
  );
}
