import { useCallback, useState, type MouseEvent } from "react";
import { activeGroup, findLeafOfItem, groupOfItem, type Item } from "@realm/contracts";
import { useApp } from "../../state/store";
import { Menu } from "../Menu";

export type ItemMenuState = { item: Item; x: number; y: number } | null;

/** Right-click menu shared by pinned tiles and list rows: Pin/Unpin, Archive/Unarchive (sessions only),
 *  Rename (inline, via `onRename`), Open here (move the pane into the focused one, offered only while
 *  it is open somewhere else),
 *  Focus/Unfocus (fill the space with this pane, offered only while it is open), Move to group… (when
 *  the space has more than one), Move to space… (sessions only), Close
 *  (layout-only, offered only while the item is open), Delete (destructive, always offered). */
export function useItemContextMenu(onRename: (item: Item) => void) {
  const [menu, setMenu] = useState<ItemMenuState>(null);
  // Two-step destructive confirm (U-H2): the first Delete click arms this in place; only the second
  // click, within the same open menu, deletes. Opening or closing the menu disarms.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // "Move to space…" swaps the menu's own item list in place, the same trick — no submenu primitive
  // exists on `Menu`, so a second render of the SAME menu is the picker.
  const [movingToSpace, setMovingToSpace] = useState(false);
  // Same in-place trick as "Move to space…": a second render of the SAME menu is the group picker.
  const [movingToGroup, setMovingToGroup] = useState(false);
  const updateItem = useApp((s) => s.updateItem);
  const closeFromLayout = useApp((s) => s.closeFromLayout);
  const archiveItem = useApp((s) => s.archiveItem);
  const deleteItem = useApp((s) => s.deleteItem);
  const moveSessionToSpace = useApp((s) => s.moveSessionToSpace);
  const groups = useApp((s) => s.groups);
  const moveItemToPaneGroup = useApp((s) => s.moveItemToPaneGroup);
  const focusPaneFull = useApp((s) => s.focusPaneFull);
  const unfocusPane = useApp((s) => s.unfocusPane);
  const sessions = useApp((s) => s.sessions);
  const spaces = useApp((s) => s.spaces);
  const activeSpaceId = useApp((s) => s.activeSpaceId);
  const openCheckpoints = useApp((s) => s.openCheckpoints);
  const openItem = useApp((s) => s.openItem);
  const focusedLeafId = useApp((s) => s.focusedLeafId);
  const run = useApp((s) => s.run);
  const onContextMenu = useCallback((item: Item) => (e: MouseEvent) => {
    e.preventDefault(); setConfirmingDelete(false); setMovingToSpace(false); setMovingToGroup(false);
    setMenu({ item, x: e.clientX, y: e.clientY });
  }, []);
  const close = useCallback(() => { setMenu(null); setConfirmingDelete(false); setMovingToSpace(false); setMovingToGroup(false); }, []);
  // A session's own checkpoints (W4), scoped to the session rather than to the whole checkout: the
  // diff pane's History shows every turn in the environment, this shows the ones this session took.
  const session = menu?.item.kind === "session" ? sessions[menu.item.refId] : undefined;
  // A session that has already run moves too: the server carries its checkout across, so the cwd its
  // transcript describes is unchanged. What the client can see of that — `lastEventSeq` — only decides
  // the WORDING, not whether the entry is offered.
  const hasRun = session !== undefined && session.lastEventSeq > 0;
  const destinations = spaces.filter((sp) => sp.id !== (session?.spaceId ?? activeSpaceId));
  // Which group holds this pane, and — if it is the one on screen — whether it is the focused pane.
  // Focus is an ACTIVE-group state: focusing a pane in a group you are not looking at would silently
  // change what that group shows the next time you switch to it, so it is offered only where it acts.
  const holder = groups ? groupOfItem(groups, menu?.item.id ?? "") : null;
  const inActiveGroup = !!holder && !!groups && holder.id === groups.activeGroupId;
  const leafId = holder && menu ? findLeafOfItem(holder.layout, menu.item.id)?.id ?? null : null;
  const isFocused = inActiveGroup && !!leafId && activeGroup(groups!).zoomedLeafId === leafId;
  // Open in a pane that is not the one on screen: the only case where "here" is not what a plain row
  // click already does — an unopened row opens into the focused leaf anyway.
  const elsewhere = !!holder && (!inActiveGroup || leafId !== focusedLeafId);
  const otherGroups = groups?.groups.filter((g) => g.id !== holder?.id) ?? [];
  const element = menu ? (
    <Menu at={{ x: menu.x, y: menu.y }}
      label={movingToSpace ? `Move ${menu.item.title} to…` : movingToGroup ? `Move ${menu.item.title} to group…` : `Actions for ${menu.item.title}`}
      onClose={close} items={
      movingToSpace
        ? (destinations.length > 0
            ? destinations.map((sp) => ({ label: sp.name, onSelect: () => run(() => moveSessionToSpace(session!.id, sp.id)) }))
            : [{ label: "No other spaces", disabled: true, onSelect: () => {} }])
        : movingToGroup
        ? (otherGroups.length > 0
            ? otherGroups.map((g) => ({ label: g.name, onSelect: () => run(() => moveItemToPaneGroup(menu.item.id, g.id)) }))
            : [{ label: "No other groups", disabled: true, onSelect: () => {} }])
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
            // openItem's homing into a move, and it moves across pane groups too — the drag this
            // replaces could only ever reach the arrangement already on screen.
            ...(elsewhere
              ? [{ label: "Open here", title: "Move this pane into the focused one",
                   onSelect: () => run(() => openItem(menu.item.id, focusedLeafId)) }]
              : []),
            // The focus gesture the pane bar also carries — offered here because the sidebar row is
            // where you are when you decide a pane deserves the whole space.
            ...(inActiveGroup && leafId
              ? [isFocused
                  ? { label: "Unfocus", kbd: "⌘⇧F", onSelect: () => run(() => unfocusPane()) }
                  : { label: "Focus", kbd: "⌘⇧F", title: "Fill the space with this pane; the group keeps it", onSelect: () => run(() => focusPaneFull(leafId)) }]
              : []),
            ...(otherGroups.length > 0
              ? [{ label: "Move to group…", keepOpen: true, onSelect: () => setMovingToGroup(true) }]
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
              : { label: "Delete", danger: true, keepOpen: true, onSelect: () => setConfirmingDelete(true) },
          ]
    } />
  ) : null;
  return { onContextMenu, element };
}

