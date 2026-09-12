import { Icon } from "@realm/ui";
import { useApp } from "../../state/store";

/**
 * The feed, as a bell in the head row rather than a row in the nav.
 *
 * It was a destination row with a count pill, which put a permanent line of chrome in the column for
 * a thing that is usually at zero. What it has to say — "something arrived" — is a glyph and a
 * number, so it costs a button; the page it opens is unchanged and still reachable from ⌘K.
 *
 * The count comes from the server (`notifications.list`/`notifications.changed`), never from a tally
 * of held rows: the page and this badge have to agree, and two derivations of one number is how they
 * stop agreeing. It rides in the accessible NAME as well as the badge, because a 15px chip is the
 * one part of this control a screen reader cannot describe by shape.
 *
 * Lit while the page is up and puts it away again — the destination rows' rule, which this button
 * inherits along with their page.
 */
export function SidebarNotifications() {
  const unread = useApp((s) => s.notificationsUnread);
  const open = useApp((s) => s.pageOverlay?.kind === "notifications-page");
  const openDestinationPage = useApp((s) => s.openDestinationPage);
  const closePageOverlay = useApp((s) => s.closePageOverlay);
  return (
    <button className="sb-toggle sb-bell" aria-pressed={open}
      aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"} title="Notifications"
      onClick={() => (open ? closePageOverlay() : openDestinationPage("notifications-page"))}>
      <Icon name="notifications-page" size={14} />
      {/* Only when something is actually unread — a permanent zero is the dead chrome the nav this
          came from bans. Two digits is the ceiling a badge this size can set without shrinking its
          text under the type floor; past that the exact number is on the page it opens. */}
      {unread > 0 && <span className="sb-badge" aria-hidden="true">{unread > 99 ? "99+" : unread}</span>}
    </button>
  );
}
