import { SearchField } from "./SearchField";
import { SpaceSwiper } from "./SpaceSwiper";
import { SpaceStrip } from "./SpaceStrip";

/** Arc-style sidebar: search field under the traffic lights, one visible space (swipe to switch), space strip at the bottom. */
export function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="sb-top"><SearchField /></div>
      <SpaceSwiper />
      <SpaceStrip />
    </aside>
  );
}
