import { Icon } from "@realm/ui";
import { useMemo, useRef, useState, type DragEvent } from "react";
import type { Space } from "@realm/contracts";
import { spaceIsPlainFolder, useApp, useProfileSpaces } from "../../state/store";
import { Menu, type MenuItem } from "../Menu";
import { SpaceIcon } from "../SpaceIcon";
import { reorderWithin, rowsBySpace, sectionView, spaceTally, tallyWords, type ListRow, type SessionRow, type SidebarState, type Tally } from "./model";
import { ListRowView, TallyMarks } from "./SessionRows";
import { TeamRows } from "./TeamRows";
import { useNewSessionIn, useOpenSpacePage, useOrderedSpaces, useSpaceTint } from "./use-sidebar-model";

/** What a section head carries in a drag, told apart from an item's. */
const SPACE_DRAG_TYPE = "application/x-realm-space";

/**
 * The Spaces lens: every space of the profile as a section of one list (Plan 27).
 *
 * Spaces stay — each owns the folder, connections, memory and allowlists its agents work with — but
 * as sections, not rooms: every space's sessions are on screen at once, and opening one from any
 * space opens it. A section's head names the space in its colour, says what is going on in it, and
 * folds; folded or open is remembered per space. The order is the one arranged by hand (drag a head
 * onto another), or by activity with Settings ▸ General ▸ Sidebar's "Sort spaces by activity".
 */
