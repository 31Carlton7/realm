import { Icon } from "@realm/ui";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent } from "react";
import type { DestinationPageKind, Space } from "@realm/contracts";
import { useApp, useProfileSpaces } from "../../state/store";
import { Avatar } from "../Avatar";
import { useDissolve } from "../ScrollFades";
import { Menu } from "../Menu";
import { SpaceIcon } from "../SpaceIcon";
import { needsYou, profileWaiting, reorderWithin } from "./model";
import { RailRecording } from "./RailRecording";
import { useSpaceMenu } from "./space-menu";
import { useChord, useOrderedSpaces, useSidebarState, useSpaceTint } from "./use-sidebar-model";

/** What a space tile carries in a drag, told apart from an item's. */
const SPACE_DRAG_TYPE = "application/x-realm-space";

/**
 * The rail: the app's destinations as a column of icons at the window's left edge (Plan 27), then the
 * profile's spaces, as Slack keeps its workspaces.
 *
 * The rail gets you to the app's pages — Library, Connections, Scheduled tasks and Code review, with
 * Home above them as the way back — then, under a divider, to each space of the profile on screen:
 * the column beside it shows one space at a time, and a tile is how you change which. At its foot are
 * the Stop of a recording for Laya, Laya's install while it runs, a newer Realm, what this one
 * brought, and the person, whose menu switches profile. It is never collapsed: ⌘B folds the sidebar
 * away and leaves this.
 *
 * As narrow as its icons and an even margin round them, Codex's: the traffic lights are wider than it
 * and run on across the top row, which is the window's (WindowLead) rather than this column's. Nothing
 * here opens a surface over the panes except the OS menu at its foot, which may (design.md: menus are
 * the system's).
 */
export function Rail() {
  return (
    <nav className="app-rail" aria-label="Destinations">
      <div className="rail-group">
        <RailHome />
        <RailPage kind="library-page" label="Library" />
        <RailPage kind="connections-page" label="Connections" />
        <RailPage kind="schedules-page" label="Scheduled tasks" />
        <RailPage kind="code-review-page" label="Code review" />
      </div>
      <RailSpaces />
      <div className="rail-foot">
        {/* The two that wear a state, then the person, at the very foot as Codex keeps them. */}
        <RailRecording />
        <RailLaya />
        <RailUpdate />
        <RailWhatsNew />
        <RailProfile />
      </div>
    </nav>
  );
}

/**
 * Home: the way back to the work from wherever the rail has taken you (`goHome`). Not a page, so not
 * a toggle — it is never lit, and it carries no count: a session that needs you says so on its own
 * row, and the Dock's badge keeps the count of what came in while you were away.
 */
function RailHome() {
  const goHome = useApp((s) => s.goHome);
  const run = useApp((s) => s.run);
  return (
    <button type="button" className="rail-btn" aria-label="Home" title="Back to your sessions" onClick={() => run(() => goHome())}>
      <span className="rail-glyph"><Icon name="home" size={18} /></span>
    </button>
  );
}

/**
 * One destination. A click shows its page over the workspace; the button stays lit while the page is
 * up, and pressing it again puts the page away — a lit control says the state and undoes it.
 *
 * A count rides at the glyph's shoulder only while it is above zero, and in the accessible name as
 * well: a badge is the one part of the control a screen reader cannot describe by its shape.
 */
function RailPage({ kind, label, count = 0, countLabel }: {
  kind: DestinationPageKind; label: string; count?: number; countLabel?: string;
}) {
  const open = useApp((s) => s.pageOverlay?.kind === kind);
  const openDestinationPage = useApp((s) => s.openDestinationPage);
  const closePageOverlay = useApp((s) => s.closePageOverlay);
  return (
    <button type="button" className="rail-btn" aria-pressed={open} aria-label={count > 0 ? `${label}, ${countLabel}` : label}
      title={label} onClick={() => (open ? closePageOverlay() : openDestinationPage(kind))}>
      <span className="rail-glyph">
        <Icon name={kind} size={18} />
        {/* Two digits is what a badge this size sets without going under the type floor; past that
            the exact number is on the page it opens. */}
        {count > 0 && <span className="sb-badge" aria-hidden="true">{count > 99 ? "99+" : count}</span>}
      </span>
    </button>
  );
}

/**
 * What's new in this version, just above the person: the sheet that opened after the update, opened
 * again (WhatsNewSheet). Not a toggle — the sheet is modal and carries its own close — so never lit.
 * Absent where there is no bridge to read the notes from, rather than a button that opens nothing.
 */
