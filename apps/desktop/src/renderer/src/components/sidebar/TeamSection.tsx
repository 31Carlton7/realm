import { Icon, TeammateIcon } from "@realm/ui";
import { useState, type DragEvent, type MouseEvent } from "react";
import { itemIdOfLeaf, type Teammate } from "@realm/contracts";
import { rowSignal } from "../../state/attention";
import { useApp } from "../../state/store";
import { groupKey } from "../../state/teammates-slice";
import { groupTeammates } from "../../panes/teammate/teammate-model";
import { useTeammateMenu } from "../../panes/teammate/TeammateHead";
import { Menu, type MenuItem } from "../Menu";
import { SignalTrail } from "./SessionRows";
import { useNow } from "./use-sidebar-model";

const TEAMMATE_DRAG_TYPE = "application/x-realm-teammate";

/**
 * The space's team, as one flat list under the pinned row (direction A): the Lead first, then the
 * rest in the person's order, then each group the person made — the one nesting the column has. No
 * caption over it and no disclosure on a row: a teammate's sessions are on its page, so a row is the
 * teammate's icon, its name, and at the far end its state or how long ago it last moved.
 *
 * A pinned teammate is in the pinned row instead, never in both. Nothing is drawn for a space with no
 * teammates; the title's "···" offers the first one.
 */
export function TeamSection({ spaceId, pinned }: { spaceId: string; pinned: ReadonlySet<string> }) {
  const all = useApp((s) => s.teammates[spaceId]);
  const reorderTeammates = useApp((s) => s.reorderTeammates);
  const run = useApp((s) => s.run);
  const [dragging, setDragging] = useState<string | null>(null);
  if (!all || all.length === 0) return null;
  const list = all.filter((t) => !pinned.has(t.id));
  if (list.length === 0) return null;
  const { top, groups } = groupTeammates(list);
  /* Dropped on a row: it goes before that row, into that row's group. Dropped on a group's head: to
     the end of the group. The Lead keeps the top; the server holds it there whatever the order says.
     The order written is the whole team's, pinned ones where they were. */
  const drop = (target: { before: string } | { group: string }) => {
    const moved = all.find((t) => t.id === dragging);
    setDragging(null);
    if (!moved) return;
    const rest = all.filter((t) => t.id !== moved.id);
    const group = "group" in target ? target.group : rest.find((t) => t.id === target.before)?.group ?? null;
    const at = "before" in target ? rest.findIndex((t) => t.id === target.before)
      : rest.reduce((last, t, i) => (t.group === group ? i + 1 : last), rest.length);
    const order = [...rest.slice(0, at), { ...moved, group }, ...rest.slice(at)].map((t) => ({ id: t.id, group: t.group }));
    run(() => reorderTeammates({ spaceId, order }));
  };
  const drag = { dragging, start: setDragging, drop };
  return (
    <div className="sb-team" role="group" aria-label="Team">
      {top.map((t) => <TeammateRow key={t.id} teammate={t} drag={drag} />)}
      {groups.map(([name, members]) => <TeamGroup key={name} spaceId={spaceId} name={name} members={members} drag={drag} />)}
    </div>
  );
}

type Drag = { dragging: string | null; start: (id: string | null) => void; drop: (target: { before: string } | { group: string }) => void };

/**
 * A group the person made, as a caption over its teammates. A click folds it, and a folded group with
 * someone waiting keeps the amber dot. A right-click renames it: every teammate in it moves to the new
 * name in one write, which is all a group is.
 */
function TeamGroup({ spaceId, name, members, drag }: { spaceId: string; name: string; members: Teammate[]; drag: Drag }) {
  const folded = useApp((s) => s.teamGroupsFolded.includes(groupKey(spaceId, name)));
  const setTeamGroupFolded = useApp((s) => s.setTeamGroupFolded);
  const all = useApp((s) => s.teammates[spaceId]);
  const reorderTeammates = useApp((s) => s.reorderTeammates);
  const run = useApp((s) => s.run);
  const [over, setOver] = useState(false);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const waiting = members.filter((t) => t.state === "needs-you").length;
  const rename = (next: string) => {
    setRenaming(false);
    const to = next.trim();
    if (!to || to === name || !all) return;
    run(() => reorderTeammates({ spaceId, order: all.map((t) => ({ id: t.id, group: t.group === name ? to : t.group })) }));
  };
  const said = `${name}, ${members.length} teammate${members.length === 1 ? "" : "s"}${waiting ? `, ${waiting} need${waiting === 1 ? "s" : ""} you` : ""}`;
  return (
    <>
      <div className="item sb-row sb-team-group" data-actions="0" data-drag-over={over || undefined}
        onDragOver={(e) => { if (drag.dragging) { e.preventDefault(); setOver(true); } }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); drag.drop({ group: name }); }}
        onContextMenu={(e: MouseEvent) => { e.preventDefault(); setMenuAt({ x: e.clientX, y: e.clientY }); }}>
        {renaming
          ? <GroupNameInput name={name} onDone={rename} />
          : (
            <button type="button" className="item-row sb-caption" aria-expanded={!folded} aria-label={said} title={said}
              onClick={() => run(() => setTeamGroupFolded(spaceId, name, !folded))}>
              <span className="item-title">{name}</span>
              <span className="sb-caret" data-open={!folded || undefined}><Icon name="chevronRight" size={12} /></span>
              {folded && waiting > 0 && <span className="item-trail"><span className="status-dot item-status" data-status="waiting_permission" /></span>}
            </button>
          )}
        {menuAt && <Menu at={menuAt} label={name} onClose={() => setMenuAt(null)} items={[
          { label: "Rename group…", icon: <Icon name="edit" size={16} />, onSelect: () => setRenaming(true) },
          { label: folded ? "Show its teammates" : "Fold it", onSelect: () => run(() => setTeamGroupFolded(spaceId, name, !folded)) },
        ]} />}
      </div>
      {!folded && <div className="sb-team-members">{members.map((t) => <TeammateRow key={t.id} teammate={t} drag={drag} />)}</div>}
    </>
  );
}

