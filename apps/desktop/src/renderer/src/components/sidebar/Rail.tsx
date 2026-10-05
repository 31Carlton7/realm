import { Icon, type IconName } from "@realm/ui";
import { useEffect, useRef, useState } from "react";
import type { DestinationPageKind } from "@realm/contracts";
import { useApp } from "../../state/store";
import { Avatar } from "../Avatar";
import { Menu } from "../Menu";
import { RailRecording } from "./RailRecording";
import { SidebarToggle } from "./SidebarToggle";
import { WindowNav } from "./WindowNav";
import { waitingCount } from "./model";
import { useChord } from "./use-sidebar-model";

/**
 * The rail: the app's destinations as a column of icons at the window's left edge (Plan 27).
 *
 * The sidebar beside it gets you to your work; the rail gets you to the app's pages — Home (the
 * Agents page), Library, Connections, Scheduled tasks and the notifications — and at its foot to the
 * person (their page, Settings), an update that is ready, and the Stop of a recording for Laya. It
 * is never collapsed: ⌘B folds the sidebar away and leaves this, so Home's count and the way back
 * are always on screen.
 *
 * The traffic lights sit in its top band, and — while the sidebar is folded away, so the head row that
 * carries them is gone — the window's own back and forward under them. Nothing
 * here opens a surface over the panes except the OS menu at its foot, which may (design.md: menus
 * are the system's).
 */
export function Rail() {
  // The window's back and forward are the sidebar's head row's while there is a sidebar (WindowNav).
  const collapsed = useApp((s) => s.sidebarCollapsed);
  const waiting = useApp((s) => waitingCount({ sessionStatus: s.sessionStatus, quickChatId: s.quickChat?.sessionId ?? null }));
  const unread = useApp((s) => s.notificationsUnread);
  return (
    <nav className="app-rail" aria-label="Destinations">
      {collapsed && <WindowNav />}
      <div className="rail-group">
        {/* Home's count is the one number that says something waits on you when the sidebar is away. */}
        <RailPage kind="agents-page" label="Home" icon="home" count={waiting} countLabel={`${waiting} waiting on you`}
          title="Home — every agent, by what it needs from you" />
        <RailPage kind="library-page" label="Library" />
        <RailPage kind="connections-page" label="Connections" />
        <RailPage kind="schedules-page" label="Scheduled tasks" />
        <RailPage kind="notifications-page" label="Notifications" count={unread} countLabel={`${unread} unread`} />
      </div>
      <div className="rail-foot">
        <SidebarToggle />
        <RailYou />
        <RailUpdate />
        <RailRecording />
      </div>
    </nav>
  );
}

/**
 * One destination. A click shows its page over the workspace; the button stays lit while the page is
 * up, and pressing it again puts the page away — a lit control says the state and undoes it.
 *
 * A count rides at the glyph's shoulder only while it is above zero, and in the accessible name as
 * well: a badge is the one part of the control a screen reader cannot describe by its shape.
 */
function RailPage({ kind, label, icon, count = 0, countLabel, title }: {
  kind: DestinationPageKind; label: string; icon?: IconName; count?: number; countLabel?: string; title?: string;
}) {
  const open = useApp((s) => s.pageOverlay?.kind === kind);
  const openDestinationPage = useApp((s) => s.openDestinationPage);
  const closePageOverlay = useApp((s) => s.closePageOverlay);
  return (
    <button type="button" className="rail-btn" aria-pressed={open} aria-label={count > 0 ? `${label}, ${countLabel}` : label}
      title={title ?? label} onClick={() => (open ? closePageOverlay() : openDestinationPage(kind))}>
      <span className="rail-glyph">
        <Icon name={icon ?? kind} size={18} />
        {/* Two digits is what a badge this size sets without going under the type floor; past that
            the exact number is on the page it opens. */}
        {count > 0 && <span className="sb-badge" aria-hidden="true">{count > 99 ? "99+" : count}</span>}
      </span>
    </button>
  );
}

/** The person at the foot of the rail: their own page, and Settings. */
function RailYou() {
  const userName = useApp((s) => s.userName);
  const openDestinationPage = useApp((s) => s.openDestinationPage);
  const settings = useChord("settings.open");
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  // "You" until the Mac reports a real name, never the login name.
  const name = userName.trim() || "You";
  return (
    <>
      <button ref={anchor} type="button" className="rail-btn" aria-label={name} aria-haspopup="menu" aria-expanded={open}
        title="Your page and Settings" onClick={() => setOpen((o) => !o)}>
        <Avatar size={24} />
      </button>
      {open && (
        <Menu align="left" placement="up" anchorRef={anchor} label="You" onClose={() => setOpen(false)} items={[
          { label: name, icon: <Avatar size={16} />, onSelect: () => openDestinationPage("you-page") },
          { label: "Settings", icon: <Icon name="settings" size={16} />, kbd: settings, onSelect: () => openDestinationPage("settings-page") },
        ]} />
      )}
    </>
  );
}

/**
 * An update that is downloaded and waiting for a restart — and nothing at all otherwise. Main's
 * updater says which state it is in; there is no push, so the window asks each time it comes back
 * to the front, which is when a person could act on the answer.
 */
function RailUpdate() {
  const status = useApp((s) => s.updateStatus);
  const refreshUpdateStatus = useApp((s) => s.refreshUpdateStatus);
  const installUpdate = useApp((s) => s.installUpdate);
  const windowActive = useApp((s) => s.windowActive);
  const run = useApp((s) => s.run);
  useEffect(() => { if (windowActive) run(() => refreshUpdateStatus()); }, [windowActive, refreshUpdateStatus, run]);
  if (status?.state.kind !== "downloaded") return null;
  const version = status.state.version;
  return (
    <button type="button" className="rail-btn rail-update" aria-label={`Restart to update to v${version}`}
      title={`v${version} is ready — restart to finish installing`} onClick={() => run(() => installUpdate())}>
      <Icon name="download" size={18} />
    </button>
  );
}
