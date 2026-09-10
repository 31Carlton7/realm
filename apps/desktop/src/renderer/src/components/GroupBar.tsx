import { Icon } from "@realm/ui";
import { useState, type DragEvent as ReactDragEvent } from "react";
import { type PaneGroup } from "@realm/contracts";
import { useApp } from "../state/store";
import { Menu } from "./Menu";
import { GroupRenameInput } from "./RenameInput";

const REALM_ITEM_TYPE = "application/x-realm-item";
/** A tab dragged along the strip, as against a sidebar row dragged ONTO one. Two types rather than
 *  one flag: the handlers for the two gestures share the same elements, and a drop that guessed
 *  which was in flight from anything but the payload would eventually guess wrong. */
const REALM_GROUP_TYPE = "application/x-realm-group";

/**
 * The one strip above the pane host: a tab per pane group.
 *
 * It is deliberately conditional. The app has no topbar by design (spec amendment §A1), and a space
 * with one group is exactly the app as it was, so the bar does not render at all. It appears only
 * once there is something it alone can say: which of several arrangements is on screen. Creating and
 * managing groups lives in the sidebar, where the rest of a space's structure already lives; this
 * strip is for switching.
 *
 * It used to also carry a "Focused: <title> | Unfocus" card, and so appeared for a single group with
 * a pane focused. That state now reads off the pane bar's own focus toggle, which is lit while the
 * pane fills the host — one bit on the control that changes it, instead of a strip across the window
 * to report it.
 */
