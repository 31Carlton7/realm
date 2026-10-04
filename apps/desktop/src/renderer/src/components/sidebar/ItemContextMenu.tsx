import { useCallback, useState, type MouseEvent } from "react";
import { findLeafOfItem, type Item } from "@realm/contracts";
import { useApp } from "../../state/store";
import { Menu } from "../Menu";

export type ItemMenuState = { item: Item; x: number; y: number } | null;

/** Right-click menu shared by pinned tiles and list rows: Pin/Unpin, Archive/Unarchive (sessions only),
 *  Rename (inline, via `onRename`), Open here (move the pane into the focused one, offered only while
 *  it is open somewhere else),
 *  Focus/Unfocus (fill the window with this pane, offered only while it is open), Move to space…
 *  (sessions only), Close
 *  (layout-only, offered only while the item is open), Delete (destructive, always offered).
 *  Peek (sessions only, W11b): the session as a transient tab beside the one in focus — offered only
 *  where a row click would not already show it, and only while a session is on screen to be beside. */
export function useItemContextMenu(onRename: (item: Item) => void) {
  const [menu, setMenu] = useState<ItemMenuState>(null);
  // Two-step destructive confirm (U-H2): the first Delete click arms this in place; only the second
  // click, within the same open menu, deletes. Opening or closing the menu disarms.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // ...unless the user has turned the asking off, when the first click is the only one.
  const confirmDelete = useApp((s) => s.confirmDelete);
  // "Move to space…" swaps the menu's own item list in place, the same trick — no submenu primitive
  // exists on `Menu`, so a second render of the SAME menu is the picker.
  const [movingToSpace, setMovingToSpace] = useState(false);
  const updateItem = useApp((s) => s.updateItem);
  const closeFromLayout = useApp((s) => s.closeFromLayout);
  const archiveItem = useApp((s) => s.archiveItem);
  const deleteItem = useApp((s) => s.deleteItem);
  const moveSessionToSpace = useApp((s) => s.moveSessionToSpace);
  const layout = useApp((s) => s.layout);
  const zoomedLeafId = useApp((s) => s.view?.zoomedLeafId ?? null);
  const focusPaneFull = useApp((s) => s.focusPaneFull);
  const unfocusPane = useApp((s) => s.unfocusPane);
  const sessions = useApp((s) => s.sessions);
  const spaces = useApp((s) => s.spaces);
  const activeSpaceId = useApp((s) => s.activeSpaceId);
  const openCheckpoints = useApp((s) => s.openCheckpoints);
  const openItem = useApp((s) => s.openItem);
  const focusedLeafId = useApp((s) => s.focusedLeafId);
  const peekSession = useApp((s) => s.peekSession);
  // Read at render, like the rest of this menu's offers: a menu opened with no session on screen has
  // nowhere for a peek to go, so it does not offer one.
  const peekOwner = useApp((s) => s.peekOwner());
  const run = useApp((s) => s.run);
  const onContextMenu = useCallback((item: Item) => (e: MouseEvent) => {
    e.preventDefault(); setConfirmingDelete(false); setMovingToSpace(false);
    setMenu({ item, x: e.clientX, y: e.clientY });
  }, []);
  const close = useCallback(() => { setMenu(null); setConfirmingDelete(false); setMovingToSpace(false); }, []);
  // A session's own checkpoints (W4), scoped to the session rather than to the whole checkout: the
  // diff pane's History shows every turn in the environment, this shows the ones this session took.
  const session = menu?.item.kind === "session" ? sessions[menu.item.refId] : undefined;
  // A session that has already run moves too: the server carries its checkout across, so the cwd its
  // transcript describes is unchanged. What the client can see of that — `lastEventSeq` — only decides
  // the WORDING, not whether the entry is offered.
  const hasRun = session !== undefined && session.lastEventSeq > 0;
  const destinations = spaces.filter((sp) => sp.id !== (session?.spaceId ?? activeSpaceId));
  // Whether this pane is on screen in the window's one view, and whether it is the focused one.
  const leafId = menu && layout ? findLeafOfItem(layout, menu.item.id)?.id ?? null : null;
  const holder = leafId !== null;
  const isFocused = !!leafId && zoomedLeafId === leafId;
  // On screen in a pane that is not the focused one: the only case where "here" is not what a plain
  // row click already does — an unopened row opens into the focused pane anyway.
  const elsewhere = holder && leafId !== focusedLeafId;
  const element = menu ? (
    <Menu at={{ x: menu.x, y: menu.y }}
      label={movingToSpace ? `Move ${menu.item.title} to…` : `Actions for ${menu.item.title}`}
      onClose={close} items={
      movingToSpace
        ? (destinations.length > 0
            ? destinations.map((sp) => ({ label: sp.name, onSelect: () => run(() => moveSessionToSpace(session!.id, sp.id)) }))
            : [{ label: "No other spaces", disabled: true, onSelect: () => {} }])
        : [
            { label: menu.item.pinned ? "Unpin" : "Pin", onSelect: () => run(() => updateItem({ id: menu.item.id, pinned: !menu.item.pinned })) },
            // Pin's opposite, and offered on the same terms the hover button is: sessions only
            // (ItemList explains why), whichever section the row was right-clicked in.
            ...(menu.item.kind === "session"
              ? [{ label: menu.item.archived ? "Unarchive" : "Archive",
                   title: menu.item.archived ? "Put it back in the space list" : "Close the pane and shelve the row; nothing is deleted",
                   onSelect: () => run(() => archiveItem(menu.item.id, !menu.item.archived)) }]
              : []),
            { label: "Rename", onSelect: () => onRename(menu.item) },
            // A plain row click goes TO the pane, which is right when you meant "take me there" and
            // wrong when you meant "put it in front of me". Naming the focused leaf is what turns
            // openItem's homing into a move.
            ...(elsewhere
              ? [{ label: "Open here", title: "Move this pane into the focused one",
                   onSelect: () => run(() => openItem(menu.item.id, focusedLeafId)) }]
              : []),
            // Not open anywhere in this space: a look at it beside the session in focus, without
            // opening it into the layout. Open, a row click already shows it.
            ...(menu.item.kind === "session" && !holder && !menu.item.archived && peekOwner
              ? [{ label: "Peek", title: "Look at it beside this session, without opening it",
                   onSelect: () => run(async () => { await peekSession(menu.item.refId, menu.item.spaceId); }) }]
              : []),
            // The focus gesture the pane bar also carries — offered here because the sidebar row is
            // where you are when you decide a pane deserves the whole space.
            ...(leafId
              ? [isFocused
                  ? { label: "Unfocus", kbd: "⌘⇧F", onSelect: () => run(() => unfocusPane()) }
                  : { label: "Focus", kbd: "⌘⇧F", title: "Fill the window with this pane; the split keeps it", onSelect: () => run(() => focusPaneFull(leafId)) }]
              : []),
            ...(session ? [{ label: "Checkpoints…", onSelect: () => run(() => openCheckpoints(session.environmentId, session.id)) }] : []),
            ...(session
              ? [{ label: "Move to space…", keepOpen: true,
                   title: hasRun ? "Takes its checkout along, so the transcript still names the tree it ran in"
                                 : "Rewires it to the destination's checkout, like a session created there",
                   onSelect: () => setMovingToSpace(true) }]
              : []),
            { kind: "separator" as const },
            ...(holder
              ? [{ label: "Close", onSelect: () => run(() => closeFromLayout(menu.item.id)) }]
              : []),
            confirmingDelete
              ? { label: <strong>Really delete?</strong>, danger: true, onSelect: () => run(() => deleteItem(menu.item.id)) }
              : confirmDelete
                ? { label: "Delete", danger: true, keepOpen: true, onSelect: () => setConfirmingDelete(true) }
                : { label: "Delete", danger: true, onSelect: () => run(() => deleteItem(menu.item.id)) },
          ]
    } />
  ) : null;
  return { onContextMenu, element };
}

