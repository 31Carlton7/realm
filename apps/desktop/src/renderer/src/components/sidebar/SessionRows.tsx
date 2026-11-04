import { Icon } from "@realm/ui";
import { memo, useState } from "react";
import { itemIdOfLeaf, type Item } from "@realm/contracts";
import { age } from "../../panes/code-review/code-review-model";
import { sessionSignal, type RowSignal } from "../../state/attention";
import { useApp } from "../../state/store";
import { RenameInput } from "../RenameInput";
import { SpaceIcon } from "../SpaceIcon";
import { Spinner } from "../Spinner";
import { useItemContextMenu } from "./ItemContextMenu";
import { ItemGlyph } from "./ItemList";
import { sameRow, tallyWords, type FanOutRow, type ListRow, type SessionRow, type Tally } from "./model";
import { useArchiveAnywhere, useNow, useSpaceTint } from "./use-sidebar-model";

/**
 * A tally at a row's far end, in the rows' own signals: how many wait on you, beside the amber dot,
 * and how many are working, beside the spinner. Failures count as waiting on you, as they do on a row.
 * Unread has no count — the rows under it are bold, and the words say it.
 */
export function TallyMarks({ tally }: { tally: Tally }) {
  const waiting = tally.waiting + tally.failed;
  return (
    <>
      {waiting > 0 && (
        <span className="item-tally"><span className="item-count">{waiting}</span><span className="status-dot item-status" data-status="waiting_permission" /></span>
      )}
      {tally.running > 0 && (
        <span className="item-tally"><span className="item-count">{tally.running}</span><Spinner size={14} className="item-spinner" /></span>
      )}
    </>
  );
}

/**
 * The far end of a row: the amber dot while it needs you, a spinner while it works, and otherwise how
 * long ago it last moved — the one slot every row of the column keeps its state in.
 */
export function SignalTrail({ signal, at, now }: { signal: RowSignal; at: number | null; now: number }) {
  if (signal.needsYou) return <span className="status-dot item-status" data-status="waiting_permission" />;
  if (signal.working) return <Spinner size={14} className="item-spinner" />;
  return at ? <span className="item-age">{age(at, now)}</span> : null;
}

/** One row of the list, whichever kind it is. `where` names its space where the list holds several. */
export const ListRowView = memo(function ListRowView({ row, where, onChanged }: { row: ListRow; where?: string; onChanged: () => void }) {
  return row.kind === "session"
    ? <SessionRowView row={row} where={where} onChanged={onChanged} />
    : <FanOutRowView row={row} where={where} onChanged={onChanged} />;
}, (a, b) => a.where === b.where && a.onChanged === b.onChanged && sameRow(a.row, b.row));

/** What a session row says about itself: its signal, its sub-agents' request in words, and the whole
 *  of it as the row's accessible name and tooltip — one sentence whichever shape the row is drawn in. */
export function sessionWords(row: SessionRow, where?: string): { signal: RowSignal; agents: string; said: string } {
  const signal = sessionSignal(row.status, row.unread);
  const agents = row.agentsWaiting > 0 ? `${row.agentsWaiting} sub-agent${row.agentsWaiting === 1 ? " needs" : "s need"} you` : "";
  const named = `${row.title}${row.scheduled ? ", from a schedule" : ""}${where ? ` in ${where}` : ""}${agents ? `, ${agents}` : ""}`;
  return { signal, agents, said: signal.words ? `${named} — ${signal.words}` : named };
}

/** Open a session from its row: wherever it is (`revealSession`), and a lead with sub-agents waiting
 *  on the one that has waited longest, in its Agents tab, where the request is answered. */
export function useOpenSessionRow(row: SessionRow): () => Promise<void> {
  const revealSession = useApp((s) => s.revealSession);
  const openAgentsTab = useApp((s) => s.openAgentsTab);
  return async () => {
    await revealSession(row.id, row.spaceId);
    if (row.firstWaiting) await openAgentsTab(row.id, { childId: row.firstWaiting });
  };
}

/**
 * A session, in the sidebar row's anatomy (ItemList): the title takes the width, bold while unread,
 * the state or the age sits at the far end (`SignalTrail`), and the row's action — the shelf — takes
 * that slot under the pointer or the keyboard. Its tooltip says its state in words.
 *
 * A click opens the session wherever it is (`revealSession`, the one path every list of sessions
 * takes); ⌘-click opens it BESIDE the one in focus — the window's one split. The row of the session
 * in focus is lit, whichever space it is in. A session a schedule started wears a clock in place of
 * the chat glyph.
 *
 * `pinned` is the same row under Pinned: its lead is its space's icon, in the space's colour as its
 * tile wears it, rather than the chat glyph — pins come from every space, and which one is the
 * thing to tell at a glance. Its space's name goes to the name and the tooltip rather than the line
 * (the title is what tells pins apart), and the one action under the pointer is Unpin — what a
 * person does to a pin.
 */
