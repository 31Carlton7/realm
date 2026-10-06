import { useState } from "react";
import type { Item } from "@realm/contracts";
import { useApp } from "../../state/store";
import { RenameInput } from "../RenameInput";
import { ItemIcon } from "../PageIcon";
import { useItemContextMenu } from "./ItemContextMenu";

/** Pinned items as a grid of icon tiles (Arc "favorites") — the profile's own favourites, from any of
 *  its spaces (Plan 27). `onOpen` is how a tile from another space is opened; `onChanged` is told
 *  after a write from a tile's menu, so a list drawn from every space can read its items again. */
export function PinnedGrid({ items, onOpen, onChanged }: { items: Item[]; onOpen?: (item: Item) => void; onChanged?: () => void }) {
  const openItem = useApp((s) => s.openItem);
  const run = useApp((s) => s.run);
  const [renaming, setRenaming] = useState<Item | null>(null);
  const { onContextMenu, element } = useItemContextMenu(setRenaming, { onChanged });
  if (items.length === 0) return null;
  return (
    <div className="pinned-grid">
      {items.map((it) => renaming?.id === it.id
        ? <div key={it.id} className="tile tile-rename"><RenameInput item={it} onDone={() => { setRenaming(null); onChanged?.(); }} /></div>
        : (
          <button key={it.id} className="tile" data-tile="true" title={it.title} aria-label={it.title}
            onClick={() => (onOpen ? onOpen(it) : run(() => openItem(it.id)))} onContextMenu={onContextMenu(it)}>
            <ItemIcon item={it} size={18} /><span className="tile-title">{it.title}</span>
          </button>
        ))}
      {element}
    </div>
  );
}
