import { Icon } from "@realm/ui";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { Session } from "@realm/contracts";
import { useApp } from "../../state/store";
import { useAnchoredPopover } from "../use-anchored-popover";
import { PendingCard } from "../../panes/session/PendingCard";

/**
 * The sidebar column's width below which the chip says only its number. Its words are the part of
 * the head band that yields first: at 280 the head holds the chip, the bell, the activity glyph and
 * the toggle with the traffic lights' corner to spare, and narrower than this the words would reach
 * under the lights. The count and the accessible name stay whole at every width.
 */
export const NEEDS_YOU_WORDS_MIN = 260;

/**
 * "N need you" (W11c): how many sessions, in any space, are waiting on a permission or a question —
 * in the sidebar's head band beside the bell, and absent when none is. The menu-bar item's job with
 * the window open: the count says something is waiting, and the list answers it where it stands.
 *
 * The count is the status map the space strip's badges and the Agents row read, so the three cannot
 * disagree. A question rides the permission channel, so it is counted by the same status.
 */
export function NeedsYou() {
  const count = useApp((s) => Object.values(s.sessionStatus).filter((st) => st === "waiting_permission").length);
  if (count === 0) return null;
  return <Control count={count} />;
}

function Control({ count }: { count: number }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const roomy = useApp((s) => s.sidebarWidth >= NEEDS_YOU_WORDS_MIN);
  const name = count === 1 ? "1 session needs you" : `${count} sessions need you`;
  return (
    <>
      <button ref={anchor} type="button" className="needs-you" aria-haspopup="dialog" aria-expanded={open}
        aria-label={name} title={`${name} — answer here`} onClick={() => setOpen((o) => !o)}>
        {roomy ? (count === 1 ? "1 needs you" : `${count} need you`) : count}
      </button>
      {open && <Waiting anchor={anchor} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * The waiting sessions, each with its card answerable in place and a way to the session itself.
 *
 * Titles and spaces come from one `sessions.listAll`, re-read whenever any status moves — the Agents
 * page's rule, since this window holds rows for its own space alone. The cards come from the session's
 * transcript, loaded here when no pane ever opened it, which is the feed's own way of drawing a
 * pending permission: one pipeline, so an answer given anywhere takes the card away everywhere.
 */
function Waiting({ anchor, onClose }: { anchor: RefObject<HTMLButtonElement | null>; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const { pos, closing, close } = useAnchoredPopover({ ref, anchorRef: anchor, onClose, returnFocusRef: anchor, exit: true });
  const status = useApp((s) => s.sessionStatus);
  const spaces = useApp((s) => s.spaces);
  const listAll = useApp((s) => s.listAllSessions);
  const jumpToPermission = useApp((s) => s.jumpToPermission);
  const run = useApp((s) => s.run);
  const [rows, setRows] = useState<Session[] | null>(null);
  useEffect(() => {
    let live = true;
    run(async () => { const all = await listAll(); if (live) setRows(all); });
    return () => { live = false; };
  }, [listAll, run, status]);
  // Longest-waiting first: the one that has been blocked the longest is the one owed an answer first.
  const waiting = useMemo(() => (rows ?? [])
    .filter((r) => (status[r.id] ?? r.status) === "waiting_permission")
    .sort((a, b) => a.updatedAt - b.updatedAt), [rows, status]);
  const spaceName = (id: string) => spaces.find((sp) => sp.id === id)?.name ?? "";
  const style: CSSProperties = { position: "fixed", left: pos?.left ?? -9999, top: pos?.top ?? -9999,
    visibility: pos ? "visible" : "hidden", transformOrigin: pos?.origin ?? "top left" };
  return createPortal(
    <div ref={ref} role="dialog" aria-label="Waiting on you" className="menu needs-you-pop" style={style}
      data-closing={closing || undefined} inert={closing}>
      <ul className="needs-you-list">
        {waiting.map((s) => (
          <WaitingSession key={s.id} session={s} spaceName={spaceName(s.spaceId)}
            onGo={() => { run(async () => { await jumpToPermission(s.id); }); close(); }} />
        ))}
      </ul>
    </div>,
    document.body,
  );
}

function WaitingSession({ session, spaceName, onGo }: { session: Session; spaceName: string; onGo: () => void }) {
  const transcript = useApp((s) => s.transcripts[session.id]);
  const openSession = useApp((s) => s.openSession);
  const respondPermission = useApp((s) => s.respondPermission);
  const run = useApp((s) => s.run);
  useEffect(() => { if (!transcript) run(() => openSession(session.id)); }, [session.id, transcript, openSession, run]);
  const pending = transcript?.t.pendingPermissions ?? [];
  return (
    <li className="needs-you-session" role="group" aria-label={`${session.title}, in ${spaceName}`}>
      <div className="needs-you-head">
        <span className="needs-you-title">{session.title}</span>
        <span className="needs-you-space">{spaceName}</span>
        <button type="button" className="icon-btn" aria-label={`Go to ${session.title}`} title="Go to the session" onClick={onGo}>
          <Icon name="chevronRight" size={14} />
        </button>
      </div>
      {pending.map((p) => (
        <PendingCard key={p.requestId} permission={p}
          onDecide={(d) => run(() => respondPermission(session.id, p.requestId, d))}
          onAnswer={(answers) => run(() => respondPermission(session.id, p.requestId, "allow", answers))} />
      ))}
    </li>
  );
}
