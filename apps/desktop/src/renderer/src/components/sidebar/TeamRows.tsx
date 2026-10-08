import { Icon, Realmite, parseRealmiteSpec, type IconName, type RealmiteState } from "@realm/ui";
import { useRef } from "react";
import { itemIdOfLeaf, type ReviewKind, type TeamRole, type TeamSpace } from "@realm/contracts";
import { useApp } from "../../state/store";
import { roleMark, tallyWords, teamTally, waitingReviews } from "./model";
import { TallyMarks } from "./SessionRows";

/** A review's glyph by what it holds — the same everywhere a review is listed. */
export const REVIEW_GLYPH: Record<ReviewKind, IconName> = { slideshows: "review", message: "mail", document: "artifact", report: "report" };

/** What a role's Realmite is doing, from the role's state: its face is the run's state, never a mood. */
export function realmiteState(role: Pick<TeamRole, "state">): RealmiteState {
  return role.state === "working" ? "working" : role.state === "waiting" ? "needs-you" : role.state === "paused" ? "sleeping" : "idle";
}

/** A role's state as a reader hears it — a row's tooltip and accessible name. */
export function roleStateWords(role: TeamRole, now = Date.now()): string {
  if (role.state === "working") return "Working";
  if (role.state === "waiting") return "Waiting on you";
  if (role.state === "queued") return "Waiting for a free slot";
  if (role.state === "paused") return `Paused — ${role.pausedWhy ?? "its budget is spent"}`;
  if (role.nextRunAt && role.nextRunAt > now) {
    const d = new Date(role.nextRunAt);
    const day = d.toDateString() === new Date(now).toDateString() ? "today" : d.toLocaleDateString(undefined, { weekday: "short" });
    return `Next run ${day} ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  }
  return "Idle";
}

/**
 * A team inside its space's section (the Teams plan, 13.3): a Review row while something waits, and
 * a Team row that folds like a fan-out to show the roles. A role row nests one step deeper than a
 * session and wears its Realmite in the gutter where a scheduled session wears its clock; its far end
 * is the mark sessions use, and it never shows a time — the next run is in its tooltip.
 */
export function TeamRows({ team }: { team: TeamSpace }) {
  const waiting = waitingReviews(team);
  return (
    <>
      {waiting.length > 0 && <ReviewRow spaceId={team.spaceId} count={waiting.length} firstId={waiting[0]!.id} />}
      {team.roles.length > 0 && <TeamFold team={team} />}
    </>
  );
}

function ReviewRow({ spaceId, count, firstId }: { spaceId: string; count: number; firstId: string }) {
  const openTeamReview = useApp((s) => s.openTeamReview);
  const run = useApp((s) => s.run);
  const focused = useApp((s) => {
    const id = s.layout ? itemIdOfLeaf(s.layout, s.focusedLeafId) : null;
    const it = id ? s.items.find((i) => i.id === id) : undefined;
    return it?.kind === "review" && it.refId === spaceId && !s.pageOverlay;
  });
  const said = `Review — ${count} waiting on you`;
  return (
    <div className="item sb-row" data-nested="" data-active={focused || undefined} data-actions="0">
      <button type="button" className="item-row" aria-label={said} title={said} onClick={() => run(() => openTeamReview(spaceId, firstId))}>
        <span className="sb-gutter"><Icon name="review" size={12} /></span>
        <span className="item-title">Review</span>
        <span className="item-trail">
          <span className="item-tally"><span className="item-count">{count}</span><span className="status-dot item-status" data-status="waiting_permission" /></span>
        </span>
      </button>
    </div>
  );
}

function TeamFold({ team }: { team: TeamSpace }) {
  const folded = useApp((s) => s.sidebarTeamFolded.includes(team.spaceId));
  const setTeamFolded = useApp((s) => s.setTeamFolded);
  const openSpacePage = useApp((s) => s.openSpacePage);
  const run = useApp((s) => s.run);
  const tally = teamTally(team);
  const words = tallyWords(tally);
  const said = `Team — ${team.roles.length} role${team.roles.length === 1 ? "" : "s"}${words.length ? `, ${words.join(", ")}` : ""}`;
  const listId = `sb-team-${team.spaceId}`;
  // Built on the first unfold and kept, so folding animates too (the section's own pattern).
  const everOpened = useRef(!folded);
  everOpened.current ||= !folded;
  return (
    <>
      <div className="item sb-row sb-team-head" data-nested="" data-actions="1">
        <button type="button" className="item-row" aria-expanded={!folded} aria-controls={everOpened.current ? listId : undefined}
          aria-label={said} title={said} onClick={() => run(() => setTeamFolded(team.spaceId, !folded))}>
          <span className="sb-gutter"><span className="sb-caret" data-open={!folded || undefined}><Icon name="chevronRight" size={12} /></span></span>
          <span className="item-title">Team</span>
          <span className="item-trail"><TallyMarks tally={tally} /></span>
        </button>
        <span className="item-actions">
          <button type="button" className="item-act" aria-label="Open the team's page" title="Team page"
            onClick={() => openSpacePage(team.spaceId, "team")}><Icon name="team" size={12} /></button>
        </span>
      </div>
      {everOpened.current && (
        <div className="sb-section-wrap" data-open={!folded || undefined}>
          <div className="sb-section-clip" inert={folded || undefined} aria-hidden={folded || undefined}>
            <div className="item-list sb-team-roles" id={listId}>
              {team.roles.map((r) => <RoleRow key={r.id} role={r} />)}
              <AddTeammateRow spaceId={team.spaceId} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** The fold's last row: who else joins, by the same picker the team's page opens. Quieter than a role,
 *  because it is a way to add one, not one of them. */
function AddTeammateRow({ spaceId }: { spaceId: string }) {
  const openSheet = useApp((s) => s.openSheet);
  return (
    <div className="item sb-row sb-team-add" data-nested="" data-actions="0">
      <button type="button" className="item-row" title="Add a teammate to this team" onClick={() => openSheet({ kind: "add-teammates", spaceId })}>
        <span className="sb-gutter"><Icon name="add" size={12} /></span>
        <span className="item-title">Add teammate</span>
      </button>
    </div>
  );
}

function RoleRow({ role }: { role: TeamRole }) {
  const openSpacePage = useApp((s) => s.openSpacePage);
  const openItemBeside = useApp((s) => s.openItemBeside);
  const revealSession = useApp((s) => s.revealSession);
  const sessionItem = useApp((s) => (role.latestSessionId ? [...s.items, ...s.allItems].find((i) => i.kind === "session" && i.refId === role.latestSessionId) : undefined));
  const lit = useApp((s) => s.pageOverlay?.kind === "space-page" && s.pageOverlay.refId === role.spaceId && s.spacePageTab[role.spaceId] === `role:${role.id}`);
  const run = useApp((s) => s.run);
  const mark = roleMark(role);
  const words = roleStateWords(role);
  // ⌘-click opens its latest run beside the pane in focus, the way ⌘ opens a session row beside.
  const open = (beside: boolean) => {
    if (beside && sessionItem) return run(() => openItemBeside(sessionItem.id));
    if (beside && role.latestSessionId) return run(() => revealSession(role.latestSessionId!, role.spaceId).then(() => undefined));
    openSpacePage(role.spaceId, `role:${role.id}`);
  };
  return (
    <div className="item sb-row sb-role-row" data-nested="" data-active={lit || undefined} data-unread={mark?.mark === "unseen" || undefined} data-actions="0">
      <button type="button" className="item-row" aria-label={`${role.name} — ${mark?.label ?? words.toLowerCase()}`} title={`${role.name} · ${words}`}
        onClick={(e) => open(e.metaKey)}>
        <span className="sb-gutter sb-realmite"><Realmite spec={parseRealmiteSpec(role.realmite, role.id)} size={16} state={realmiteState(role)} /></span>
        <span className="item-title">{role.name}</span>
        <span className="item-trail">{mark && <span className="status-dot item-status" data-status={mark.mark} />}</span>
      </button>
    </div>
  );
}