function GroupNameInput({ name, onDone }: { name: string; onDone: (next: string) => void }) {
  const [value, setValue] = useState(name);
  return (
    <input className="rename" aria-label={`Rename the group ${name}`} autoFocus value={value} maxLength={60}
      onChange={(e) => setValue(e.target.value)} onBlur={() => onDone(value)}
      onKeyDown={(e) => { if (e.key === "Enter") onDone(value); if (e.key === "Escape") { e.preventDefault(); onDone(name); } }} />
  );
}

/** When a teammate last moved: its chat's last turn, or the newest of the sessions it started. */
export function teammateLastMoved(t: Teammate, activityAt: Readonly<Record<string, number>>): number | null {
  const home = t.homeSessionId ? activityAt[t.homeSessionId] ?? 0 : 0;
  const newest = Math.max(home, ...t.taskSessions.map((s) => s.updatedAt));
  return newest > 0 ? newest : null;
}

/** Pin or unpin a teammate: its chat's item, the one thing a pin is held on. Absent until it has one. */
export function usePinTeammate(t: Teammate): MenuItem | null {
  const chat = useApp((s) => (t.homeSessionId ? (s.allItems.find((i) => i.kind === "session" && i.refId === t.homeSessionId)
    ?? s.items.find((i) => i.kind === "session" && i.refId === t.homeSessionId)) : undefined));
  const updateItem = useApp((s) => s.updateItem);
  const refreshAllItems = useApp((s) => s.refreshAllItems);
  const run = useApp((s) => s.run);
  if (!chat) return null;
  return {
    label: chat.pinned ? "Unpin" : "Pin", icon: <Icon name={chat.pinned ? "unpin" : "pin"} size={16} />,
    onSelect: () => run(async () => { await updateItem({ id: chat.id, pinned: !chat.pinned }); await refreshAllItems(); }),
  };
}

function TeammateRow({ teammate: t, drag }: { teammate: Teammate; drag: Drag }) {
  const openTeammate = useApp((s) => s.openTeammate);
  const focused = useApp((s) => {
    if (!s.layout || !t.homeSessionId) return false;
    const itemId = itemIdOfLeaf(s.layout, s.focusedLeafId);
    return !!itemId && s.items.some((i) => i.id === itemId && i.kind === "session" && i.refId === t.homeSessionId);
  });
  const lastMoved = useApp((s) => teammateLastMoved(t, s.sessionActivityAt));
  const now = useNow();
  const run = useApp((s) => s.run);
  const [over, setOver] = useState(false);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const pin = usePinTeammate(t);
  const menu = useTeammateMenu(t);
  const signal = rowSignal(t.state, t.unread);
  const said = [`${t.name}${t.lead ? ", the Lead" : ""}`, signal.words, t.liveTask ? `on ${t.liveTask}` : ""].filter(Boolean).join(" — ");
  const onContextMenu = (e: MouseEvent) => { e.preventDefault(); setMenuAt({ x: e.clientX, y: e.clientY }); };
  return (
    <div className="item sb-row sb-teammate" data-active={focused || undefined} data-unread={signal.unread || undefined}
      data-actions="0" data-dragging={drag.dragging === t.id || undefined} data-drag-over={over || undefined} draggable
      onDragStart={(e: DragEvent) => { e.dataTransfer.setData(TEAMMATE_DRAG_TYPE, t.id); e.dataTransfer.effectAllowed = "move"; drag.start(t.id); }}
      onDragEnd={() => drag.start(null)}
      onDragOver={(e) => { if (drag.dragging && drag.dragging !== t.id) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)} onDrop={(e) => { e.preventDefault(); setOver(false); drag.drop({ before: t.id }); }}
      onContextMenu={onContextMenu}>
      <button type="button" className="item-row" aria-label={said} title={said} onClick={() => run(() => openTeammate(t.id))}>
        <span className="sb-gutter"><TeammateIcon icon={t.icon} size={16} lead={t.lead} /></span>
        <span className="item-title">{t.name}</span>
        <span className="item-trail"><SignalTrail signal={signal} at={lastMoved} now={now} /></span>
      </button>
      {menuAt && <Menu at={menuAt} label={t.name} onClose={() => setMenuAt(null)} items={pin ? [pin, { kind: "separator" }, ...menu] : menu} />}
    </div>
  );
}
