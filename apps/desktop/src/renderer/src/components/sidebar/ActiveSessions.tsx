import { itemIdOfLeaf } from "@realm/contracts";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LiveSession } from "../../state/attention";
import { useApp } from "../../state/store";
import { LiveSessionRow } from "./LiveSessionRow";
import { useLiveSessions } from "./use-live-sessions";

/** A handful: enough for the sessions that need you on most days, few enough that a short window
 *  keeps most of the column for the room underneath. */
export const ACTIVE_ROWS = 4;

/**
 * What needs you, from every room of the profile, at the top of the body: sessions waiting on you,
 * then working, then finished with something you have not read — each naming its room and wearing
 * its state at the far end.
 *
 * Drawn only when there is something in it, and docked above the room rather than scrolling with it:
 * it is the one list in the column that does not change when the room does, so it must not slide
 * with a swipe or move when a click on it switches rooms underneath. Bounded for the same reason it
 * is docked — every row here is height the room below does not get — and the rest are one click away
 * on the Agents page, which is the whole list.
 *
 * Two rules keep it from jumping under the pointer:
 *
 *  - The session whose pane has the keyboard is left out: you are looking at it, and a session you
 *    are working in would otherwise appear and vanish above the room with every turn you sent it.
 *  - …unless it was already listed when it got the keyboard. A row you click stays where it is while
 *    you read it, even once reading it has made it quiet; it goes when you move on.
 */
export function ActiveSessions() {
  const live = useLiveSessions();
  const spaces = useApp((s) => s.spaces);
  const openDestinationPage = useApp((s) => s.openDestinationPage);
  const focused = useApp((s) => {
    const id = itemIdOfLeaf(s.layout, s.focusedLeafId);
    const item = id ? s.items.find((i) => i.id === id) : undefined;
    return item?.kind === "session" ? item.refId : null;
  });
  const [held, setHeld] = useState<string | null>(null);
  const shown = useRef<ReadonlySet<string>>(new Set());
  /* Decided when the keyboard moves, against what was on screen the moment before — read here, not
     in the updater, which runs after this commit has already recorded what it showed. A layout
     effect, so the frame in which the newly focused row is not yet held never reaches the screen. */
  useLayoutEffect(() => {
    const wasShown = focused !== null && shown.current.has(focused);
    setHeld((h) => (focused === h ? h : wasShown ? focused : null));
  }, [focused]);
  const heldRow = useApp((s) => (held ? s.sessions[held] ?? s.allSessions[held] : undefined));
  const heldStatus = useApp((s) => (held ? s.sessionStatus[held] : undefined));

  const rows = useMemo(() => {
    const out: LiveSession[] = live.filter((l) => l.session.id !== focused || l.session.id === held);
    // Held but quiet now — read, or settled while you watched. It stays, last, with no mark.
    if (held && held === focused && heldRow && heldStatus && !out.some((l) => l.session.id === held)) {
      out.push({ session: heldRow, status: heldStatus, unread: false, attention: 2, spaceId: heldRow.spaceId, movedAt: heldRow.updatedAt });
    }
    return out;
  }, [live, focused, held, heldRow, heldStatus]);
  /* The bound never hides the row you are reading: past it, that row takes the last place. */
  const pinned = held ? rows.find((l) => l.session.id === held) : undefined;
  const first = rows.slice(0, ACTIVE_ROWS);
  const visible = !pinned || first.includes(pinned) ? first : [...rows.slice(0, ACTIVE_ROWS - 1), pinned];
  useLayoutEffect(() => { shown.current = new Set(visible.map((l) => l.session.id)); });

  if (visible.length === 0) return null;
  const spaceName = (id: string) => spaces.find((sp) => sp.id === id)?.name ?? "";
  return (
    <div className="sb-active">
      <div className="group-label">Active</div>
      <div className="item-list">
        {visible.map((l) => (
          <LiveSessionRow key={l.session.id} live={l} where={spaceName(l.spaceId)} active={l.session.id === focused} />
        ))}
      </div>
      {rows.length > ACTIVE_ROWS && (
        <button type="button" className="agents-more sb-active-all" title="Every session, by what it needs from you"
          onClick={() => openDestinationPage("agents-page")}>
          Show all {rows.length}
        </button>
      )}
    </div>
  );
}
