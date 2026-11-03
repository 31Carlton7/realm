import { Icon, TeammateIcon } from "@realm/ui";
import { useState, type CSSProperties, type DragEvent, type MouseEvent, type ReactNode } from "react";
import { itemIdOfLeaf, type Teammate, type TeammateTaskSession } from "@realm/contracts";
import { useApp } from "../../state/store";
import { groupKey } from "../../state/teammates-slice";
import { groupTeammates, recentSessions, sessionTree, teammateMark } from "../../panes/teammate/teammate-model";
import { useTeammateMenu } from "../../panes/teammate/TeammateHead";
import { Menu } from "../Menu";

const TEAMMATE_DRAG_TYPE = "application/x-realm-teammate";

/**
 * A space's teammates, at the top of its section: the Lead first, then the rest in the person's
 * order, then each group the person made, folding like a folder. Each row is the teammate's icon on
 * the gutter under the space's, its name on the titles' column, and its state at the far end — the
 * session rows' dot, said in words in the row's name, so it reads without colour. A row with sessions
 * unfolds to the live ones and the newest few, with what was handed on from each nested under it.
 *
 * Nothing here is drawn for a space with no teammates; the space's menu offers the first one.
 */
export function TeamSection({ spaceId }: { spaceId: string }) {
  const list = useApp((s) => s.teammates[spaceId]);
  const folded = useApp((s) => s.sidebarFoldedLists.includes(`${spaceId}/team`));
  const openSheet = useApp((s) => s.openSheet);
  const reorderTeammates = useApp((s) => s.reorderTeammates);
  const run = useApp((s) => s.run);
  const [dragging, setDragging] = useState<string | null>(null);
  if (!list || list.length === 0) return null;
  const { top, groups } = groupTeammates(list);
  /* Dropped on a row: it goes before that row, into that row's group. Dropped on a group's head: to
     the end of the group. The Lead keeps the top; the server holds it there whatever the order says. */
  const drop = (target: { before: string } | { group: string }) => {
    const moved = list.find((t) => t.id === dragging);
    setDragging(null);
    if (!moved) return;
    const rest = list.filter((t) => t.id !== moved.id);
    const group = "group" in target ? target.group : rest.find((t) => t.id === target.before)?.group ?? null;
    const at = "before" in target ? rest.findIndex((t) => t.id === target.before)
      : rest.reduce((last, t, i) => (t.group === group ? i + 1 : last), rest.length);
    const order = [...rest.slice(0, at), { ...moved, group }, ...rest.slice(at)].map((t) => ({ id: t.id, group: t.group }));
    run(() => reorderTeammates({ spaceId, order }));
  };
  const drag = { dragging, start: setDragging, drop };
  return (
    <div className="sb-team" role="group" aria-label="Team">
      <ListCaption spaceId={spaceId} list="team" label="Team" folded={folded}>
        <span className="item-actions">
          <button type="button" className="item-act" aria-label="Add a teammate" title="Add a teammate"
            onClick={() => openSheet({ kind: "teammate", spaceId })}><Icon name="add" size={12} /></button>
        </span>
      </ListCaption>
      {!folded && top.map((t) => <TeammateRow key={t.id} teammate={t} drag={drag} />)}
      {!folded && groups.map(([name, members]) => <TeamGroup key={name} spaceId={spaceId} name={name} members={members} drag={drag} />)}
    </div>
  );
}

/** A caption over one of a space's lists, Team or Sessions, that folds the list away and remembers it. */
export function ListCaption({ spaceId, list, label, folded, children }:
  { spaceId: string; list: "team" | "sessions"; label: string; folded: boolean; children?: ReactNode }) {
  const setSpaceListFolded = useApp((s) => s.setSpaceListFolded);
  const run = useApp((s) => s.run);
  return (
    <div className="item sb-row sb-caption-row" data-nested="" data-actions={children ? "1" : "0"}>
      <button type="button" className="item-row sb-caption" aria-expanded={!folded}
        onClick={() => run(() => setSpaceListFolded(spaceId, list, !folded))}>
        <span className="sb-caret" data-open={!folded || undefined}><Icon name="chevronRight" size={12} /></span>
        {label}
      </button>
      {children}
    </div>
  );
}

type Drag = { dragging: string | null; start: (id: string | null) => void; drop: (target: { before: string } | { group: string }) => void };

function TeamGroup({ spaceId, name, members, drag }: { spaceId: string; name: string; members: Teammate[]; drag: Drag }) {
  const folded = useApp((s) => s.teamGroupsFolded.includes(groupKey(spaceId, name)));
  const setTeamGroupFolded = useApp((s) => s.setTeamGroupFolded);
  const run = useApp((s) => s.run);
  const [over, setOver] = useState(false);
  const waiting = members.filter((t) => t.state === "needs-you").length;
  return (
    <>
      <div className="item sb-row sb-team-group" data-nested="" data-actions="0" data-drag-over={over || undefined}
        onDragOver={(e) => { if (drag.dragging) { e.preventDefault(); setOver(true); } }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); drag.drop({ group: name }); }}>
        <button type="button" className="item-row" aria-expanded={!folded}
          aria-label={`${name}, ${members.length} teammate${members.length === 1 ? "" : "s"}${waiting ? `, ${waiting} need${waiting === 1 ? "s" : ""} you` : ""}`}
          onClick={() => run(() => setTeamGroupFolded(spaceId, name, !folded))}>
          <span className="sb-gutter"><span className="sb-caret" data-open={!folded || undefined}><Icon name="chevronRight" size={12} /></span></span>
          <span className="item-title">{name}</span>
          {folded && waiting > 0 && <span className="item-trail"><span className="status-dot item-status" data-status="waiting_permission" /></span>}
        </button>
      </div>
      {!folded && <div className="sb-team-members">{members.map((t) => <TeammateRow key={t.id} teammate={t} drag={drag} />)}</div>}
    </>
  );
}

