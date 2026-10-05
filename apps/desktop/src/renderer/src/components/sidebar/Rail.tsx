import { Icon, type IconName } from "@realm/ui";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { DestinationPageKind } from "@realm/contracts";
import { useApp } from "../../state/store";
import { Avatar } from "../Avatar";
import { Menu } from "../Menu";
import { waitingCount } from "./model";
import { useChord } from "./use-sidebar-model";

/**
 * The rail: the app's destinations as a column of icons at the window's left edge (Plan 27).
 *
 * The sidebar beside it gets you to your work; the rail gets you to the app's pages — Home (the
 * Agents page), Library, Connections, Scheduled tasks and the notifications — and at its foot to a
 * newer Realm and to the person (their page, Settings). It is never collapsed: ⌘B folds the sidebar
 * away and leaves this, so Home's count is always on screen.
 *
 * As narrow as its icons and an even margin round them, Codex's: the traffic lights are wider than it
 * and run on across the top row, which is the window's (WindowLead) rather than this column's. Nothing
 * here opens a surface over the panes except the OS menu at its foot, which may (design.md: menus are
 * the system's).
 */
export function Rail() {
  const waiting = useApp((s) => waitingCount({ sessionStatus: s.sessionStatus, quickChatId: s.quickChat?.sessionId ?? null }));
  const unread = useApp((s) => s.notificationsUnread);
  return (
    <nav className="app-rail" aria-label="Destinations">
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
        <RailUpdate />
        <RailYou />
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
 * A newer Realm, at the foot of the rail: the accent disc Codex keeps in the same place. Shown
 * whenever main's updater knows of a newer version, and nothing at all otherwise — a control for an
 * update that does not exist is the dead chrome this rail refuses.
 *
 * Each state offers only what it can do. An `available` update (its background download failed)
 * starts the download again. One that is downloading has nothing to press — waiting is the whole of
 * it — so it is a progress bar, its share drawn round the disc once main has said how far it is. A
 * downloaded one restarts into it, and wears the restart glyph rather than the download arrow, so
 * the disc says which of the two a click will do before it is hovered. The version is in every
 * name, because "an update" is not something a person can decide about.
 *
 * Main pushes every change (`updates:changed`), which is what moves the ring; the window also asks
 * when it comes to the front, the one moment a missed push would matter.
 */
function RailUpdate() {
  const status = useApp((s) => s.updateStatus);
  const refreshUpdateStatus = useApp((s) => s.refreshUpdateStatus);
  const watchUpdateStatus = useApp((s) => s.watchUpdateStatus);
  const downloadUpdate = useApp((s) => s.downloadUpdate);
  const installUpdate = useApp((s) => s.installUpdate);
  const windowActive = useApp((s) => s.windowActive);
  const run = useApp((s) => s.run);
  useEffect(() => watchUpdateStatus(), [watchUpdateStatus]);
  useEffect(() => { if (windowActive) run(() => refreshUpdateStatus()); }, [windowActive, refreshUpdateStatus, run]);
  const st = status?.state;
  if (!st || (st.kind !== "available" && st.kind !== "downloading" && st.kind !== "downloaded")) return null;
  const version = `v${st.version}`;
  if (st.kind === "downloading") {
    const percent = st.percent === null ? null : Math.round(st.percent);
    return (
      <span className="rail-btn rail-update" data-state="downloading" role="progressbar" aria-label={`Downloading Realm ${version}`}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}
        title={percent === null ? `Downloading Realm ${version}…` : `Downloading Realm ${version} — ${percent}%`}
        style={percent === null ? undefined : ({ "--update-progress": `${percent}%` } as CSSProperties)}>
        <span className="rail-update-disc"><Icon name="download" size={14} /></span>
      </span>
    );
  }
  const ready = st.kind === "downloaded";
  return (
    <button type="button" className="rail-btn rail-update" data-state={st.kind}
      aria-label={ready ? `Restart to update to Realm ${version}` : `Download Realm ${version}`}
      title={ready ? `Realm ${version} is ready — restart to finish installing` : `Realm ${version} is available — download it`}
      onClick={() => run(() => (ready ? installUpdate() : downloadUpdate()))}>
      <span className="rail-update-disc"><Icon name={ready ? "reload" : "download"} size={14} /></span>
    </button>
  );
}
