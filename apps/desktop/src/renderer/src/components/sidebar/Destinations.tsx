import { Icon } from "@realm/ui";
import type { ComponentProps, ReactNode } from "react";
import type { DestinationPageKind } from "@realm/contracts";
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
  // The server's count, verbatim (`notifications.list`/`notifications.changed`) — never a client-side
  // tally of rows, which would be a second derivation site that could disagree with the page's header.
  const unread = useApp((s) => s.notificationsUnread);
  return (
    <nav className="sb-destinations" aria-label="Destinations">
      <DestRow kind="library-page" label="Library" />
      <DestRow kind="connections-page" label="Connections" />
      {/* W5: the feed row. The pill appears only when something is actually unread — a permanent
          zero would be dead chrome, which this nav bans. */}
      <DestRow kind="notifications-page" label="Notifications">
        {unread > 0 && <span className="status-pill dest-count" data-tone="warning" aria-label={`${unread} unread`}>{unread}</span>}
      </DestRow>
      {/* Settings moved here off the space strip's left slot: it is an app-level page like the three
          above it, and the strip is a rail about spaces — the gear was the only thing in it that
          wasn't one, and it cost the strip a slot it needed. Ungated like its neighbours, because
          `openDestinationPage` already no-ops with no active space; a disabled row is what this nav
          bans. */}
      <DestRow kind="settings-page" label="Settings" icon="settings" />
      {/* Seam (Plan 14 W5, deliberately unbuilt): when Plan 13's Tasks lens lands, its row goes here
          with a running-tasks count pill on the Notifications pattern above — server-derived count,
          rendered only when non-zero. Not stubbed now: a row for a page that does not exist yet is
          exactly the dead chrome this nav bans. */}
    </nav>
  );
}

/**
 * One destination row. A plain click homes: one page per space, so a second click goes to the pane that
 * already holds it, wherever that is. ⌥-click puts the page in the focused pane instead — the gesture
 * for "I want this here", which until now was a drag.
 *
 * The tooltip appears only while the two would differ, so a row that has nothing to offer says nothing
 * rather than teaching a modifier that does the same thing as no modifier.
 */
function DestRow({ kind, label, icon, children }: {
  kind: DestinationPageKind; label: string;
  /** Defaults to the kind's own icon; Settings wears the gear it wore in the space strip. */
  icon?: ComponentProps<typeof Icon>["name"];
  children?: ReactNode;
}) {
  const openDestinationPage = useApp((s) => s.openDestinationPage);
  const elsewhere = useApp((s) => s.destinationPageElsewhere(kind));
  const run = useApp((s) => s.run);
  return (
    <button className="item-row dest-row" title={elsewhere ? `⌥-click to open ${label} in the focused pane` : undefined}
      onClick={(e) => run(() => openDestinationPage(kind, e.altKey ? "here" : "reuse"))}>
      <Icon name={icon ?? kind} size={16} /><span>{label}</span>
      {children}
    </button>
  );
}