function TeammateRow({ teammate: t, drag }: { teammate: Teammate; drag: Drag }) {
  const openTeammate = useApp((s) => s.openTeammate);
  const focused = useApp((s) => {
    if (!s.layout || !t.homeSessionId) return false;
    const itemId = itemIdOfLeaf(s.layout, s.focusedLeafId);
    return !!itemId && s.items.some((i) => i.id === itemId && i.kind === "session" && i.refId === t.homeSessionId);
  });
  const run = useApp((s) => s.run);
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState(false);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const menu = useTeammateMenu(t);
  const mark = teammateMark(t.state, t.unread);
  const said = `${t.name}${t.lead ? ", the Lead" : ""}${mark ? ` — ${mark.label}` : ""}${t.liveTask ? `, on ${t.liveTask}` : ""}`;
  const shown = recentSessions(t.taskSessions);
  const onContextMenu = (e: MouseEvent) => { e.preventDefault(); setMenuAt({ x: e.clientX, y: e.clientY }); };
  return (
    <>
      <div className="item sb-row sb-teammate" data-nested="" data-active={focused || undefined} data-unread={mark?.mark === "unseen" || undefined}
        data-actions="0" data-dragging={drag.dragging === t.id || undefined} data-drag-over={over || undefined} draggable
        onDragStart={(e: DragEvent) => { e.dataTransfer.setData(TEAMMATE_DRAG_TYPE, t.id); e.dataTransfer.effectAllowed = "move"; drag.start(t.id); }}
        onDragEnd={() => drag.start(null)}
        onDragOver={(e) => { if (drag.dragging && drag.dragging !== t.id) { e.preventDefault(); setOver(true); } }}
        onDragLeave={() => setOver(false)} onDrop={(e) => { e.preventDefault(); setOver(false); drag.drop({ before: t.id }); }}
        onContextMenu={onContextMenu}>
        {shown.length > 0 && (
          <button type="button" className="sb-team-caret sb-caret" data-open={open || undefined} aria-expanded={open}
            aria-label={`${open ? "Hide" : "Show"} ${t.name}'s sessions`} title={open ? "Hide its sessions" : "Show its sessions"}
            onClick={() => setOpen((v) => !v)}><Icon name="chevronRight" size={12} /></button>
        )}
        <button type="button" className="item-row" aria-label={said} title={t.liveTask ?? undefined} onClick={() => run(() => openTeammate(t.id))}>
          <span className="sb-gutter"><TeammateIcon icon={t.icon} size={16} lead={t.lead} /></span>
          <span className="item-title">{t.name}</span>
          <span className="item-trail">{mark && <span className="status-dot item-status" data-status={mark.mark} />}</span>
        </button>
        {menuAt && <Menu at={menuAt} label={t.name} onClose={() => setMenuAt(null)} items={menu} />}
      </div>
      {open && shown.length > 0 && (
        <div className="item-list sb-team-sessions">
          {sessionTree(shown).map(({ session, depth }) => <TaskRow key={session.id} session={session} depth={depth} spaceId={t.spaceId} />)}
        </div>
      )}
    </>
  );
}

function TaskRow({ session: s, depth, spaceId }: { session: TeammateTaskSession; depth: number; spaceId: string }) {
  const revealSession = useApp((st) => st.revealSession);
  const focused = useApp((st) => {
    if (!st.layout) return false;
    const itemId = itemIdOfLeaf(st.layout, st.focusedLeafId);
    return !!itemId && st.items.some((i) => i.id === itemId && i.refId === s.id);
  });
  const run = useApp((st) => st.run);
  const mark = teammateMark(s.state, s.unread);
  return (
    <div className="item sb-row" data-nested="" data-active={focused || undefined} data-unread={mark?.mark === "unseen" || undefined} data-actions="0"
      style={{ "--sb-depth": depth } as CSSProperties}>
      <button type="button" className="item-row" aria-label={`${s.title}${mark ? ` — ${mark.label}` : ""}`} title={s.title}
        onClick={() => run(async () => { await revealSession(s.id, spaceId); })}>
        <span className="sb-gutter">{depth > 0 && <span aria-hidden="true">↳</span>}</span>
        <span className="item-title">{s.title}</span>
        <span className="item-trail">{mark && <span className="status-dot item-status" data-status={mark.mark} />}</span>
      </button>
    </div>
  );
}
