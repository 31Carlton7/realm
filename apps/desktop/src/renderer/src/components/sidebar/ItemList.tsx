import { Icon } from "@realm/ui";
import { useState } from "react";
import type { Item } from "@realm/contracts";
import { useApp } from "../../state/store";
import { RenameInput, useItemContextMenu } from "./ItemContextMenu";
import { activeTabIds } from "./active-tabs";

/** Unpinned items as rows: icon, title, (status dot — sessions, Part B), close on hover. */
export function ItemList({ items }: { items: Item[] }) {
  const layout = useApp((s) => s.layout);
  const activateTab = useApp((s) => s.activateTab);
  const closeItem = useApp((s) => s.closeItem);
  const run = useApp((s) => s.run);
  const [renaming, setRenaming] = useState<Item | null>(null);
  const { onContextMenu, element } = useItemContextMenu(setRenaming);
  const active = activeTabIds(layout);
  return (
    <div className="item-list">
      {items.map((it) => (
        <div key={it.id} className="item" data-active={active.has(it.id) || undefined} onContextMenu={onContextMenu(it)}>
          {renaming?.id === it.id ? <RenameInput item={it} onDone={() => setRenaming(null)} /> : (
            <>
              <button className="item-row" aria-label={it.title} onClick={() => run(() => activateTab(it.id))}>
                <Icon name={it.kind} size={14} /><span className="item-title">{it.title}</span>
              </button>
              <button className="item-close" aria-label={`Close ${it.title}`} onClick={() => run(() => closeItem(it.id))}><Icon name="close" size={12} /></button>
            </>
          )}
        </div>
      ))}
      {element}
    </div>
  );
}
