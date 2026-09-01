import { Icon } from "@realm/ui";
import { useState, type DragEvent as ReactDragEvent } from "react";
import { activeGroup, itemIdOfLeaf, type PaneGroup } from "@realm/contracts";
import { useApp } from "../state/store";
import { Menu } from "./Menu";
import { GroupRenameInput } from "./RenameInput";

const REALM_ITEM_TYPE = "application/x-realm-item";

/**
 * The one strip above the pane host: a tab per pane group, and — while a pane is focused — the way
 * back out of that focus.
 *
 * It is deliberately conditional. The app has no topbar by design (spec amendment §A1), and a space
 * with one group showing its full split is exactly the app as it was, so the bar does not render at
 * all. It appears only once there is something it alone can say: which of several arrangements is on
 * screen, or that one pane is currently filling it. Creating and managing groups lives in the
 * sidebar, where the rest of a space's structure already lives; this strip is for switching.
 */
export function GroupBar() {
  const groups = useApp((s) => s.groups);
  const items = useApp((s) => s.items);
  const renamingGroupId = useApp((s) => s.renamingGroupId);
  const requestGroupRename = useApp((s) => s.requestGroupRename);
  const activatePaneGroup = useApp((s) => s.activatePaneGroup);
  const newPaneGroup = useApp((s) => s.newPaneGroup);
  const unfocusPane = useApp((s) => s.unfocusPane);
  const moveItemToPaneGroup = useApp((s) => s.moveItemToPaneGroup);
  const run = useApp((s) => s.run);
  const [menu, setMenu] = useState<{ group: PaneGroup; x: number; y: number } | null>(null);
  const [dropGroupId, setDropGroupId] = useState<string | null>(null);

  if (!groups) return null;
  const active = activeGroup(groups);
  const zoomed = active.zoomedLeafId;
  const zoomedItemId = zoomed ? itemIdOfLeaf(active.layout, zoomed) : null;
  const zoomedTitle = items.find((i) => i.id === zoomedItemId)?.title ?? null;
  // Nothing this strip could say that the panes themselves do not already say.
  if (groups.groups.length < 2 && !zoomed) return null;

  return (
    <div className="group-bar" role="toolbar" aria-label="Pane groups">
      {groups.groups.length > 1 && (
        <div className="group-tabs" role="tablist" aria-label="Pane groups">
          {groups.groups.map((g) => (g.id === renamingGroupId ? (
            <span key={g.id} className="group-tab group-tab-renaming">
              <GroupRenameInput group={g} onDone={() => requestGroupRename(null)} />
            </span>
          ) : (
            <button key={g.id} role="tab" className="group-tab"
              aria-selected={g.id === groups.activeGroupId}
              data-active={g.id === groups.activeGroupId || undefined}
              data-drop={dropGroupId === g.id || undefined}
              // A sidebar row dragged onto a tab moves that pane into the group — the cheapest way to
              // say "this belongs over there" without first switching to the group to drop it.
              onDragOver={(e: ReactDragEvent) => {
                if (!Array.from(e.dataTransfer.types).includes(REALM_ITEM_TYPE)) return;
                e.preventDefault(); setDropGroupId(g.id);
              }}
              onDragLeave={() => setDropGroupId((cur) => (cur === g.id ? null : cur))}
              onDrop={(e: ReactDragEvent) => {
                e.preventDefault(); setDropGroupId(null);
                const id = e.dataTransfer.getData(REALM_ITEM_TYPE);
                if (id) run(() => moveItemToPaneGroup(id, g.id));
              }}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ group: g, x: e.clientX, y: e.clientY }); }}
              onClick={() => run(() => activatePaneGroup(g.id))}>
              <Icon name="group" size={13} />
              <span className="group-tab-name">{g.name}</span>
            </button>
          )))}
          <button className="icon-btn group-add" aria-label="New pane group" title="New pane group"
            onClick={() => run(() => newPaneGroup())}><Icon name="add" size={13} /></button>
        </div>
      )}
      {zoomed && (
        // The "button in the top" that ends a focus. It names the pane it will release rather than
        // saying only "Unfocus", because the whole point of the state is that the other panes are out
        // of sight — the bar has to carry what the screen no longer shows.
        <button className="group-unfocus" onClick={() => run(() => unfocusPane())}
          aria-label={zoomedTitle ? `Unfocus ${zoomedTitle}` : "Unfocus pane"} title="Unfocus (⌘⇧F)">
          <Icon name="unfocusPane" size={13} />
          <span>Focused{zoomedTitle ? `: ${zoomedTitle}` : ""}</span>
          <span className="group-unfocus-hint">Unfocus</span>
        </button>
      )}
      {menu && <GroupMenu group={menu.group} at={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** Right-click a tab: rename in place (a prompt-free inline field would need a whole popover; the
 *  menu's Rename arms the sidebar's own inline editor instead), or remove the group. */
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
