import { NewSessionRow } from "./NewSessionRow";
import { SearchField } from "./SearchField";
import { SpaceSwiper } from "./SpaceSwiper";
import { SpaceStrip } from "./SpaceStrip";

/** Arc-style sidebar: search field under the traffic lights, "New session" as the first row (Ara
 *  refresh §5 — Ara's "New chat" sits at the top), one visible space (swipe to switch), space strip
 *  at the bottom. */
export function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="sb-top">
        <SearchField />
        <NewSessionRow />
      </div>
      <SpaceSwiper />
      <SpaceStrip />
    </aside>
  );
}
