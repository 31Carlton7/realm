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
 */
export function LiveSessionRow({ live }: { live: LiveSession }) {
  const revealSession = useApp((s) => s.revealSession);
  const run = useApp((s) => s.run);
  const mark = sessionMark(live.status, live.unread);
  const { title } = live.session;
  return (
    <div className="item" data-actions="0">
      <button type="button" className="item-row" aria-label={mark ? `${title} — ${mark.label}` : title}
        onClick={() => run(() => revealSession(live.session.id, live.spaceId))}>
        <Icon name="session" size={16} /><span className="item-title">{title}</span>
        <span className="item-trail">
          {mark && <span className="status-dot item-status" data-status={mark.mark} title={mark.mark === "unseen" ? "New since you were here" : mark.label} />}
        </span>
      </button>
    </div>
  );
}
