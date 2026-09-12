import { ChatFeed } from "./ChatFeed";
import { Destinations } from "./Destinations";
import { SidebarActivity } from "./SidebarActivity";
import { NewSessionRow } from "./NewSessionRow";
import { SidebarNotifications } from "./SidebarNotifications";
import { SidebarResizer } from "./SidebarResizer";
import { SidebarToggle } from "./SidebarToggle";
import { SpaceHeader } from "./SpaceHeader";
import { SpaceSwiper } from "./SpaceSwiper";
import { SpaceStrip } from "./SpaceStrip";
import { useApp } from "../../state/store";

/** Arc-style sidebar: the space's name under the traffic lights, "New session" as the first row
 *  (Ara refresh §5 — Ara's "New chat" sits at the top), the destination rows (Plan 12 W4), one
 *  visible space (swipe to switch), space strip at the bottom.
 *
 *  `.sb-head` is the strip the traffic lights sit in. It used to be `.sb-top`'s 40px of top padding
 *  and nothing else; it is a real row now so the collapse toggle can sit at its right edge — the
 *  mirror of the traffic lights at its left, in the same vertical band the toggle keeps when the
 *  sidebar collapses and it moves to the top rail. The two watching buttons — what arrived, and what
 *  the agents have been doing — sit beside it: both are app-level, both are glyphs whose state is
 *  "is this up", and neither is a place in this space worth a row in the nav below. */
export function Sidebar({ collapsed = false }: { collapsed?: boolean }) {
  const activity = useApp((s) => s.sidebarView === "activity");
  return (
    <aside id="app-sidebar" className="sidebar" data-collapsed={collapsed || undefined} inert={collapsed || undefined}>
      {/* Not while collapsed. The sidebar stays MOUNTED now so it can slide rather than vanish, and
          a second toggle living in here — inert, but still in the tree — would be two buttons with
          one name, told apart only by a property jsdom does not implement and a reader cannot see.
          One control, wherever it currently lives. */}
      <div className="sb-head">{!collapsed && <><SidebarNotifications /><SidebarActivity /><SidebarToggle /></>}</div>
      {/* The space's name heads the column, rather than sitting above the list.
          It used to sit inside each swiper page, which made it N headers with N identical "Space
          menu" buttons — one per space, told apart only by `inert`. There is one space you are in,
          so there is one title. The cost is that the name no longer slides with the page under a
          two-finger swipe; it swaps when the gesture commits, which is also when the rows do. */}
      <div className="sb-top">
        <SpaceHeader />
        <NewSessionRow />
      </div>
      <Destinations />
      {/* One body, two lenses. The feed stands where the space's list stands rather than beside it:
          they answer the same shape of question, and the column has room for one answer. Everything
          above stays — the title, the search, the destinations are how you get anywhere, and a lens
          that took those away would be a mode rather than a view. */}
      {activity ? <ChatFeed /> : <SpaceSwiper />}
      <SpaceStrip />
      {/* Inside the column rather than between it and the panes, so that `inert` above reaches it:
          a collapsed sidebar is off-screen, and a handle for a column nobody can see would still
          answer the keyboard. */}
      <SidebarResizer />
    </aside>
  );
}
