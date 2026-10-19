import { ROLE_TEMPLATES, parseBlockRequest, type RoleRun, type TeamReviewSummary, type TeamRole, type TeamSpace } from "@realm/contracts";

/** What a chat's row says under the teammate's name, and how loudly. */
export type ChatPreview = { text: string; ts: number | null; tone: "them" | "you" | "quiet" | "needs" | "working" };

/** A role's job in a line: its starter's blurb, or the first sentence of its brief. */
export function roleBlurb(role: Pick<TeamRole, "template" | "brief">): string {
  return ROLE_TEMPLATES.find((t) => t.id === role.template)?.blurb ?? firstSentence(role.brief);
}

/** The starter a teammate was made from, when its name is not already that: "Ava" made as a Researcher. */
export function roleKind(role: Pick<TeamRole, "template" | "name">): string | null {
  const name = ROLE_TEMPLATES.find((t) => t.id === role.template)?.name;
  return name && name.toLowerCase() !== role.name.toLowerCase() ? name : null;
}

export function firstSentence(s: string): string {
  const t = s.trim().split("\n").find((l) => l.trim())?.trim() ?? "";
  const cut = t.search(/[.!?](\s|$)/);
  return (cut > 0 ? t.slice(0, cut + 1) : t).replace(/`/g, "");
}

/** The role's drafts waiting for the person's yes, oldest first. */
export function waitingDrafts(role: Pick<TeamRole, "id">, reviews: readonly TeamReviewSummary[]): TeamReviewSummary[] {
  return reviews.filter((r) => r.roleId === role.id && r.state === "waiting").sort((a, b) => a.createdAt - b.createdAt);
}

/** The teammate needs the person: a run parked on them, or a draft waiting for a yes. */
export function needsYou(role: Pick<TeamRole, "id" | "state">, reviews: readonly TeamReviewSummary[]): boolean {
  return role.state === "waiting" || waitingDrafts(role, reviews).length > 0;
}

/**
 * The line under a chat's name. What is going on now comes first — working, a question, a draft
 * waiting — then the newest thing said, the teammate's report or the person's own message, then what
 * the teammate is for when nothing has been said yet.
 */
export function chatPreview(role: TeamRole, runs: readonly RoleRun[] | undefined, reviews: readonly TeamReviewSummary[]): ChatPreview {
  const latest = runs?.[0];
  if (role.state === "working") return { text: "Working…", ts: role.stateSince, tone: "working" };
  const asking = runs?.find((r) => r.state === "blocked");
  if (asking) return { text: `Asks: ${parseBlockRequest(asking.report ?? null) ?? "it needs you"}`, ts: asking.startedAt ?? asking.createdAt, tone: "needs" };
  if (role.state === "waiting") return { text: "Waiting on you in its session", ts: role.stateSince, tone: "needs" };
  const draft = waitingDrafts(role, reviews).at(-1);
  if (draft && (!latest || draft.updatedAt >= (latest.settledAt ?? latest.createdAt))) return { text: `Sent “${draft.title}” for your yes`, ts: draft.updatedAt, tone: "needs" };
  if (!latest) return { text: roleBlurb(role), ts: null, tone: "quiet" };
  if (latest.state === "queued") return { text: latest.wokeNote ? `You: ${oneLine(latest.wokeNote)}` : "Waiting for a free slot", ts: latest.createdAt, tone: "you" };
  if (latest.report) return { text: oneLine(latest.report), ts: latest.settledAt ?? latest.createdAt, tone: "them" };
  if (latest.stoppedAtCap) return { text: `Stopped at its ${latest.stoppedAtCap === "usd" ? "dollar" : "time"} limit`, ts: latest.settledAt ?? latest.createdAt, tone: "quiet" };
  if (latest.state === "failed" || latest.state === "expired") return { text: "Its run ended", ts: latest.settledAt ?? latest.createdAt, tone: "quiet" };
  if (latest.wokeNote) return { text: `You: ${oneLine(latest.wokeNote)}`, ts: latest.createdAt, tone: "you" };
  return { text: roleBlurb(role), ts: latest.settledAt ?? latest.createdAt, tone: "quiet" };
}

/** The first line with words in it, without Markdown's heading marks or the line that parks a run. */
function oneLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !/^NEEDS-HUMAN:/i.test(l));
  return (lines[0] ?? "").replace(/^#+\s*/, "").replace(/[*_`]/g, "");
}

/**
 * The chat the team opens on: the teammate that needs the person, then one that is working, then one
 * with something unread, then the one heard from last — a messenger opens on the conversation that
 * moved, not on whoever was made first.
 */
export function landingRole(team: Pick<TeamSpace, "roles" | "reviews">): TeamRole | null {
  const rank = (r: TeamRole) => (needsYou(r, team.reviews) ? 0 : r.state === "working" ? 1 : r.unread ? 2 : 3);
  return [...team.roles].sort((a, b) => rank(a) - rank(b) || (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0))[0] ?? null;
}
