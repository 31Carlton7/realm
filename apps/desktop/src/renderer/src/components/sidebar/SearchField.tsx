import { Icon } from "@realm/ui";
import { useApp } from "../../state/store";

export function SearchField() {
  const setPaletteOpen = useApp((s) => s.setPaletteOpen);
  return (
    <button className="search" aria-label="Search (⌘K)" onClick={() => setPaletteOpen(true)}>
      <Icon name="search" size={14} /><span>Search…</span><kbd>⌘K</kbd>
    </button>
  );
}
