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
export function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="sb-head"><SidebarToggle /></div>
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
