import { useCallback, useState, type MouseEvent } from "react";
import { allItems, emptyLayout, type Item } from "@realm/contracts";
import { useApp } from "../../state/store";
import { Menu } from "../Menu";

export type ItemMenuState = { item: Item; x: number; y: number } | null;

/** Right-click menu shared by pinned tiles and list rows: Pin/Unpin, Rename (inline, via `onRename`),
 *  Move to space… (sessions only, only while unstarted), Close (layout-only, offered only while the
 *  item is open), Delete (destructive, always offered). */
export function useItemContextMenu(onRename: (item: Item) => void) {
  const [menu, setMenu] = useState<ItemMenuState>(null);
  // Two-step destructive confirm (U-H2): the first Delete click arms this in place; only the second
  // click, within the same open menu, deletes. Opening or closing the menu disarms.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // "Move to space…" swaps the menu's own item list in place, the same trick — no submenu primitive
  // exists on `Menu`, so a second render of the SAME menu is the picker.
  const [movingToSpace, setMovingToSpace] = useState(false);
  const updateItem = useApp((s) => s.updateItem);
  const closeFromLayout = useApp((s) => s.closeFromLayout);
  const deleteItem = useApp((s) => s.deleteItem);
  const moveSessionToSpace = useApp((s) => s.moveSessionToSpace);
  const layout = useApp((s) => s.layout) ?? emptyLayout();
  const sessions = useApp((s) => s.sessions);
  const spaces = useApp((s) => s.spaces);
  const activeSpaceId = useApp((s) => s.activeSpaceId);
  const openCheckpoints = useApp((s) => s.openCheckpoints);
  const run = useApp((s) => s.run);
  const onContextMenu = useCallback((item: Item) => (e: MouseEvent) => {
    e.preventDefault(); setConfirmingDelete(false); setMovingToSpace(false); setMenu({ item, x: e.clientX, y: e.clientY });
  }, []);
  const close = useCallback(() => { setMenu(null); setConfirmingDelete(false); setMovingToSpace(false); }, []);
  // A session's own checkpoints (W4), scoped to the session rather than to the whole checkout: the
  // diff pane's History shows every turn in the environment, this shows the ones this session took.
  const session = menu?.item.kind === "session" ? sessions[menu.item.refId] : undefined;
  // The client-observable proxy for the server's `events.hasAny(id)` guard (same convention
  // SessionPane's `canSwitchAgent` uses): a UX nicety only, the server's own check is authoritative.
  const canMove = session !== undefined && session.lastEventSeq === 0;
  const destinations = spaces.filter((sp) => sp.id !== (session?.spaceId ?? activeSpaceId));
  const element = menu ? (
    <Menu at={{ x: menu.x, y: menu.y }} label={movingToSpace ? `Move ${menu.item.title} to…` : `Actions for ${menu.item.title}`} onClose={close} items={
      movingToSpace
        ? (destinations.length > 0
            ? destinations.map((sp) => ({ label: sp.name, onSelect: () => run(() => moveSessionToSpace(session!.id, sp.id)) }))
            : [{ label: "No other spaces", disabled: true, onSelect: () => {} }])
        : [
            { label: menu.item.pinned ? "Unpin" : "Pin", onSelect: () => run(() => updateItem({ id: menu.item.id, pinned: !menu.item.pinned })) },
            { label: "Rename", onSelect: () => onRename(menu.item) },
            ...(session ? [{ label: "Checkpoints…", onSelect: () => run(() => openCheckpoints(session.environmentId, session.id)) }] : []),
            ...(canMove ? [{ label: "Move to space…", keepOpen: true, onSelect: () => setMovingToSpace(true) }] : []),
            { kind: "separator" as const },
            ...(allItems(layout).includes(menu.item.id)
              ? [{ label: "Close", onSelect: () => run(() => closeFromLayout(menu.item.id)) }]
              : []),
            confirmingDelete
              ? { label: <strong>Really delete?</strong>, danger: true, onSelect: () => run(() => deleteItem(menu.item.id)) }
              : { label: "Delete", danger: true, keepOpen: true, onSelect: () => setConfirmingDelete(true) },
          ]
    } />
  ) : null;
  return { onContextMenu, element };
}

