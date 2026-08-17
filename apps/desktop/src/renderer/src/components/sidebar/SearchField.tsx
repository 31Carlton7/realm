import { Icon } from "@realm/ui";
import { useApp } from "../../state/store";

export function SearchField() {
  const setPaletteOpen = useApp((s) => s.setPaletteOpen);
  return (
    <button className="search" aria-label="Ask or search (⌘K)" onClick={() => setPaletteOpen(true)}>
      <Icon name="search" size={14} /><span>Ask or search…</span><kbd>⌘K</kbd>
    </button>
  );
}
