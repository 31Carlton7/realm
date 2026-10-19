import { Icon, Realmite, parseRealmiteSpec } from "@realm/ui";
import type { TeamReviewSummary, TeamRole, TeamSpace } from "@realm/contracts";
import { realmiteState, reviewGlyph } from "../../../components/sidebar/TeamRows";

/** The role a review came from: a current role, one removed from the team since, or none. */
export function reviewRole(team: TeamSpace | undefined, roleId: string | null): { id: string; name: string; realmite: unknown; live: TeamRole | null } | null {
  if (!team || !roleId) return null;
  const live = team.roles.find((r) => r.id === roleId) ?? null;
  if (live) return { id: live.id, name: live.name, realmite: live.realmite, live };
  const former = team.formerRoles.find((r) => r.id === roleId);
  return former ? { id: former.id, name: former.name, realmite: former.realmite, live: null } : null;
}

/**
 * Who made a draft, drawn as its role's Realmite — its face the role's run state, never a mood
 * (design.md) — or, for work a session sent without a role, the draft's own glyph on a quiet disc.
 * Decoration beside the role's name, so it carries no name of its own.
 */
export function RoleMark({ team, review, size }: { team: TeamSpace | undefined; review: Pick<TeamReviewSummary, "roleId" | "kind" | "format">; size: 16 | 24 | 32 }) {
  const role = reviewRole(team, review.roleId);
  if (!role) return <span className="rv-mark rv-mark-glyph" data-size={size} aria-hidden="true"><Icon name={reviewGlyph(review)} size={size >= 32 ? 16 : 12} /></span>;
  return (
    <span className="rv-mark" data-size={size} aria-hidden="true">
      <Realmite spec={parseRealmiteSpec(role.realmite, role.id)} size={size} state={role.live ? realmiteState(role.live) : "idle"} />
    </span>
  );
}
