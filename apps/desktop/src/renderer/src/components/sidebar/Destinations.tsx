import { Icon } from "@realm/ui";
import type { ComponentProps, ReactNode } from "react";
import type { DestinationPageKind } from "@realm/contracts";
import { useApp } from "../../state/store";

/**
 * Sidebar destinations (Plan 12 W4, Universe screenshot 3): app-level pages above the space section —
 * quiet rows, and the pages they open are not items either. Each shows its page OVER the workspace
 * (`pageOverlay`), which is what keeps opening one from rearranging the panes you were working in.
 *
 * Realm adopts Universe's PATTERN, not its inventory: Library and Connections only. Discover, Calendar
 * and the rest are Universe's cloud product; and no row renders disabled here — dead chrome is worse
 * than absence.
 */
export function Destinations() {
  // How many agents are waiting on a permission, across every space — the one number a manager of
  // several sessions wants without opening anything. Derived from the same status map the space
  // strip's badges read, so the two cannot disagree.
  const needsYou = useApp((s) => Object.values(s.sessionStatus).filter((st) => st === "waiting_permission").length);
  return (
    <nav className="sb-destinations" aria-label="Destinations">
      {/* First, because it is the page that answers "what should I look at" — the question the rest
          of the nav is navigated FROM. The pill counts agents blocked on you, and only then. */}
      <DestRow kind="agents-page" label="Agents" icon="bot">
        {needsYou > 0 && <span className="status-pill dest-count" data-tone="warning" aria-label={`${needsYou} waiting on you`}>{needsYou}</span>}
      </DestRow>
      <DestRow kind="library-page" label="Library" />
      <DestRow kind="connections-page" label="Connections" />
      {/* The feed is NOT a row here. It was one, with a count pill, and it held a permanent line of
          the nav for something that is usually at zero — it is the bell in the head row now
          (SidebarNotifications), which is the same page from a control that costs no row. */}
      {/* Work this space starts on a clock. It sits with the app-level pages rather than inside the
          space page because it is a DESTINATION — somewhere you go to see what is armed — and
          because its runs outlive whichever session was open when they were set up. */}
      <DestRow kind="schedules-page" label="Scheduled tasks" />
      {/* Settings moved here off the space strip's left slot: it is an app-level page like the four
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
 * One destination row. A click shows the page over the workspace; the row lights while it is up, and
 * pressing it again puts it away — a lit control says the state and undoes it in the same click.
 *
 * There is no ⌥-click any more. It used to mean "put this page in the focused pane", which was a real
 * choice while a page was a layout item; a page is an overlay now, so there is one and it is over
 * everything.
 */
function DestRow({ kind, label, icon, children }: {
  kind: DestinationPageKind; label: string;
  /** Defaults to the kind's own icon; Settings wears the gear it wore in the space strip. */
  icon?: ComponentProps<typeof Icon>["name"];
  children?: ReactNode;
}) {
  const openDestinationPage = useApp((s) => s.openDestinationPage);
  const closePageOverlay = useApp((s) => s.closePageOverlay);
  const open = useApp((s) => s.pageOverlay?.kind === kind);
  return (
    <button className="item-row dest-row" data-on={open || undefined} aria-pressed={open}
      onClick={() => (open ? closePageOverlay() : openDestinationPage(kind))}>
      <Icon name={icon ?? kind} size={16} /><span>{label}</span>
      {children}
    </button>
  );
}