function RailWhatsNew() {
  const openSheet = useApp((s) => s.openSheet);
  if (!window.realm?.whatsNew) return null;
  return (
    <button type="button" className="rail-btn" aria-label="What's new" title="What's new in this version of Realm"
      onClick={() => openSheet({ kind: "whats-new" })}>
      <span className="rail-glyph"><Icon name="gift" size={18} /></span>
    </button>
  );
}

/**
 * The profile's spaces, one tile each, under a divider, then New space (direction A, the owner
 * 11-03). A tile is the space's icon in its colour, lit while the column shows that space, with the
 * count of its Needs you rows at its shoulder — the only colour a tile ever adds. A click shows
 * the space in the column (`selectSpace`); a right-click offers what the column's title does about
 * it. Tiles drag onto each other to reorder, unless Settings sorts spaces by activity, where a drop
 * would be undone by the next status change.
 */
function RailSpaces() {
  const spaces = useOrderedSpaces();
  const handOrder = useProfileSpaces();
  const all = useApp((s) => s.spaces);
  const byActivity = useApp((s) => s.sidebarActivityOrder);
  const reorderSpaces = useApp((s) => s.reorderSpaces);
  const openSheet = useApp((s) => s.openSheet);
  const run = useApp((s) => s.run);
  const state = useSidebarState();
  const waiting = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of needsYou(state)) counts.set(r.spaceId, (counts.get(r.spaceId) ?? 0) + 1);
    return counts;
  }, [state]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  useDissolve(scroller);
  const drop = (target: string) => {
    const from = dragId; setDragId(null); setOverId(null);
    const ids = from ? reorderWithin(all, handOrder, from, target) : null;
    if (ids) run(() => reorderSpaces(ids));
  };
  return (
    <div className="rail-spaces" role="group" aria-label="Spaces" ref={scroller}>
      <span className="rail-divider" aria-hidden="true" />
      {spaces.map((sp) => (
        <RailSpace key={sp.id} space={sp} waiting={waiting.get(sp.id) ?? 0} draggable={!byActivity} over={overId === sp.id}
          onDragStart={() => setDragId(sp.id)} onDragEnd={() => { setDragId(null); setOverId(null); }}
          onDragOver={(e) => {
            if (!dragId || !Array.from(e.dataTransfer.types).includes(SPACE_DRAG_TYPE)) return;
            e.preventDefault();
            if (overId !== sp.id) setOverId(sp.id);
          }}
          onDrop={(e) => { e.preventDefault(); drop(sp.id); }} />
      ))}
      <button type="button" className="rail-btn rail-new-space" aria-label="New space" title="New space"
        onClick={() => openSheet({ kind: "new-space" })}>
        <span className="rail-glyph"><Icon name="add" size={16} /></span>
      </button>
    </div>
  );
}

function RailSpace({ space, waiting, draggable, over, onDragStart, onDragEnd, onDragOver, onDrop }: {
  space: Space; waiting: number; draggable: boolean; over: boolean;
  onDragStart: () => void; onDragEnd: () => void; onDragOver: (e: DragEvent) => void; onDrop: (e: DragEvent) => void;
}) {
  const current = useApp((s) => s.activeSpaceId === space.id);
  const selectSpace = useApp((s) => s.selectSpace);
  const run = useApp((s) => s.run);
  const tint = useSpaceTint(space.color);
  const menu = useSpaceMenu(space);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const said = waiting > 0 ? `${space.name}, ${waiting} ${waiting === 1 ? "needs" : "need"} you` : space.name;
  const onContextMenu = (e: MouseEvent) => { e.preventDefault(); setMenuAt({ x: e.clientX, y: e.clientY }); };
  return (
    <>
      <button type="button" className="rail-btn rail-space" aria-pressed={current} aria-label={said} title={said}
        data-drag-over={over || undefined} draggable={draggable}
        onDragStart={(e) => { e.dataTransfer.setData(SPACE_DRAG_TYPE, space.id); e.dataTransfer.effectAllowed = "move"; onDragStart(); }}
        onDragEnd={onDragEnd} onDragOver={onDragOver} onDrop={onDrop}
        onContextMenu={onContextMenu} onClick={() => run(() => selectSpace(space.id))}>
        <span className="rail-glyph">
          <span className="rail-space-tile" style={tint ? { color: tint } : undefined}><SpaceIcon icon={space.icon} size={18} /></span>
          {waiting > 0 && <span className="sb-badge" aria-hidden="true">{waiting > 99 ? "99+" : waiting}</span>}
        </span>
      </button>
      {menuAt && <Menu at={menuAt} label={space.name} onClose={() => setMenuAt(null)} items={menu} />}
    </>
  );
}

