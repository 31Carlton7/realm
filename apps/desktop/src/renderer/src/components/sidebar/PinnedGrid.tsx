import { Icon } from "@realm/ui";
import { useState } from "react";
import type { Item } from "@realm/contracts";
import { useApp } from "../../state/store";
import { RenameInput, useItemContextMenu } from "./ItemContextMenu";
import { activeTabIds } from "./active-tabs";

/** Pinned items as a grid of icon tiles (Arc "favorites"). */
export function PinnedGrid({ items }: { items: Item[] }) {
  const layout = useApp((s) => s.layout);
  const activateTab = useApp((s) => s.activateTab);
  const run = useApp((s) => s.run);
  const [renaming, setRenaming] = useState<Item | null>(null);
  const { onContextMenu, element } = useItemContextMenu(setRenaming);
  if (items.length === 0) return null;
  const active = activeTabIds(layout);
  return (
    <div className="pinned-grid">
      {items.map((it) => renaming?.id === it.id
        ? <div key={it.id} className="tile tile-rename"><RenameInput item={it} onDone={() => setRenaming(null)} /></div>
        : (
          <button key={it.id} className="tile" data-tile="true" data-active={active.has(it.id) || undefined} title={it.title} aria-label={it.title}
            onClick={() => run(() => activateTab(it.id))} onContextMenu={onContextMenu(it)}>
            <Icon name={it.kind} size={18} /><span className="tile-title">{it.title}</span>
          </button>
        ))}
      {element}
    </div>
  );
}
