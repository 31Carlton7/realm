import { Icon } from "@realm/ui";
import { useState } from "react";
import { allItems, emptyLayout, type Item } from "@realm/contracts";
import { useApp } from "../../state/store";
import { RenameInput, useItemContextMenu } from "./ItemContextMenu";

const STATUS_LABEL = { idle: "idle", running: "running", waiting_permission: "needs permission", error: "error", ended: "ended" } as const;

/** Unpinned items as rows: icon, title, status dot for sessions, close on hover. */
export function ItemList({ items }: { items: Item[] }) {
  const layout = useApp((s) => s.layout);
  const sessionStatus = useApp((s) => s.sessionStatus);
  const openItem = useApp((s) => s.openItem);
  const deleteItem = useApp((s) => s.deleteItem);
  const run = useApp((s) => s.run);
  const [renaming, setRenaming] = useState<Item | null>(null);
  const { onContextMenu, element } = useItemContextMenu(setRenaming);
  const active = new Set(allItems(layout ?? emptyLayout()));
  return (
    <div className="item-list">
      {items.map((it) => (
        <div key={it.id} className="item" data-active={active.has(it.id) || undefined} onContextMenu={onContextMenu(it)}>
          {renaming?.id === it.id ? <RenameInput item={it} onDone={() => setRenaming(null)} /> : (
            <>
              <button className="item-row" aria-label={it.title} onClick={() => run(() => openItem(it.id))}>
                <Icon name={it.kind} size={14} /><span className="item-title">{it.title}</span>
                {it.kind === "session" && sessionStatus[it.refId] && (
                  <span className="status-dot item-status" data-status={sessionStatus[it.refId]} title={STATUS_LABEL[sessionStatus[it.refId]!]} />
                )}
              </button>
              <button className="item-close" aria-label={`Close ${it.title}`} onClick={() => run(() => deleteItem(it.id))}><Icon name="close" size={12} /></button>
            </>
          )}
        </div>
      ))}
      {element}
    </div>
  );
}
