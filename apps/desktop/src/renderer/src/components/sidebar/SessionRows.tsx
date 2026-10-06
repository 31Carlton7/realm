import { Icon } from "@realm/ui";
import { useState } from "react";
import { itemIdOfLeaf } from "@realm/contracts";
import { sessionMark } from "../../state/attention";
import { useApp } from "../../state/store";
import { RenameInput } from "../RenameInput";
import { useItemContextMenu } from "./ItemContextMenu";
import { ItemGlyph } from "./ItemList";
import { tallyWords, type FanOutRow, type ListRow, type SessionRow, type Tally } from "./model";
import { useArchiveAnywhere } from "./use-sidebar-model";

/**
 * A tally at a row's far end: how many are waiting on you and how many are working, each a count
 * with the mark the rows themselves wear — the dot keeps the far end, so a column of sections lines
 * its marks up with the session rows under them. Failures and unread are in the words (the row's
 * accessible name and tooltip); Needs you and the rows carry those marks.
 */
export function TallyMarks({ tally }: { tally: Tally }) {
  return (
    <>
      {tally.waiting > 0 && (
        <span className="item-tally"><span className="item-count">{tally.waiting}</span><span className="status-dot item-status" data-status="waiting_permission" /></span>
      )}
      {tally.running > 0 && (
        <span className="item-tally"><span className="item-count">{tally.running}</span><span className="status-dot item-status" data-status="running" /></span>
      )}
    </>
  );
}

/** One row of the list, whichever kind it is. `where` names its space (Recent); `nested` lays it out
 *  under a section's head, its title on the space's name. */
export function ListRowView({ row, where, nested = false, onChanged }: { row: ListRow; where?: string; nested?: boolean; onChanged: () => void }) {
  return row.kind === "session"
    ? <SessionRowView row={row} where={where} nested={nested} onChanged={onChanged} />
    : <FanOutRowView row={row} where={where} nested={nested} onChanged={onChanged} />;
}

/**
 * A session, in the sidebar row's anatomy (ItemList): the title takes the width, the state sits at
 * the far end, and the row's action — the shelf — takes that slot under the pointer or the keyboard.
 *
 * A click opens the session wherever it is (`revealSession`, the one path every list of sessions
 * takes); ⌘-click opens it BESIDE the one in focus — the window's one split. The row of the session
 * in focus is lit, whichever space it is in. A session a schedule started wears a clock — in
 * the gutter under its section's icon when nested, so its title stays on the column the others use.
 */
export function SessionRowView({ row, where, nested = false, onChanged }: { row: SessionRow; where?: string; nested?: boolean; onChanged: () => void }) {
  const layout = useApp((s) => s.layout);
  const focused = useApp((s) => (s.layout ? itemIdOfLeaf(s.layout, s.focusedLeafId) === row.item.id : false));
  const revealSession = useApp((s) => s.revealSession);
  const openItemBeside = useApp((s) => s.openItemBeside);
  const run = useApp((s) => s.run);
  const archive = useArchiveAnywhere(onChanged);
  const [renaming, setRenaming] = useState(false);
  const [dragging, setDragging] = useState(false);
  const { onContextMenu, element } = useItemContextMenu(() => setRenaming(true), { onChanged });
  const mark = sessionMark(row.status, row.unread);
  const named = `${row.title}${row.scheduled ? ", from a schedule" : ""}${where ? ` in ${where}` : ""}`;
  return (
    // Every space of the profile is loaded, so any row can be dragged into the view or lit as its focus.
    <div className="item sb-row" data-nested={nested || undefined} data-active={focused || undefined} data-actions="1"
      data-dragging={dragging || undefined} draggable
      onDragStart={(e) => { e.dataTransfer.setData("application/x-realm-item", row.item.id); e.dataTransfer.effectAllowed = "move"; setDragging(true); }}
      onDragEnd={() => setDragging(false)} onContextMenu={onContextMenu(row.item)}>
      {renaming ? <RenameInput item={row.item} onDone={() => { setRenaming(false); onChanged(); }} /> : (
        <>
          <button type="button" className="item-row" aria-label={mark ? `${named} — ${mark.label}` : named}
            onClick={(e) => run(() => (e.metaKey ? openItemBeside(row.item.id) : revealSession(row.id, row.spaceId)))}>
            {nested
              ? <span className="sb-gutter" title={row.scheduled ? "Started by a schedule" : undefined}>{row.scheduled && <Icon name="clock" size={12} />}</span>
              : <Icon name={row.scheduled ? "clock" : "session"} size={16} />}
            <span className="item-title">{row.title}</span>
            {where && <span className="item-where">{where}</span>}
            <span className="item-trail">
              {mark && <span className="status-dot item-status" data-status={mark.mark} title={mark.mark === "unseen" ? "New since you were here" : mark.label} />}
              {/* The pane glyph W1 draws, for a session on screen in a split: which side it is. */}
              {layout && <ItemGlyph layout={layout} itemId={row.item.id} />}
            </span>
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

/**
 * A fan-out — several agents on one brief — as ONE row that unfolds to its sessions, so twenty
 * siblings do not bury the space. It wears the batch's tally at its far end, and says the whole of
 * it in words.
 */
export function FanOutRowView({ row, where, nested = false, onChanged }: { row: FanOutRow; where?: string; nested?: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const name = `Fan-out: ${row.title}`;
  const said = [`${name} — ${row.sessions.length} sessions`, ...tallyWords(row.tally)].join(", ") + (where ? `, in ${where}` : "");
  return (
    <>
      <div className="item sb-row" data-nested={nested || undefined} data-actions="0">
        <button type="button" className="item-row" aria-expanded={open} aria-label={said} title={said} onClick={() => setOpen((v) => !v)}>
          <span className={nested ? "sb-gutter" : "sb-lead"}><span className="sb-caret" data-open={open || undefined}><Icon name="chevronRight" size={12} /></span></span>
          <span className="item-title">{name}</span>
          {where && <span className="item-where">{where}</span>}
          <span className="item-trail"><TallyMarks tally={row.tally} /></span>
        </button>
      </div>
      {open && (
        <div className="item-list sb-fanout-rows" data-nested={nested || undefined}>
          {row.sessions.map((r) => <SessionRowView key={r.id} row={r} nested={nested} onChanged={onChanged} />)}
        </div>
      )}
    </>
  );
}
