import { Icon } from "@realm/ui";
import { useEffect, useMemo, useRef } from "react";
import { PaneFor } from "../panes/registry";
import { PAGE_LABEL, pageItemOf } from "../state/page-item";
import { InPageOverlay } from "./page-nav";
import { useApp } from "../state/store";

/**
 * An app-level page — Agents, Library, Connections, Notifications, Scheduled tasks, Settings, a
 * space's Overview, a profile — shown OVER the workspace rather than inside it.
 *
 * These were layout items with sentinel refIds. Opening one split a pane, zoomed it, and left a row
 * in the sidebar's Open list, so reading your notifications rearranged the workspace — and unzooming
 * afterwards left four pages sitting side by side with the session you were actually working in.
 * None of that is what "show me my settings" asks for: a page has no object under it, nothing to
 * keep, and no reason to outlive the moment you are looking at it.
 *
 * So it is an overlay, and one at a time. It covers the pane host and nothing else — the rail and the
 * sidebar stay reachable, because the buttons that open these pages are in the rail and a cover that
 * hid them would make the only way out the one control this draws. It is drawn inside the panes' own
 * column (AppShell's `.main`) rather than over the window, so its box is the panes' box in every frame:
 * when the sidebar opens or closes, the page, its bar and the panes under it move as one.
 *
 * The page components are untouched. What they want from an `Item` is a kind, a refId and the space
 * to read from; `pageItemOf` hands them exactly that, built rather than stored.
 */
export function PageOverlay() {
  const page = useApp((s) => s.pageOverlay);
  const close = useApp((s) => s.closePageOverlay);
  const ref = useRef<HTMLDivElement>(null);

  /* Escape closes, and nothing else does from the keyboard. Registered while the overlay is up, so
     it cannot answer for a sheet opened over it: a sheet mounts later and its own handler runs
     first (App's own note about mount-order precedence). */
  useEffect(() => {
    if (!page) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [page, close]);

  // Focus moves in, so the keyboard is where the eye is and Escape lands here rather than in the
  // pane behind it.
  useEffect(() => { if (page) ref.current?.focus(); }, [page]);

  const item = useMemo(() => (page ? pageItemOf(page) : null), [page]);
  if (!page || !item) return null;

  return (
    // Not `aria-modal`: the rail and the sidebar stay live beside it, and a page's own sections may be
    // drawn in the sidebar's column (page-nav.tsx) — a modal claim would hide them from a screen reader.
    <div className="page-overlay" role="dialog" aria-label={PAGE_LABEL[page.kind] ?? "Page"} ref={ref} tabIndex={-1}>
      <header className="page-overlay-bar">
        <Icon name={page.kind} size={14} className="page-overlay-mark" />
        <span className="page-overlay-title">{PAGE_LABEL[page.kind] ?? "Page"}</span>
        {/* The trash, and only the trash. A page has nothing under it to keep, so there is no second
            "close but keep it somewhere" to offer — which is exactly why it stopped being a pane. */}
        <button type="button" className="icon-btn" aria-label={`Close ${PAGE_LABEL[page.kind] ?? "page"}`}
          title="Close (Esc)" onClick={close}>
          <Icon name="trash" size={14} />
        </button>
      </header>
      <div className="page-overlay-body">
        <InPageOverlay value={true}><PaneFor item={item} visible focused /></InPageOverlay>
      </div>
    </div>
  );
}