export function SessionRowView({ row, where, pinned = false, onChanged }: {
  row: SessionRow; where?: string; pinned?: boolean; onChanged: () => void;
}) {
  const layout = useApp((s) => s.layout);
  const focused = useApp((s) => (s.layout ? itemIdOfLeaf(s.layout, s.focusedLeafId) === row.item.id : false));
  const openItemBeside = useApp((s) => s.openItemBeside);
  const run = useApp((s) => s.run);
  const archive = useArchiveAnywhere(onChanged);
  const [renaming, setRenaming] = useState(false);
  const [dragging, setDragging] = useState(false);
  const { onContextMenu, element } = useItemContextMenu(() => setRenaming(true), { onChanged });
  const { signal, agents, said } = sessionWords(row, where);
  const now = useNow();
  const space = useApp((s) => (pinned ? s.spaces.find((x) => x.id === row.spaceId) : undefined));
  const tint = useSpaceTint(space?.color);
  const open = useOpenSessionRow(row);
  return (
    // Every space of the profile is loaded, so any row can be dragged into the view or lit as its focus.
    <div className="item sb-row" data-active={focused || undefined} data-unread={signal.unread || undefined} data-actions="1"
      data-dragging={dragging || undefined} draggable
      onDragStart={(e) => { e.dataTransfer.setData("application/x-realm-item", row.item.id); e.dataTransfer.effectAllowed = "move"; setDragging(true); }}
      onDragEnd={() => setDragging(false)} onContextMenu={onContextMenu(row.item)}>
      {renaming ? <RenameInput item={row.item} onDone={() => { setRenaming(false); onChanged(); }} /> : (
        <>
          <button type="button" className="item-row" aria-label={said} title={said}
            onClick={(e) => run(() => (e.metaKey ? openItemBeside(row.item.id) : open()))}>
            {pinned ? <span className="sb-space-icon" style={tint ? { color: tint } : undefined}><SpaceIcon icon={space?.icon || "folder"} size={16} /></span>
              : <Icon name={row.scheduled ? "clock" : "session"} size={16} />}
            <span className="item-title">{row.title}</span>
            {where && !pinned && <span className="item-where">{where}</span>}
            <span className="item-trail">
              {row.agentsWaiting > 0 && (
                <span className="item-tally" title={agents}><span className="item-count">{row.agentsWaiting}</span><span className="status-dot item-status" data-status="waiting_permission" /></span>
              )}
              <SignalTrail signal={signal} at={row.at} now={now} />
              {/* The pane glyph W1 draws, for a session on screen in a split: which side it is. */}
              {layout && <ItemGlyph layout={layout} itemId={row.item.id} />}
            </span>
          </button>
          <span className="item-actions">
            {pinned
              ? <UnpinButton item={row.item} onChanged={onChanged} />
              : (
                <button type="button" className="item-shelf" aria-label={`Archive ${row.title}`} title="Archive" onClick={() => archive(row.item)}>
                  <Icon name="archive" size={12} />
                </button>
              )}
          </span>
        </>
      )}
      {element}
    </div>
  );
}

/** A pin's one action under the pointer. The menu's Unpin, a click closer. */
export function UnpinButton({ item, onChanged }: { item: Item; onChanged: () => void }) {
  const updateItem = useApp((s) => s.updateItem);
  const run = useApp((s) => s.run);
  return (
    <button type="button" className="item-shelf" aria-label={`Unpin ${item.title}`} title="Unpin"
      onClick={() => run(async () => { await updateItem({ id: item.id, pinned: false }); onChanged(); })}>
      <Icon name="unpin" size={12} />
    </button>
  );
}

/**
 * A fan-out — several agents on one brief — as ONE row that unfolds to its sessions, so twenty
 * siblings do not bury the space. It wears the batch's tally at its far end, and says the whole of
 * it in words.
 */
export function FanOutRowView({ row, where, onChanged }: { row: FanOutRow; where?: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const name = `Fan-out: ${row.title}`;
  const said = [`${name} — ${row.sessions.length} sessions`, ...tallyWords(row.tally)].join(", ") + (where ? `, in ${where}` : "");
  return (
    <>
      <div className="item sb-row" data-actions="0">
        <button type="button" className="item-row" aria-expanded={open} aria-label={said} title={said} onClick={() => setOpen((v) => !v)}>
          <span className="sb-lead"><span className="sb-caret" data-open={open || undefined}><Icon name="chevronRight" size={12} /></span></span>
          <span className="item-title">{name}</span>
          {where && <span className="item-where">{where}</span>}
          <span className="item-trail"><TallyMarks tally={row.tally} /></span>
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
