import { useMemo, useState } from "react";
import { itemIdOfLeaf, type Item } from "@realm/contracts";
import { useApp } from "../../state/store";
import { RenameInput } from "../RenameInput";
import { ItemIcon } from "../PageIcon";
import { useItemContextMenu } from "./ItemContextMenu";
import { ItemGlyph } from "./ItemList";
import { agentsWaiting, sessionRowOf, type SidebarState } from "./model";
import { SessionRowView, UnpinButton } from "./SessionRows";

/**
 * The profile's pinned items, from any of its spaces (Plan 27), as rows of the column's own anatomy:
 * the item's mark, its title across the width, and at the far end the same state a session row wears
 * — running, needs you (with its sub-agents' count), failed, or finished while you were away. They
 * were Arc's icon tiles, and a session has no picture to be told apart by: twelve identical chat
 * bubbles over titles cut to six letters, saying nothing about which of them had finished.
 *
 * `spaceName` names each pin's space in its accessible name and tooltip; `onChanged` is told after a
 * write from a pin, so a list drawn from every space can read its items again.
 */
export function PinnedList({ items, state, spaceName, onOpen, onChanged }: {
  items: Item[]; state: SidebarState; spaceName: (spaceId: string) => string | undefined;
  onOpen: (item: Item) => void; onChanged: () => void;
}) {
  const rows = useMemo(() => {
    const waiting = agentsWaiting(state);
    return items.map((it) => ({ item: it, session: it.kind === "session" ? sessionRowOf(state, it, waiting) : null }));
  }, [items, state]);
  if (rows.length === 0) return null;
  return (
    <div className="item-list sb-pinned-rows">
      {rows.map(({ item, session }) => (session
        ? <SessionRowView key={item.id} row={session} where={spaceName(session.spaceId)} pinned onChanged={onChanged} />
        : <PinnedItemRow key={item.id} item={item} where={spaceName(item.spaceId)} onOpen={onOpen} onChanged={onChanged} />))}
    </div>
  );
}

/** A pinned page, document or terminal: the session row's anatomy with the item's own mark — a
 *  page's icon, a terminal's program — and no state of its own to report. */
function PinnedItemRow({ item, where, onOpen, onChanged }: { item: Item; where?: string; onOpen: (item: Item) => void; onChanged: () => void }) {
  const layout = useApp((s) => s.layout);
  const focused = useApp((s) => (s.layout ? itemIdOfLeaf(s.layout, s.focusedLeafId) === item.id : false));
  const [renaming, setRenaming] = useState(false);
  const { onContextMenu, element } = useItemContextMenu(() => setRenaming(true), { onChanged });
  const said = where ? `${item.title} in ${where}` : item.title;
  return (
    <div className="item sb-row" data-active={focused || undefined} data-actions="1" draggable
      onDragStart={(e) => { e.dataTransfer.setData("application/x-realm-item", item.id); e.dataTransfer.effectAllowed = "move"; }}
      onContextMenu={onContextMenu(item)}>
      {renaming ? <RenameInput item={item} onDone={() => { setRenaming(false); onChanged(); }} /> : (
        <>
          <button type="button" className="item-row" aria-label={said} title={said} onClick={() => onOpen(item)}>
            <ItemIcon item={item} size={16} />
            <span className="item-title">{item.title}</span>
            <span className="item-trail">{layout && <ItemGlyph layout={layout} itemId={item.id} />}</span>
          </button>
          <span className="item-actions"><UnpinButton item={item} onChanged={onChanged} /></span>
        </>
      )}
      {element}
    </div>
  );
}
