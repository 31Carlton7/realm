import { Icon } from "@realm/ui";
import { useEffect, useMemo } from "react";
import { useApp, useProfileSpaces } from "../../state/store";
import { NeedsYou } from "./NeedsYou";
import { PinnedGrid } from "./PinnedGrid";
import { RecentList } from "./RecentList";
import { SidebarHeader } from "./SidebarHeader";
import { SidebarLens } from "./SidebarLens";
import { SidebarResizer } from "./SidebarResizer";
import { SpaceSections } from "./SpaceSections";
import { pinnedItems } from "./model";
import { useAllItemsFresh, useOpenAnywhere, useProfileRows, useSidebarState } from "./use-sidebar-model";

/**
 * The sidebar (Plan 27): get me to my work, and tell me what needs me.
 *
 * Five things, in this order, and nothing the window already shows: the profile, search and a new
 * session in one head row; what waits on you; the profile's pinned items; its spaces as sections of
 * one list, or the same sessions by time; and New space at the end. The app's destinations are the
 * rail's. It lists SESSIONS — a terminal, a browser or a diff is something a session opens, and lives
 * in that session's side pane, not here.
 *
 * One scroller holds the lot, so a long list lengthens the column rather than pushing anything
 * around; it dissolves at both ends by masking itself (`.space-body`).
 */
export function Sidebar({ collapsed = false }: { collapsed?: boolean }) {
  const lens = useApp((s) => s.sidebarLens);
  const hydrateSidebarPrefs = useApp((s) => s.hydrateSidebarPrefs);
  const run = useApp((s) => s.run);
  useEffect(() => { run(() => hydrateSidebarPrefs()); }, [hydrateSidebarPrefs, run]);
  const state = useSidebarState();
  const rows = useProfileRows(state);
  const refresh = useAllItemsFresh();
  return (
    <aside id="app-sidebar" className="sidebar" data-collapsed={collapsed || undefined} inert={collapsed || undefined}>
      <SidebarHeader />
      <div className="sb-list">
        <div className="space-body">
          <NeedsYou />
          <Pinned onChanged={refresh} />
          <SidebarLens />
          {lens === "recent"
            ? <RecentList rows={rows} onChanged={refresh} />
            : <><SpaceSections state={state} rows={rows} onChanged={refresh} /><NewSpaceRow /></>}
        </div>
      </div>
      {/* Inside the column rather than between it and the panes, so that `inert` above reaches it:
          a collapsed sidebar is off-screen, and a handle for a column nobody can see would still
          answer the keyboard. */}
      <SidebarResizer />
    </aside>
  );
}

/** The profile's own favourites, from any of its spaces, small. */
function Pinned({ onChanged }: { onChanged: () => void }) {
  const state = useSidebarState();
  const spaces = useProfileSpaces();
  const items = useMemo(() => pinnedItems(state, spaces), [state, spaces]);
  const open = useOpenAnywhere();
  if (items.length === 0) return null;
  return (
    <section className="sb-pinned" aria-label="Pinned">
      <div className="group-label">Pinned</div>
      <PinnedGrid items={items} onOpen={open} onChanged={onChanged} />
    </section>
  );
}

/** New space, at the end of the list. */
function NewSpaceRow() {
  const openSheet = useApp((s) => s.openSheet);
  return (
    <button type="button" className="item-row sb-new-space" onClick={() => openSheet({ kind: "new-space" })}>
      <Icon name="add" size={16} /><span>New space</span>
    </button>
  );
}
