import { Icon } from "@realm/ui";
import { useApp } from "../../state/store";

/**
 * Sidebar destinations (Plan 12 W4, Universe screenshot 3): app-level pages above the space section —
 * quiet rows, not items. Each opens (or focuses — one page per space) its destination pane in the
 * active space's layout via `openDestinationPage`.
 *
 * Realm adopts Universe's PATTERN, not its inventory: Library and Connections only. Discover, Calendar
 * and the rest are Universe's cloud product; and no row renders disabled here — dead chrome is worse
 * than absence.
 */
export function Destinations() {
  const openDestinationPage = useApp((s) => s.openDestinationPage);
  const run = useApp((s) => s.run);
  // The server's count, verbatim (`notifications.list`/`notifications.changed`) — never a client-side
  // tally of rows, which would be a second derivation site that could disagree with the page's header.
  const unread = useApp((s) => s.notificationsUnread);
  return (
    <nav className="sb-destinations" aria-label="Destinations">
      <button className="item-row dest-row" onClick={() => run(() => openDestinationPage("library-page"))}>
        <Icon name="library-page" size={16} /><span>Library</span>
      </button>
      <button className="item-row dest-row" onClick={() => run(() => openDestinationPage("connections-page"))}>
        <Icon name="connections-page" size={16} /><span>Connections</span>
      </button>
      {/* W5: the feed row. The pill appears only when something is actually unread — a permanent
          zero would be dead chrome, which this nav bans. */}
      <button className="item-row dest-row" onClick={() => run(() => openDestinationPage("notifications-page"))}>
        <Icon name="notifications-page" size={16} /><span>Notifications</span>
        {unread > 0 && <span className="status-pill dest-count" data-tone="warning" aria-label={`${unread} unread`}>{unread}</span>}
      </button>
      {/* Seam (Plan 14 W5, deliberately unbuilt): when Plan 13's Tasks lens lands, its row goes here
          with a running-tasks count pill on the Notifications pattern above — server-derived count,
          rendered only when non-zero. Not stubbed now: a row for a page that does not exist yet is
          exactly the dead chrome this nav bans. */}
    </nav>
  );
}
