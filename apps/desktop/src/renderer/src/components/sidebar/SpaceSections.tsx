import { Icon } from "@realm/ui";
import { useMemo } from "react";
import type { Space } from "@realm/contracts";
import { useApp, useProfileSpaces } from "../../state/store";
import { teammateOfHome } from "../../state/teammates-slice";
import { newestRows, pinnedItems, SECTION_ROWS, type SessionRow, type SidebarState } from "./model";
import { ListRowView } from "./SessionRows";
import { TeamSection } from "./TeamSection";
import { useNewSessionIn } from "./use-sidebar-model";

/**
 * The space the column shows (direction A): its team, then its sessions. One space at a time — the
 * rail's tiles change which — so nothing here is a section of a longer list, and the space's name is
 * the column's title (`SpaceTitle`), not a head of its own.
 */
export function SpaceSections({ state, rows, onChanged }: { state: SidebarState; rows: SessionRow[]; onChanged: () => void }) {
  const space = useApp((s) => s.spaces.find((sp) => sp.id === s.activeSpaceId));
  const spaces = useProfileSpaces();
  const teammates = useApp((s) => s.teammates);
  // Pinned teammates stand in the pinned row instead of the team list.
  const pinned = useMemo(() => new Set(pinnedItems(state, spaces).flatMap((i) => {
    const mate = i.kind === "session" ? teammateOfHome(teammates, i.refId, i.spaceId) : null;
    return mate ? [mate.id] : [];
  })), [state, spaces, teammates]);
  if (!space) return null;
  return (
    <section className="sb-section" key={space.id} aria-label={space.name}>
      <TeamSection spaceId={space.id} pinned={pinned} />
      <SpaceSessions space={space} rows={rows.filter((r) => r.spaceId === space.id)} onChanged={onChanged} />
    </section>
  );
}

/**
 * The space's own sessions — the ones no teammate started — under a "Sessions" caption: the five that
 * moved last, then "Show all N", which opens every session by time (the Activity view). An empty
 * space offers the shortest honest ways into it instead: a session, or — while it has none — a
 * teammate.
 */
function SpaceSessions({ space, rows, onChanged }: { space: Space; rows: SessionRow[]; onChanged: () => void }) {
  const newSessionIn = useNewSessionIn();
  const openSheet = useApp((s) => s.openSheet);
  const setSidebarLens = useApp((s) => s.setSidebarLens);
  const run = useApp((s) => s.run);
  const hasTeam = useApp((s) => (s.teammates[space.id]?.length ?? 0) > 0);
  const shown = useMemo(() => newestRows(rows), [rows]);
  if (rows.length === 0) {
    return (
      <div className="item-list">
        <div className="item sb-row" data-actions="0">
          <button type="button" className="item-row sb-start" onClick={() => newSessionIn(space.id)}>
            <Icon name="add" size={16} /><span className="item-title">New session</span>
          </button>
        </div>
        {!hasTeam && (
          <div className="item sb-row" data-actions="0">
            <button type="button" className="item-row sb-start" onClick={() => openSheet({ kind: "teammate", spaceId: space.id })}>
              <Icon name="team" size={16} /><span className="item-title">Add a teammate</span>
            </button>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="sb-sessions" role="group" aria-label="Sessions">
      <div className="group-label">Sessions</div>
      <div className="item-list">
        {shown.map((r) => <ListRowView key={r.id} row={r} onChanged={onChanged} />)}
      </div>
      {rows.length > SECTION_ROWS && (
        <button type="button" className="agents-more sb-more" title="Every session, by when it last moved"
          onClick={() => run(() => setSidebarLens("recent"))}>Show all {rows.length}</button>
      )}
    </div>
  );
}
