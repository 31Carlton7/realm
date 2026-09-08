import { Destinations } from "./Destinations";
import { NewSessionRow } from "./NewSessionRow";
import { SearchField } from "./SearchField";
import { SidebarToggle } from "./SidebarToggle";
import { SpaceSwiper } from "./SpaceSwiper";
import { SpaceStrip } from "./SpaceStrip";

/** Arc-style sidebar: search field under the traffic lights, "New session" as the first row (Ara
 *  refresh §5 — Ara's "New chat" sits at the top), the destination rows (Plan 12 W4), one visible
 *  space (swipe to switch), space strip at the bottom.
 *
 *  `.sb-head` is the strip the traffic lights sit in. It used to be `.sb-top`'s 40px of top padding
 *  and nothing else; it is a real row now so the collapse toggle can sit at its right edge — the
 *  mirror of the traffic lights at its left, in the same vertical band the toggle keeps when the
 *  sidebar collapses and it moves to the top rail. */
export function Sidebar({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <aside className="sidebar" data-collapsed={collapsed || undefined} inert={collapsed || undefined}>
      {/* Not while collapsed. The sidebar stays MOUNTED now so it can slide rather than vanish, and
          a second toggle living in here — inert, but still in the tree — would be two buttons with
          one name, told apart only by a property jsdom does not implement and a reader cannot see.
          One control, wherever it currently lives. */}
      <div className="sb-head">{!collapsed && <SidebarToggle />}</div>
      <div className="sb-top">
        <SearchField />
        <NewSessionRow />
      </div>
      <Destinations />
      <SpaceSwiper />
      <SpaceStrip />
    </aside>
  );
}
