import { Icon } from "@realm/ui";
import { memo, useState } from "react";
import { AGENT_META, itemIdOfLeaf, type AgentKind, type Space } from "@realm/contracts";
import { useApp } from "../../state/store";
import { age } from "../../panes/code-review/code-review-model";
import { environmentLabel } from "../../panes/session/Composer";
import { stampTitle } from "../../panes/session/timestamps";
import { RenameInput } from "../RenameInput";
import { SpaceIcon } from "../SpaceIcon";
import { useItemContextMenu } from "./ItemContextMenu";
import { ItemGlyph } from "./ItemList";
import { sameRow, tallyWords, type FanOutRow, type ListRow, type SessionRow } from "./model";
import { SessionRowView, TallyMarks, sessionWords, useOpenSessionRow } from "./SessionRows";
import { useArchiveAnywhere, useSpaceTint } from "./use-sidebar-model";

/**
 * One row of the Activity view, whichever kind it is, as a card: where and when on its first line,
 * what on its second. `usual` is the agent most of the space's sessions run on, so a card names its
 * agent only where it is not that one.
 */
export const ActivityCardView = memo(function ActivityCardView({ row, space, usual, now, onChanged }: {
  row: ListRow; space: Space | undefined; usual: AgentKind | null; now: number; onChanged: () => void;
}) {
  return row.kind === "session"
    ? <ActivityCard row={row} space={space} usual={usual} now={now} onChanged={onChanged} />
    : <FanOutCard row={row} space={space} now={now} onChanged={onChanged} />;
}, (a, b) => a.space === b.space && a.usual === b.usual && a.now === b.now && a.onChanged === b.onChanged && sameRow(a.row, b.row));

/**
 * A session in the Activity view (the owner, 10-12: "how long ago the message was sent, … the icon of
 * the space as well in there"). Two lines, three when the third has something to say:
 *
 *   [space icon] Space name                 [pin][clock][agent] 5m
 *   Session title                                  [N ●][state][pane]
 *   [branch] worktree-name
 *
 * The first line answers where and when, quietly; the second is the title the person reads, with the
 * state at its far end where every sidebar row wears it, so the time above and the state below never
 * share a slot. The third is the worktree the session works in, and is absent for one in the space's
 * own folder — a line that always said "main" would be a line nobody read.
 *
 * Under the pointer the time steps aside for the card's one action (Archive) and the state stays: on
 * a card the action has a slot of its own to take, and what the session is doing is worth more than
 * when it last spoke. Click, ⌘-click, the menu, rename and dragging into the split are the row's.
 */
