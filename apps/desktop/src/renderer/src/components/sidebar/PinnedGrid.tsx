import { Icon } from "@realm/ui";
import { useState } from "react";
import type { Item } from "@realm/contracts";
import { useApp } from "../../state/store";
import { RenameInput, useItemContextMenu } from "./ItemContextMenu";

/** Pinned-but-unopened items as a grid of icon tiles (Arc "favorites"). A pinned item that's also open
 *  lives in the OPEN group instead — it's never passed here, so there's no "active" tile state to track. */
export function PinnedGrid({ items }: { items: Item[] }) {
  const openItem = useApp((s) => s.openItem);
  const run = useApp((s) => s.run);
  const [renaming, setRenaming] = useState<Item | null>(null);
  const { onContextMenu, element } = useItemContextMenu(setRenaming);
  if (items.length === 0) return null;
  return (
    <div className="pinned-grid">
      {items.map((it) => renaming?.id === it.id
        ? <div key={it.id} className="tile tile-rename"><RenameInput item={it} onDone={() => setRenaming(null)} /></div>
        : (
          <button key={it.id} className="tile" data-tile="true" title={it.title} aria-label={it.title}
            onClick={() => run(() => openItem(it.id))} onContextMenu={onContextMenu(it)}>
            <Icon name={it.kind} size={18} /><span className="tile-title">{it.title}</span>
          </button>
        ))}
      {element}
    </div>
  );
}
