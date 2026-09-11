import type { Notification } from "@realm/contracts";

/**
 * How the feed is cut up, as a pure function over the rows and one timestamp.
 *
 * The page groups by day, newest first, which is the right shape for a log and the wrong shape for
 * the question a person actually arrives with. It buries Tuesday's unanswered permission under
 * Wednesday's finished turns — and with a daemon running headless, "what is blocked on me" is not a
 * detail of the feed, it IS the feed's reason to exist.
 *
 * So two sections come off the top before the days are built, and every row lands in exactly one
 * place. Duplicating a row across sections would make the page lie about how much is waiting.
 */
export type FeedSection =
  /** Unanswered questions, pinned. Permissions first, then blocked runs: one has an agent stopped
   *  mid-turn behind it, the other has work parked. */
  | { kind: "needs-you"; rows: Notification[] }
  /** Everything that happened since the last window closed. Absent entirely when nothing has — a
   *  server nobody has detached from has no away to report. */
  | { kind: "away"; rows: Notification[] }
  | { kind: "day"; label: string; rows: Notification[] };

/** A row nobody has dealt with and something is waiting on. `actedAt` is about the WORLD — the
 *  permission answered, the run unblocked — which is the right test here: a row somebody merely READ
 *  is still a question an agent is stopped behind. */
const needsYou = (n: Notification): boolean =>
  n.actedAt === null && (n.category === "permission" || n.category === "run_blocked");

export function feedSections(
  notifications: readonly Notification[],
  d: { detachedSince: number | null; dayLabel: (ts: number) => string },
): FeedSection[] {
  const sections: FeedSection[] = [];
  const pinned = notifications.filter(needsYou);
  // Permissions before blocked runs, and each group left in the feed's own newest-first order.
  const ordered = [
    ...pinned.filter((n) => n.category === "permission"),
    ...pinned.filter((n) => n.category === "run_blocked"),
  ];
  if (ordered.length > 0) sections.push({ kind: "needs-you", rows: ordered });

  const rest = notifications.filter((n) => !needsYou(n));
  // `> `, not `>=`: the row written at the instant the window closed is one you were there for.
  const away = d.detachedSince === null ? [] : rest.filter((n) => n.createdAt > d.detachedSince!);
  if (away.length > 0) sections.push({ kind: "away", rows: away });

  const awayIds = new Set(away.map((n) => n.id));
  for (const n of rest) {
    if (awayIds.has(n.id)) continue;
    const label = d.dayLabel(n.createdAt);
    const last = sections.at(-1);
    if (last?.kind === "day" && last.label === label) last.rows.push(n);
    else sections.push({ kind: "day", label, rows: [n] });
  }
  return sections;
}

/** The heading each section wears. `needs-you` counts, because the number is the whole point of
 *  pinning it; the others do not, because a count of things that merely happened is not a fact
 *  anybody needs at the top of a list they are about to read. */
export function sectionLabel(s: FeedSection): string {
  switch (s.kind) {
    case "needs-you": return s.rows.length === 1 ? "Needs you" : `Needs you · ${s.rows.length}`;
    case "away": return "While you were away";
    case "day": return s.label;
  }
}
