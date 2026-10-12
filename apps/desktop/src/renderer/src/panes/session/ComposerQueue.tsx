import { basenameOf, steerNote, type AgentKind, type QueuedPrompt } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useId, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import type { SubmitKey } from "../../state/store";
import { AttachmentTile } from "./AttachmentTile";

/** What a queued row can do with its message. Edit holds it on the server while the field is open
 *  (`sessions.holdQueued`), so a turn that settles mid-edit cannot send the old text. */
export type QueueActions = {
  onRelease: (queuedId: string) => void;
  onDrop: (queuedId: string) => void;
  /** Answers false when the message had already gone out, and the field does not open. */
  onBeginEdit: (queuedId: string) => Promise<boolean>;
  onSaveEdit: (queuedId: string, text: string) => void;
  onCancelEdit: (queuedId: string) => void;
  /** Put the message in front of `before`, or last when it is null (`sessions.moveQueued`). */
  onMove: (queuedId: string, before: string | null) => void;
};

/** From this many waiting, the queue folds to one line until it is asked for: three cards above the
 *  prompter push the box being typed in halfway up the pane. */
export const QUEUE_FOLD_AT = 3;
/** How long a row that went out stays to fold away: `--dur-swap`, the rung `rl-queue-out` runs on. */
const LEAVE_MS = 160;
/** The drag's own type, so the prompter's file and item drops (which read theirs) let it pass. */
const DRAG_TYPE = "application/x-realm-queued";

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/**
 * The rows that just left, kept a moment so they fold away rather than vanish — a Send now that made
 * the row blink out reads as a click that lost the message. Each is put back at the index it left
 * from, inert. Under Reduce motion nothing lingers.
 */
function useLeaving(queued: QueuedPrompt[]): { q: QueuedPrompt; leaving: boolean }[] {
  const prev = useRef(queued);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const [gone, setGone] = useState<{ q: QueuedPrompt; at: number }[]>([]);
  useLayoutEffect(() => {
    const was = prev.current;
    prev.current = queued;
    if (was === queued || reducedMotion()) return;
    const left = was.flatMap((q, at) => (queued.some((n) => n.id === q.id) ? [] : [{ q, at }]));
    if (left.length === 0) return;
    setGone((g) => [...g.filter((x) => !left.some((l) => l.q.id === x.q.id)), ...left]);
    // Not cleared when the queue changes again — a second change inside the fold would otherwise
    // strand the first row's ghost for good. Only an unmount takes them.
    const t = setTimeout(() => { timers.current.delete(t); setGone((g) => g.filter((x) => !left.includes(x))); }, LEAVE_MS);
    timers.current.add(t);
  }, [queued]);
  useEffect(() => () => { for (const t of timers.current) clearTimeout(t); }, []);
  const rows = queued.map((q) => ({ q, leaving: false }));
  for (const g of [...gone].sort((a, b) => a.at - b.at)) {
    if (!rows.some((r) => r.q.id === g.q.id)) rows.splice(Math.min(g.at, rows.length), 0, { q: g.q, leaving: true });
  }
  return rows;
}

/**
 * The messages waiting for this turn to end, oldest first — a tray at the top of the prompter's own
 * card, under a line that says what it is and when it goes.
 *
 * Above the input rather than in the transcript, because they are not transcript: nothing has been
 * asked yet, and a bubble for a message no agent has seen would make the log claim otherwise.
 *
 * Each message shows two lines of itself (a click shows the rest), the files going with it as the
 * prompter's own tiles in miniature with their names, and its three actions in words or marks that
 * stay on screen: Edit, Send now, Remove. Order is the queue's order, so two or more can be dragged
 * by the handle, or moved with ⌥↑ / ⌥↓ from anywhere in the row; from three the tray folds to one
 * line until it is opened.
 *
 * The send-now sits on the row rather than in the button corner, which is Stop's while a turn runs.
 * What it costs is `steerNote`'s answer and differs by agent.
 *
 * A message is edited in place, as plain text: an element chip shows as its `@[label]` token, and
 * taking the token out drops the chip (the server's `keepLiveChips`), exactly as in the prompter.
 */
