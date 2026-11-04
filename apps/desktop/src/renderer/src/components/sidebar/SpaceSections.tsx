import { Icon } from "@realm/ui";
import { useMemo } from "react";
import type { Space } from "@realm/contracts";
import { useApp } from "../../state/store";
import { rowsBySpace, sectionView, type ListRow, type SessionRow } from "./model";
import { ListRowView } from "./SessionRows";
import { ListCaption, TeamSection } from "./TeamSection";
import { useNewSessionIn, useOpenSpacePage } from "./use-sidebar-model";

/**
 * The space the column shows (direction A): its team, then its sessions. One space at a time — the
 * rail's tiles change which — so nothing here is a section of a longer list, and the space's name is
 * the column's title (`SpaceTitle`), not a head of its own.
 */
export function SpaceSections({ rows, onChanged }: { rows: SessionRow[]; onChanged: () => void }) {
  const space = useApp((s) => s.spaces.find((sp) => sp.id === s.activeSpaceId));
  const bySpace = useMemo(() => rowsBySpace(rows), [rows]);
  if (!space) return null;
  return <SpaceSection key={space.id} space={space} rows={bySpace.get(space.id) ?? []} onChanged={onChanged} />;
}

function SpaceSection({ space, rows, onChanged }: { space: Space; rows: ListRow[]; onChanged: () => void }) {
  const openSpacePage = useOpenSpacePage();
  const setSpaceSessionsView = useApp((s) => s.setSpaceSessionsView);
  // The space's Sessions page: "Show more" counts the live ones.
  const openSessions = () => { setSpaceSessionsView(space.id, "active"); openSpacePage(space.id, "sessions"); };
  const newSessionIn = useNewSessionIn();
  const openSheet = useApp((s) => s.openSheet);
  const hasTeam = useApp((s) => (s.teammates[space.id]?.length ?? 0) > 0);
  // Only a space with a team heads its sessions with a caption, so only there can they fold away.
  const sessionsFolded = useApp((s) => hasTeam && s.sidebarFoldedLists.includes(`${space.id}/sessions`));
  const addTeammate = () => openSheet({ kind: "teammate", spaceId: space.id });
  const { shown, hidden } = sectionView(rows);
  return (
    <section className="sb-section" aria-label={space.name}>
      <div className="item-list">
        {/* The space's teammates head it, above its sessions. */}
        <TeamSection spaceId={space.id} />
        {hasTeam && rows.length > 0 && <ListCaption spaceId={space.id} list="sessions" label="Sessions" folded={sessionsFolded} />}
        {rows.length === 0 ? (
          // An empty space offers the shortest honest paths to work in it: a session, or — while
          // it has none — a teammate.
          <>
            <div className="item sb-row" data-nested="" data-actions="0">
              <button type="button" className="item-row sb-start" onClick={() => newSessionIn(space.id)}>
                <span className="sb-gutter"><Icon name="add" size={12} /></span><span className="item-title">New session</span>
              </button>
            </div>
            {!hasTeam && (
              <div className="item sb-row" data-nested="" data-actions="0">
                <button type="button" className="item-row sb-start" onClick={addTeammate}>
                  <span className="sb-gutter"><Icon name="team" size={12} /></span><span className="item-title">Add a teammate</span>
                </button>
              </div>
            )}
          </>
        ) : !sessionsFolded && shown.map((r) => <ListRowView key={r.id} row={r} nested onChanged={onChanged} />)}
        {!sessionsFolded && hidden > 0 && (
          <button type="button" className="agents-more sb-more" title={`Every session in ${space.name}, on its page`}
            onClick={() => openSessions()}>Show more <span className="item-count">{hidden}</span></button>
        )}
      </div>
    </section>
  );
}