export function SpaceSections({ state, rows, onChanged }: { state: SidebarState; rows: SessionRow[]; onChanged: () => void }) {
  const spaces = useOrderedSpaces();
  const handOrder = useProfileSpaces();
  const all = useApp((s) => s.spaces);
  const byActivity = useApp((s) => s.sidebarActivityOrder);
  const reorderSpaces = useApp((s) => s.reorderSpaces);
  const run = useApp((s) => s.run);
  const bySpace = useMemo(() => rowsBySpace(rows), [rows]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const drop = (target: string) => {
    const from = dragId; setDragId(null); setOverId(null);
    const ids = from ? reorderWithin(all, handOrder, from, target) : null;
    if (ids) run(() => reorderSpaces(ids));
  };
  return (
    <div className="sb-sections">
      {spaces.map((sp) => (
        <SpaceSection key={sp.id} space={sp} rows={bySpace.get(sp.id) ?? []} tally={spaceTally(state, sp.id, rows)} onChanged={onChanged}
          drag={{
            // A drop into a spot the next status change would re-sort away from is a drop that did
            // nothing, so with activity order on the heads are not draggable at all.
            enabled: !byActivity, over: overId === sp.id,
            start: () => setDragId(sp.id),
            over_: (e) => { if (dragId && Array.from(e.dataTransfer.types).includes(SPACE_DRAG_TYPE)) { e.preventDefault(); if (overId !== sp.id) setOverId(sp.id); } },
            leave: () => { if (overId === sp.id) setOverId(null); },
            drop: (e) => { e.preventDefault(); drop(sp.id); },
            end: () => { setDragId(null); setOverId(null); },
          }} />
      ))}
    </div>
  );
}

type SectionDrag = {
  enabled: boolean; over: boolean; start: () => void; over_: (e: DragEvent) => void; leave: () => void;
  drop: (e: DragEvent) => void; end: () => void;
};

function SpaceSection({ space, rows, tally, onChanged, drag }: { space: Space; rows: ListRow[]; tally: Tally; onChanged: () => void; drag: SectionDrag }) {
  const team = useApp((s) => s.teams[space.id]);
  const collapsed = useApp((s) => s.sidebarCollapsedSpaces.includes(space.id));
  const setSpaceSectionCollapsed = useApp((s) => s.setSpaceSectionCollapsed);
  const run = useApp((s) => s.run);
  const openSpacePage = useOpenSpacePage();
  const setSpaceSessionsView = useApp((s) => s.setSpaceSessionsView);
  // The space's Sessions page, on the filter the opener names: "Show more" counts the live ones.
  const openSessions = (view: "active" | "archived") => { setSpaceSessionsView(space.id, view); openSpacePage(space.id, "sessions"); };
  const newSessionIn = useNewSessionIn();
  // A plain folder has no worktrees, so its ⋯ offers no session in one (store.ts).
  const plainFolder = useApp((s) => spaceIsPlainFolder(s, space.id));
  const tint = useSpaceTint(space.color);
  const [menu, setMenu] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  // Built on the first unfold and kept, so folding animates too; `inert` takes a folded row out of
  // the tab order and `aria-hidden` out of what a reader hears.
  const everOpened = useRef(!collapsed);
  everOpened.current ||= !collapsed;
  const words = tallyWords(tally);
  const said = words.length > 0 ? `${space.name} — ${words.join(", ")}` : space.name;
  const { shown, hidden } = sectionView(rows);
  const listId = `sb-section-${space.id}`;
  const reveal = window.realm?.files?.reveal;
  const items: MenuItem[] = [
    ...(plainFolder ? [] : [
      { label: "New session in a worktree", icon: <Icon name="branch" size={16} />, onSelect: () => newSessionIn(space.id, true) },
      { kind: "separator" },
    ] satisfies MenuItem[]),
    // Offered only where the desktop bridge has it — a reveal that cannot happen is not offered.
    ...(reveal ? [{ label: "Show in Finder", icon: <Icon name="folder" size={16} />, onSelect: () => { void reveal(space.folderPath); } }] : []),
    { label: "Connections", icon: <Icon name="connections-page" size={16} />, onSelect: () => openSpacePage(space.id, "connections") },
    { label: "Memory", icon: <Icon name="context" size={16} />, onSelect: () => openSpacePage(space.id, "memory") },
    // A team's home, or where a space becomes one.
    { label: team?.enabled ? "Team" : "Make this a team…", icon: <Icon name="team" size={16} />, onSelect: () => openSpacePage(space.id, "team") },
    { label: "Archived sessions", icon: <Icon name="archive" size={16} />, onSelect: () => openSessions("archived") },
    { label: "Space settings", icon: <Icon name="settings" size={16} />, onSelect: () => openSpacePage(space.id, "general") },
  ];
  return (
    <section className="sb-section" aria-label={space.name}>
      <div className="item sb-section-head" data-actions="2" data-drag-over={drag.over || undefined} draggable={drag.enabled}
        onDragStart={(e) => { e.dataTransfer.setData(SPACE_DRAG_TYPE, space.id); e.dataTransfer.effectAllowed = "move"; drag.start(); }}
        onDragOver={drag.over_} onDragLeave={drag.leave} onDrop={drag.drop} onDragEnd={drag.end}>
        <button type="button" className="item-row" aria-expanded={!collapsed} aria-controls={everOpened.current ? listId : undefined}
          aria-label={said} title={said} onClick={() => run(() => setSpaceSectionCollapsed(space.id, !collapsed))}>
          <span className="sb-caret" data-open={!collapsed || undefined}><Icon name="chevronRight" size={12} /></span>
          {/* The space's colour marks its section — one of the three places it does (Plan 27). */}
          <span className="sb-space-icon" style={tint ? { color: tint } : undefined}><SpaceIcon icon={space.icon} size={16} /></span>
          <span className="item-title">{space.name}</span>
          <span className="item-trail"><TallyMarks tally={tally} /></span>
        </button>
        <span className="item-actions">
          <button type="button" className="item-act" aria-label={`New session in ${space.name}`} title="New session here"
            onClick={() => newSessionIn(space.id)}><Icon name="add" size={12} /></button>
          <button ref={more} type="button" className="item-act" aria-label={`More for ${space.name}`} aria-haspopup="menu" aria-expanded={menu}
            title="More" onClick={() => setMenu((o) => !o)}><Icon name="more" size={12} /></button>
        </span>
      </div>
      {menu && <Menu align="right" anchorRef={more} label={space.name} onClose={() => setMenu(false)} items={items} />}
      {everOpened.current && (
        <div className="sb-section-wrap" data-open={!collapsed || undefined}>
          <div className="sb-section-clip" inert={collapsed || undefined} aria-hidden={collapsed || undefined}>
            <div className="item-list" id={listId}>
              {/* The space's team, above its sessions: Review while something waits, then the roles. */}
              {team?.enabled && <TeamRows team={team} />}
              {rows.length === 0 ? (
                // An empty space offers the shortest honest path to work in it.
                <div className="item sb-row" data-nested="" data-actions="0">
                  <button type="button" className="item-row sb-start" onClick={() => newSessionIn(space.id)}>
                    <span className="sb-gutter"><Icon name="add" size={12} /></span><span className="item-title">New session</span>
                  </button>
                </div>
              ) : shown.map((r) => <ListRowView key={r.id} row={r} nested onChanged={onChanged} />)}
              {hidden > 0 && (
                <button type="button" className="agents-more sb-more" title={`Every session in ${space.name}, on its page`}
                  onClick={() => openSessions("active")}>Show more <span className="item-count">{hidden}</span></button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