export function ComposerQueue({ kind, queued, running, submitKey, actions }: {
  kind: AgentKind; queued: QueuedPrompt[]; running: boolean; submitKey: SubmitKey; actions: QueueActions;
}) {
  const [editing, setEditingState] = useState<{ id: string; text: string; was: string } | null>(null);
  // Mirrored in a ref so the Enter that closes the field and the blur that follows it are one close,
  // not two saves.
  const open = useRef(editing);
  const setEditing = (v: typeof editing) => { open.current = v; setEditingState(v); };
  const [unfolded, setUnfolded] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; side: "before" | "after" } | null>(null);
  const rows = useLeaving(queued);
  const listId = useId();
  // The message went out (or was removed elsewhere) while its field was open: what was typed is not
  // thrown away — a save of a message that is gone lands in the draft.
  useEffect(() => {
    if (!editing || queued.some((q) => q.id === editing.id)) return;
    if (editing.text !== editing.was && editing.text.trim()) actions.onSaveEdit(editing.id, editing.text);
    setEditing(null);
  }, [queued, editing, actions]);
  if (rows.length === 0) return null;

  const n = queued.length;
  const note = steerNote(kind);
  // A row being edited here is never folded out of sight.
  const folded = n >= QUEUE_FOLD_AT && !unfolded && !editing;
  const heldCount = queued.filter((q) => q.held).length + (editing && !queued.find((q) => q.id === editing.id)?.held ? 1 : 0);
  const when = n <= 1
    ? (running ? "sends when this turn ends" : "sends when the next turn ends")
    : (running ? "in order, as each turn ends" : "in order, from the next turn's end");

  const begin = async (q: QueuedPrompt) => {
    if (await actions.onBeginEdit(q.id)) setEditing({ id: q.id, text: q.text, was: q.text });
  };
  const close = (save: boolean) => {
    const e = open.current;
    if (!e) return;
    const changed = e.text !== e.was;
    // An edit to nothing at all is not a message; keep the field open rather than send it or drop it.
    if (save && changed && !e.text.trim() && !queued.find((q) => q.id === e.id)?.attachments.length) return;
    setEditing(null);
    if (save && changed) actions.onSaveEdit(e.id, e.text);
    else actions.onCancelEdit(e.id);
  };
  const onFieldKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(false); return; }
    if (e.key !== "Enter" || e.shiftKey) return;
    // The prompter's own send chord, so a correction is saved with the key that sends a message.
    if (e.metaKey || e.ctrlKey || submitKey === "enter") { e.preventDefault(); close(true); }
  };
  /** One step up or down. The anchor is the id the message lands in front of, as the server takes it. */
  const step = (i: number, by: -1 | 1) => {
    const q = queued[i];
    if (!q) return;
    if (by === -1 && i > 0) actions.onMove(q.id, queued[i - 1]!.id);
    if (by === 1 && i < n - 1) actions.onMove(q.id, queued[i + 2]?.id ?? null);
  };
  const onRowKey = (e: KeyboardEvent<HTMLLIElement>, i: number) => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown") || n < 2) return;
    if ((e.target as HTMLElement).tagName === "TEXTAREA") return; // the field's own ⌥-arrows move the caret
    e.preventDefault();
    const id = queued[i]!.id;
    step(i, e.key === "ArrowUp" ? -1 : 1);
    // The focus rides with the message, so a second ⌥↑ moves it again.
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-queued-id="${CSS.escape(id)}"] .queue-text`)?.focus());
  };
  const toggleText = (id: string) => setExpanded((s) => {
    const next = new Set(s);
    if (!next.delete(id)) next.add(id);
    return next;
  });

  /* Dragged by its handle, dropped on any row: the top half lands in front of it, the bottom half
     behind. The drop line is drawn on the row it would land against, never by moving the rows under
     the pointer — a list that shuffles while it is aimed at is a list that cannot be aimed at. */
  const sideOf = (e: DragEvent<HTMLElement>): "before" | "after" => {
    const r = e.currentTarget.getBoundingClientRect();
    return r.height > 0 && e.clientY > r.top + r.height / 2 ? "after" : "before";
  };
  const onDragOver = (e: DragEvent<HTMLLIElement>, id: string) => {
    if (!dragging || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    const side = sideOf(e);
    if (dropAt?.id !== id || dropAt.side !== side) setDropAt({ id, side });
  };
  const onDropRow = (e: DragEvent<HTMLLIElement>, i: number) => {
    const moving = dragging;
    if (!moving || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.stopPropagation();
    const side = sideOf(e);
    setDragging(null);
    setDropAt(null);
    const target = queued[i]!;
    const before = side === "before" ? target.id : (queued[i + 1]?.id ?? null);
    if (before === moving) return;
    const from = queued.findIndex((q) => q.id === moving);
    const to = before === null ? n : queued.findIndex((q) => q.id === before);
    if (to === from || to === from + 1) return; // dropped where it already is
    actions.onMove(moving, before);
  };

  const head = (
    <div className="queue-head">
      <Icon name="clock" size={12} className="queue-head-glyph" />
      <span className="queue-head-title">{n <= 1 ? "Queued" : `${n} queued`}</span>
      {folded ? (
        <span className="queue-head-next" title={queued[0]?.text}>
          <span className="queue-head-sep" aria-hidden="true">·</span>Next: {queued[0]?.text || "(attachments only)"}
        </span>
      ) : (
        <span className="queue-head-when"><span className="queue-head-sep" aria-hidden="true">·</span>{when}</span>
      )}
      {heldCount > 0 && folded && <span className="queue-head-held">· {heldCount} being edited</span>}
      {n >= QUEUE_FOLD_AT && (
        <button type="button" className="queue-fold" aria-expanded={!folded} aria-controls={listId}
          disabled={!!editing} onClick={() => setUnfolded(folded)}>
          {folded ? "Show all" : "Show less"}
          <Icon name={folded ? "chevronDown" : "chevronUp"} size={12} />
        </button>
      )}
    </div>
  );

  return (
    <section className="composer-queue" aria-label="Queued messages" data-count={n} data-folded={folded || undefined}>
      {head}
      {!folded && (
        <ol className="queue-list" id={listId} data-dragging={dragging ? "" : undefined}>
          {rows.map(({ q, leaving }) => {
            const i = queued.findIndex((x) => x.id === q.id);
            const mine = !leaving && editing?.id === q.id;
            // Held and not by this field: another window is editing it, so this one only shows that.
            const elsewhere = q.held && !mine;
            const long = expanded.has(q.id);
            const movable = n >= 2 && !leaving && !mine;
            return (
              <li key={q.id} className="composer-queue-item" data-queued-id={q.id}
                data-leaving={leaving || undefined} inert={leaving || undefined} aria-hidden={leaving || undefined}
                data-editing={mine || undefined} data-held={q.held || mine || undefined}
                data-dragging={dragging === q.id || undefined}
                data-drop={dropAt?.id === q.id && dragging !== q.id ? dropAt.side : undefined}
                onKeyDown={(e) => onRowKey(e, i)}
                onDragOver={(e) => onDragOver(e, q.id)}
                onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null) && dropAt?.id === q.id) setDropAt(null); }}
                onDrop={(e) => onDropRow(e, i)}>
                <div className="queue-item-body">
                  {n >= 2 && (
                    <span className="queue-grip" draggable={movable} aria-hidden="true" title="Drag to reorder (⌥↑ ⌥↓)"
                      onDragStart={(e) => {
                        e.dataTransfer.setData(DRAG_TYPE, q.id);
                        e.dataTransfer.effectAllowed = "move";
                        const row = e.currentTarget.closest("li");
                        if (row) e.dataTransfer.setDragImage(row, 16, 12);
                        setDragging(q.id);
                      }}
                      onDragEnd={() => { setDragging(null); setDropAt(null); }}>
                      <Icon name="grip" size={12} />
                    </span>
                  )}
                  <div className="queue-main">
                    {mine ? (
                      <textarea className="queue-edit" aria-label={`Edit queued message ${i + 1}`} autoFocus rows={1}
                        value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                        onKeyDown={onFieldKey} onBlur={() => close(true)} />
                    ) : (
                      /* Two lines at rest, the whole of it on a click: enough to recognise what is
                         coming without the tray outgrowing the box being typed in. */
                      <button type="button" className="queue-text" aria-expanded={long} data-long={long || undefined}
                        aria-label={`Queued message ${i + 1} of ${n}: ${q.text || "attachments only"}`}
                        onClick={() => toggleText(q.id)}>
                        {q.text || <span className="queue-text-empty">Attachments only</span>}
                      </button>
                    )}
                    {(mine || elsewhere) && (
                      <span className="queue-held" role="status">
                        <Icon name={mine ? "edit" : "pause"} size={12} />
                        {mine
                          ? <>Held while you edit<span className="queue-held-keys"> · {submitKey === "enter" ? "↵" : "⌘↵"} saves · esc cancels</span></>
                          : "Being edited in another window"}
                      </span>
                    )}
                    {q.attachments.length > 0 && (
                      <ul className="queue-files" aria-label="Attachments">
                        {q.attachments.map((a) => (
                          <li key={a.path} className="queue-file">
                            <AttachmentTile path={a.path} mime={a.mime} siblings={q.attachments} />
                            <span className="queue-file-name" aria-hidden="true">{basenameOf(a.path)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="queue-actions">
                    {n >= 2 && (
                      <span className="queue-steps">
                        <button type="button" className="queue-icon queue-up" aria-label="Move up" title="Move up (⌥↑)"
                          disabled={!movable || i === 0} onClick={() => step(i, -1)}>
                          <Icon name="arrowUp" size={12} />
                        </button>
                        <button type="button" className="queue-icon queue-down" aria-label="Move down" title="Move down (⌥↓)"
                          disabled={!movable || i === n - 1} onClick={() => step(i, 1)}>
                          <Icon name="arrowDown" size={12} />
                        </button>
                      </span>
                    )}
                    {!mine && (
                      <button type="button" className="queue-icon queue-edit-btn" aria-label={`Edit queued message: ${q.text}`} title="Edit"
                        disabled={elsewhere} onClick={() => void begin(q)}>
                        <Icon name="edit" size={12} />
                      </button>
                    )}
                    {/* Words where there is room, the send arrow where there is not: in a narrow pane
                        the two words took the width the message needed. */}
                    <button type="button" className="queue-send" aria-label="Send now" title={note} disabled={mine || elsewhere}
                      // Clicked from an open field, the field's blur has already saved; this would only race it.
                      onMouseDown={(e) => { if (mine) e.preventDefault(); }}
                      onClick={() => actions.onRelease(q.id)}>
                      <Icon name="arrowUp" size={12} className="queue-send-glyph" />
                      <span className="queue-send-label">Send now</span>
                    </button>
                    <button type="button" className="queue-icon queue-drop" aria-label={`Remove queued message: ${q.text}`} title="Remove"
                      onMouseDown={(e) => { if (mine) e.preventDefault(); }}
                      onClick={() => { if (mine) setEditing(null); actions.onDrop(q.id); }}>
                      <Icon name="close" size={12} />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
