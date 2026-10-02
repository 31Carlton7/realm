import { Icon } from "@realm/ui";
import { sessionMark, type LiveSession } from "../../state/attention";
import { useApp } from "../../state/store";

/**
 * One session drawn outside its room's own list — the sidebar row's anatomy (ItemList), with the
 * parts a row that is not an item cannot have taken out.
 *
 * The title takes the width and the state sits in `.item-trail` at the far end, exactly as on the
 * room's own rows. There are no actions: archiving and closing are a room's business, done from the
 * row in that room, so `data-actions="0"` keeps the state on screen under the pointer rather than
 * stepping it aside for a slot with nothing in it.
 *
 * A click goes to the session, switching rooms if it has to — the same `revealSession` the Agents
 * page and a notification take.
 *
 * `where` names the session's room, in the muted run after the title, for a list that crosses rooms
 * (the Active section); a list under its own room's row has no need to say so. The title is the
 * unbounded half and gives way first; the room's name keeps its width up to a cap, so a short one is
 * never cut to make room for a long title (design.md, the yielding order).
 */
export function LiveSessionRow({ live, where, active = false }: { live: LiveSession; where?: string; active?: boolean }) {
  const revealSession = useApp((s) => s.revealSession);
  const run = useApp((s) => s.run);
  const mark = sessionMark(live.status, live.unread);
  const { title } = live.session;
  const named = where ? `${title} in ${where}` : title;
  return (
    <div className="item" data-actions="0" data-active={active || undefined}>
      <button type="button" className="item-row" aria-label={mark ? `${named} — ${mark.label}` : named}
        onClick={() => run(() => revealSession(live.session.id, live.spaceId))}>
        <Icon name="session" size={16} /><span className="item-title">{title}</span>
        {where && <span className="item-where">{where}</span>}
        <span className="item-trail">
          {mark && <span className="status-dot item-status" data-status={mark.mark} title={mark.mark === "unseen" ? "New since you were here" : mark.label} />}
        </span>
      </button>
    </div>
  );
}
