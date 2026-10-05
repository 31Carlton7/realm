import { Icon } from "@realm/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { PaneFor } from "../panes/registry";
import { PAGE_LABEL, pageItemOf } from "../state/page-item";
import { sidebarHidden } from "../state/selectors";
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
 * sidebar stay reachable, because they are the way out: Home or the lit rail button pressed again, a
 * session in the sidebar, the column's Back, or Escape. Its bar draws no close of its own (the owner,
 * 10-05: "Remove the close button… Can nav this with the sidebar"). It is drawn inside the panes' own
 * column (AppShell's `.main`) rather than over the window, so its box is the panes' box in every frame:
 * when the sidebar opens or closes, the page, its bar and the panes under it move as one.
 *
 * The page components are untouched. What they want from an `Item` is a kind, a refId and the space
 * to read from; `pageItemOf` hands them exactly that, built rather than stored.
 */
export function PageOverlay() {
  const page = useApp((s) => s.pageOverlay);
  const close = useApp((s) => s.closePageOverlay);
  const sidebarGone = useApp(sidebarHidden);
  const cut = useArrivesWithSidebar(page !== null, sidebarGone);
  const ref = useRef<HTMLDivElement>(null);

  /* Escape goes back to where you were, and nothing else does from the keyboard. Registered while the
     overlay is up, so it cannot answer for a sheet opened over it: a sheet mounts later and its own
     handler runs first (App's own note about mount-order precedence). */
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
    <div className="page-overlay" role="dialog" aria-label={PAGE_LABEL[page.kind] ?? "Page"} ref={ref} tabIndex={-1}
      data-cut={cut || undefined}>
      {/* The page's name and nothing else. A page is a destination, left the way it was reached — the
          sidebar or the rail beside it — or with Escape. A × here was one more way out, at the far
          end of the bar from the ones the page was reached by. */}
      <header className="page-overlay-bar">
        <Icon name={page.kind} size={14} className="page-overlay-mark" />
        <span className="page-overlay-title">{PAGE_LABEL[page.kind] ?? "Page"}</span>
      </header>
      <div className="page-overlay-body">
        <InPageOverlay value={true}><PaneFor item={item} visible focused /></InPageOverlay>
      </div>
    </div>
  );
}

/**
 * Whether the page opened in the same update that opened or closed the sidebar — Connections from a
 * session, say, which takes the spaces away as it arrives. Such a page arrives at once rather than
 * rising in (`data-cut`): the sidebar goes in that frame (App.tsx, `useSidebarCut`) and the panes
 * under the page take its width, and through a page still fading in they were seen doing it.
 *
 * Decided as the page opens and held while it is up. An entrance plays once, as the page is drawn,
 * and taking its `animation: none` away later would play it then, over a page already there.
 */
function useArrivesWithSidebar(open: boolean, hidden: boolean): boolean {
  const [last, setLast] = useState({ open, hidden, cut: false });
  if (last.open === open && last.hidden === hidden) return last.cut;
  const cut = open && !last.open ? hidden !== last.hidden : last.cut;
  setLast({ open, hidden, cut });
  return cut;
}