export function ActivityCard({ row, space, usual, now, onChanged }: {
  row: SessionRow; space: Space | undefined; usual: AgentKind | null; now: number; onChanged: () => void;
}) {
  const layout = useApp((s) => s.layout);
  const focused = useApp((s) => (s.layout ? itemIdOfLeaf(s.layout, s.focusedLeafId) === row.item.id : false));
  const env = useApp((s) => (row.session ? s.environments[row.session.environmentId] : undefined));
  const openItemBeside = useApp((s) => s.openItemBeside);
  const run = useApp((s) => s.run);
  const tint = useSpaceTint(space?.color);
  const archive = useArchiveAnywhere(onChanged);
  const open = useOpenSessionRow(row);
  const [renaming, setRenaming] = useState(false);
  const [dragging, setDragging] = useState(false);
  const { onContextMenu, element } = useItemContextMenu(() => setRenaming(true), { onChanged });
  const where = space?.name ?? "";
  const { mark, agents, said } = sessionWords(row, where);
  const kind = row.session?.agentKind;
  const agent = kind && usual && kind !== usual ? AGENT_META[kind] : null;
  const branch = env?.kind === "worktree" ? environmentLabel(env, where) : null;
  return (
    <div className="item sb-row sb-card" data-active={focused || undefined} data-unread={mark?.mark === "unseen" || undefined} data-actions="1"
      data-dragging={dragging || undefined} draggable
      onDragStart={(e) => { e.dataTransfer.setData("application/x-realm-item", row.item.id); e.dataTransfer.effectAllowed = "move"; setDragging(true); }}
      onDragEnd={() => setDragging(false)} onContextMenu={onContextMenu(row.item)}>
      {renaming ? <RenameInput item={row.item} onDone={() => { setRenaming(false); onChanged(); }} /> : (
        <>
          <button type="button" className="item-row" aria-label={said}
            onClick={(e) => run(() => (e.metaKey ? openItemBeside(row.item.id) : open()))}>
            <span className="sb-card-line sb-card-head">
              <CardSpace space={space} tint={tint} />
              <span className="sb-card-marks">
                {row.item.pinned && <span title="Pinned"><Icon name="pin" size={12} /></span>}
                {row.scheduled && <span title="Started by a schedule"><Icon name="clock" size={12} /></span>}
                {agent && <span title={agent.label}><Icon name={agent.icon} size={12} /></span>}
                <CardWhen at={row.at} now={now} />
              </span>
            </span>
            <span className="sb-card-line">
              <span className="item-title">{row.title}</span>
              <span className="item-trail">
                {row.agentsWaiting > 0 && (
                  <span className="item-tally" title={agents}><span className="item-count">{row.agentsWaiting}</span><span className="status-dot item-status" data-status="waiting_permission" /></span>
                )}
                {mark && <span className="status-dot item-status" data-status={mark.mark} title={mark.mark === "unseen" ? "New since you were here" : mark.label} />}
                {layout && <ItemGlyph layout={layout} itemId={row.item.id} />}
              </span>
            </span>
            {branch && (
              <span className="sb-card-line sb-card-foot" title={env?.path}>
                <Icon name="branch" size={12} /><span className="sb-card-text">{branch}</span>
              </span>
            )}
          </button>
          <span className="item-actions">
            <button type="button" className="item-shelf" aria-label={`Archive ${row.title}`} title="Archive" onClick={() => archive(row.item)}>
              <Icon name="archive" size={12} />
            </button>
          </span>
        </>
      )}
      {element}
    </div>
  );
}

/** A fan-out as a card: its space and when it last moved, then the batch's brief with its tally. It
 *  unfolds to its sessions as rows, as it does among the spaces. */
function FanOutCard({ row, space, now, onChanged }: { row: FanOutRow; space: Space | undefined; now: number; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const tint = useSpaceTint(space?.color);
  const name = `Fan-out: ${row.title}`;
  const said = [`${name} — ${row.sessions.length} sessions`, ...tallyWords(row.tally)].join(", ") + (space ? `, in ${space.name}` : "");
  return (
    <>
      <div className="item sb-row sb-card" data-actions="0">
        <button type="button" className="item-row" aria-expanded={open} aria-label={said} title={said} onClick={() => setOpen((v) => !v)}>
          <span className="sb-card-line sb-card-head">
            <CardSpace space={space} tint={tint} />
            <span className="sb-card-marks"><CardWhen at={row.at} now={now} /></span>
          </span>
          <span className="sb-card-line">
            <span className="sb-caret" data-open={open || undefined}><Icon name="chevronRight" size={12} /></span>
            <span className="item-title">{name}</span>
            <span className="item-trail"><TallyMarks tally={row.tally} /></span>
          </span>
        </button>
      </div>
      {open && (
        <div className="item-list sb-fanout-rows">
          {row.sessions.map((r) => <SessionRowView key={r.id} row={r} onChanged={onChanged} />)}
        </div>
      )}
    </>
  );
}

/** The space a card belongs to: its own icon — glyph, emoji or upload — in its colour, and its name. */
function CardSpace({ space, tint }: { space: Space | undefined; tint: string | undefined }) {
  return (
    <>
      <span className="sb-card-space" style={tint ? { color: tint } : undefined}><SpaceIcon icon={space?.icon || "folder"} size={12} /></span>
      <span className="sb-card-text">{space?.name ?? ""}</span>
    </>
  );
}

/** How long since the conversation last moved, in a few tabular characters — the full moment in the
 *  tooltip, for the reader who needs more than "3d". */
function CardWhen({ at, now }: { at: number; now: number }) {
  return <time className="sb-card-when" dateTime={new Date(at).toISOString()} title={stampTitle(at)}>{age(at, now)}</time>;
}