export function GroupBar() {
  const groups = useApp((s) => s.groups);
  const renamingGroupId = useApp((s) => s.renamingGroupId);
  const requestGroupRename = useApp((s) => s.requestGroupRename);
  const activatePaneGroup = useApp((s) => s.activatePaneGroup);
  const newPaneGroup = useApp((s) => s.newPaneGroup);
  const moveItemToPaneGroup = useApp((s) => s.moveItemToPaneGroup);
  const run = useApp((s) => s.run);
  const movePaneGroup = useApp((s) => s.movePaneGroup);
  const [menu, setMenu] = useState<{ group: PaneGroup; x: number; y: number } | null>(null);
  const [dropGroupId, setDropGroupId] = useState<string | null>(null);
  /** The tab being dragged, and the gap the pointer is currently proposing. `insert` is an index in
   *  the CURRENT array (0…n), not a destination — see `dropAt`. */
  const [drag, setDrag] = useState<{ id: string; insert: number } | null>(null);

  // Nothing this strip could say that the panes themselves do not already say.
  if (!groups || groups.groups.length < 2) return null;

  const order = groups.groups;
  /**
   * Where a drop lands, as the index the dragged tab ends AT.
   *
   * The gap the pointer is over is an index in the array as it stands NOW; the tab has not moved yet.
   * Removing it first shifts every slot after it down one, so a gap past the tab's own position means
   * one less than it looks. Getting this wrong is the classic reorder bug where dragging right always
   * lands one short.
   */
  const dropAt = (insert: number, from: number) => (insert > from ? insert - 1 : insert);

  const commitDrop = (insert: number, id: string) => {
    const from = order.findIndex((g) => g.id === id);
    setDrag(null);
    if (from === -1) return;
    run(() => movePaneGroup(id, dropAt(insert, from)));
  };

  /** ⌥←/⌥→ on a focused tab. The pointer gesture is not the only way to say this: the tabs are a
   *  toolbar of buttons a keyboard reaches in order, and a reorder that only a mouse can perform is
   *  a reorder half the users cannot. */
  const nudge = (id: string, delta: number) => {
    const from = order.findIndex((g) => g.id === id);
    if (from === -1) return;
    run(() => movePaneGroup(id, from + delta));
  };

  return (
    <div className="group-bar" role="toolbar" aria-label="Pane groups">
      <div className="group-tabs" role="tablist" aria-label="Pane groups" data-reordering={drag ? "" : undefined}>
        {order.map((g, i) => (g.id === renamingGroupId ? (
          <span key={g.id} className="group-tab group-tab-renaming">
            <GroupRenameInput group={g} onDone={() => requestGroupRename(null)} />
          </span>
        ) : (
          <button key={g.id} role="tab" className="group-tab"
            draggable
            aria-selected={g.id === groups.activeGroupId}
            data-active={g.id === groups.activeGroupId || undefined}
            data-drop={dropGroupId === g.id || undefined}
            data-dragging={drag?.id === g.id || undefined}
            // The gap this tab is proposing, drawn on the tab beside it rather than as a floating
            // element: the strip scrolls, and a marker positioned against the bar would drift off
            // the gap it names the moment the tabs move under it.
            data-insert={drag && drag.id !== g.id
              ? (drag.insert === i ? "before" : drag.insert === i + 1 ? "after" : undefined)
              : undefined}
            onDragStart={(e: ReactDragEvent) => {
              e.dataTransfer.setData(REALM_GROUP_TYPE, g.id);
              e.dataTransfer.effectAllowed = "move";
              setDrag({ id: g.id, insert: i });
            }}
            onDragEnd={() => setDrag(null)}
            onKeyDown={(e) => {
              if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
              e.preventDefault();
              nudge(g.id, e.key === "ArrowRight" ? 1 : -1);
            }}
            // A sidebar row dragged onto a tab moves that pane into the group — the cheapest way to
            // say "this belongs over there" without first switching to the group to drop it.
            onDragOver={(e: ReactDragEvent) => {
              const types = Array.from(e.dataTransfer.types);
              // A tab being dragged along the strip: the half of THIS tab the pointer is over says
              // which side of it the gap is, which is the only thing that distinguishes "before the
              // one I am hovering" from "after it".
              if (types.includes(REALM_GROUP_TYPE) && drag) {
                e.preventDefault(); e.dataTransfer.dropEffect = "move";
                const box = e.currentTarget.getBoundingClientRect();
                const insert = e.clientX < box.left + box.width / 2 ? i : i + 1;
                setDrag((d) => (d && d.insert !== insert ? { ...d, insert } : d));
                return;
              }
              if (!types.includes(REALM_ITEM_TYPE)) return;
              e.preventDefault(); setDropGroupId(g.id);
            }}
            onDragLeave={() => setDropGroupId((cur) => (cur === g.id ? null : cur))}
            onDrop={(e: ReactDragEvent) => {
              e.preventDefault(); setDropGroupId(null);
              // Which gesture this is comes off the TYPES, the same way `onDragOver` decides it —
              // never off whether `getData` answered. The two must agree, and a payload read for a
              // type the drag does not carry is not a reliable way to ask.
              const types = Array.from(e.dataTransfer.types);
              if (types.includes(REALM_GROUP_TYPE)) {
                const moved = e.dataTransfer.getData(REALM_GROUP_TYPE);
                if (moved) commitDrop(drag?.insert ?? i, moved);
                return;
              }
              const id = e.dataTransfer.getData(REALM_ITEM_TYPE);
              if (id) run(() => moveItemToPaneGroup(id, g.id));
            }}
            onContextMenu={(e) => { e.preventDefault(); setMenu({ group: g, x: e.clientX, y: e.clientY }); }}
            onClick={() => run(() => activatePaneGroup(g.id))}>
            <Icon name="group" size={14} />
            <span className="group-tab-name">{g.name}</span>
          </button>
        )))}
        {/* The run past the last tab is a drop target too, so "put it at the end" does not require
            landing on the right half of a 60px tab. */}
        <span className="group-tab-end" aria-hidden="true"
          data-insert={drag && drag.insert === order.length ? "before" : undefined}
          onDragOver={(e: ReactDragEvent) => {
            if (!Array.from(e.dataTransfer.types).includes(REALM_GROUP_TYPE) || !drag) return;
            e.preventDefault(); e.dataTransfer.dropEffect = "move";
            setDrag((d) => (d && d.insert !== order.length ? { ...d, insert: order.length } : d));
          }}
          onDrop={(e: ReactDragEvent) => {
            if (!Array.from(e.dataTransfer.types).includes(REALM_GROUP_TYPE)) return;
            e.preventDefault();
            const moved = e.dataTransfer.getData(REALM_GROUP_TYPE);
            if (moved) commitDrop(order.length, moved);
          }} />
        <button className="icon-btn group-add" aria-label="New pane group" title="New pane group"
          onClick={() => run(() => newPaneGroup())}><Icon name="add" size={14} /></button>
      </div>
      {menu && <GroupMenu group={menu.group} at={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** Right-click a tab: rename in place, or remove the group.
 *
 *  Rename turns THIS tab into the field. It used to arm an editor in the sidebar as well, and the
 *  two autoFocus inputs took the focus off each other — see `GroupSection` in SpaceSwiper.tsx, where
 *  the twin was removed. One gesture, one editor, where the gesture happened. */
function GroupMenu({ group, at, onClose }: { group: PaneGroup; at: { x: number; y: number }; onClose: () => void }) {
  const groups = useApp((s) => s.groups);
  const removePaneGroup = useApp((s) => s.removePaneGroup);
  const requestGroupRename = useApp((s) => s.requestGroupRename);
  const run = useApp((s) => s.run);
  const [confirming, setConfirming] = useState(false);
  const last = (groups?.groups.length ?? 0) < 2;
  return (
    <Menu at={at} label={`Actions for ${group.name}`} onClose={onClose} items={[
      { label: "Rename group", onSelect: () => requestGroupRename(group.id) },
      { kind: "separator" },
      confirming
        // Two-step (U-H2) even though nothing is deleted: the panes come back in the SPACE list, but
        // an arrangement someone built is still work, and it is not restorable.
        ? { label: <strong>Remove group?</strong>, danger: true, onSelect: () => run(() => removePaneGroup(group.id)) }
        : { label: "Remove group", danger: true, keepOpen: true, disabled: last,
            title: last ? "A space keeps at least one group" : "Its panes return to the space list",
            onSelect: () => setConfirming(true) },
    ]} />
  );
}
