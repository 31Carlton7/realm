import { useEffect } from "react";
import { ChatFeed } from "./ChatFeed";
import { NeedsYou } from "./NeedsYou";
import { SidebarHeader } from "./SidebarHeader";
import { SidebarLens } from "./SidebarLens";
import { SidebarResizer } from "./SidebarResizer";
import { SpaceSwiper } from "./SpaceSwiper";
import { SpaceStrip } from "./SpaceStrip";
import { useApp } from "../../state/store";

/**
 * The sidebar (Plan 27): get me to my work, and tell me what needs me.
 *
 * The head row is the profile, search and a new session, in the traffic lights' band beside the
 * rail. Under it, what waits on you from every space, then the list itself under a two-way lens.
 * The app's destinations are the rail's, not rows here.
 */
export function Sidebar({ collapsed = false }: { collapsed?: boolean }) {
  const lens = useApp((s) => s.sidebarLens);
  const hydrateSidebarPrefs = useApp((s) => s.hydrateSidebarPrefs);
  const run = useApp((s) => s.run);
  useEffect(() => { run(() => hydrateSidebarPrefs()); }, [hydrateSidebarPrefs, run]);
  return (
    <aside id="app-sidebar" className="sidebar" data-collapsed={collapsed || undefined} inert={collapsed || undefined}>
      <SidebarHeader />
      <div className="sb-top">
        <NeedsYou />
        <SidebarLens />
      </div>
      {lens === "recent" ? <ChatFeed /> : <SpaceSwiper />}
      <SpaceStrip />
      {/* Inside the column rather than between it and the panes, so that `inert` above reaches it:
          a collapsed sidebar is off-screen, and a handle for a column nobody can see would still
          answer the keyboard. */}
      <SidebarResizer />
    </aside>
  );
}