/**
 * The person at the foot of the rail, and the profile switch, as Slack and Discord keep it there.
 *
 * Switching profile is rare and deliberate — Work, Personal, School — so it is one menu: each profile
 * with its mark and a check on the one showing, New profile…, then the person's own page and
 * Settings. A profile with something waiting says so on its row, and while one you are not looking at
 * does, the avatar wears the amber dot: nothing waits unseen because it is in another profile. A
 * profile with no spaces is listed but not selectable — `selectProfile` has nothing to land on.
 */
function RailProfile() {
  const userName = useApp((s) => s.userName);
  const activeProfileId = useApp((s) => s.activeProfileId);
  const switchProfile = useApp((s) => s.switchProfile);
  const openNewProfileSheet = useApp((s) => s.openNewProfileSheet);
  const openProfilePage = useApp((s) => s.openProfilePage);
  const openDestinationPage = useApp((s) => s.openDestinationPage);
  const run = useApp((s) => s.run);
  const settings = useChord("settings.open");
  const state = useSidebarState();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  // "You" until the Mac reports a real name, never the login name.
  const name = userName.trim() || "You";
  const { profiles, spaces } = state;
  const spaceCount = (id: string) => spaces.filter((sp) => sp.profileId === id).length;
  const waitingIn = (id: string) => (id === activeProfileId ? 0 : profileWaiting(state, id));
  const elsewhere = profiles.reduce((n, p) => n + waitingIn(p.id), 0);
  const active = profiles.find((p) => p.id === activeProfileId);
  const label = (id: string, profileName: string): string => {
    if (spaceCount(id) === 0) return `${profileName} (no spaces)`;
    const n = waitingIn(id);
    return n === 0 ? profileName : `${profileName} · ${n} ${n === 1 ? "needs" : "need"} you`;
  };
  const said = [name, active ? `profile ${active.name}` : "", elsewhere > 0 ? `${elsewhere} waiting in another profile` : ""].filter(Boolean).join(", ");
  return (
    <>
      <button ref={anchor} type="button" className="rail-btn" aria-label={said} aria-haspopup="menu" aria-expanded={open}
        title={elsewhere > 0 ? "Profiles and Settings. Another profile needs you." : "Profiles and Settings"} onClick={() => setOpen((o) => !o)}>
        <Avatar size={24} />
        {elsewhere > 0 && <span className="rail-you-dot" aria-hidden="true" />}
      </button>
      {open && (
        <Menu align="left" placement="up" anchorRef={anchor} label="Profiles" onClose={() => setOpen(false)} items={[
          ...profiles.map((p) => ({
            label: label(p.id, p.name),
            icon: <span className="sb-profile-mark" style={{ color: p.color }}><SpaceIcon icon={p.icon || "user"} size={16} /></span>,
            checked: p.id === activeProfileId,
            disabled: spaceCount(p.id) === 0,
            onSelect: () => run(() => switchProfile(p.id)),
          })),
          { kind: "separator" as const },
          { label: "New profile…", icon: <Icon name="add" size={16} />, onSelect: () => openNewProfileSheet() },
          { label: "Profile settings…", icon: <Icon name="profile-page" size={16} />, onSelect: () => openProfilePage("general") },
          { kind: "separator" as const },
          { label: name, icon: <Avatar size={16} />, onSelect: () => openDestinationPage("you-page") },
          { label: "Settings", icon: <Icon name="settings" size={16} />, kbd: settings, onSelect: () => openDestinationPage("settings-page") },
        ]} />
      )}
    </>
  );
}

/**
 * Laya installing, at the foot of the rail — and nothing at all otherwise. Laya installs itself in the
 * background, a couple of gigabytes over minutes, and this is the quiet place that says so outside
 * Settings: a glyph in quiet ink, not the accent the update's disc wears, because nothing here wants
 * a click. The download of the checkpoint, the one step with a size, runs round it as the update's
 * share does. A click opens Settings ▸ Engines, where the install narrates its steps.
 */
function RailLaya() {
  const r = useApp((s) => s.laya?.runtime ?? null);
  const openSettingsPage = useApp((s) => s.openSettingsPage);
  if (r?.state !== "installing") return null;
  const percent = r.step === "model" && r.fraction !== null ? Math.round(r.fraction * 100) : null;
  const what = percent === null ? `Installing Laya: ${r.detail}` : `Installing Laya: checkpoint ${percent}% downloaded`;
  return (
    <button type="button" className="rail-btn rail-laya" aria-label={what} title={`${what}. Click for Settings.`}
      data-measured={percent === null ? undefined : ""}
      style={percent === null ? undefined : ({ "--update-progress": `${percent}%` } as CSSProperties)}
      onClick={() => openSettingsPage("engines")}>
      <span className="rail-laya-disc"><Icon name="cpu" size={14} /></span>
    </button>
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
