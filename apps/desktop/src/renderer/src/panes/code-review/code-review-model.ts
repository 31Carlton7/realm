import {
  AGENT_SUPPORTS_PLAN_MODE, ownerQualifiers, ownersOnce, parsePrRef, prKey, prName, sameOwner,
  type AgentKind, type CheckState, type Finding, type ModelInfo, type PrDetail, type PrOwners, type PrPage, type PrRef, type PrSection, type PrSummary, type ReviewerPick,
  type ReviewerState, type ReviewEvent, type ReviewSide, type SubmitReview,
} from "@realm/contracts";
import type { AgentProbe } from "../../state/store";
import {
  effortCurrent, effortOptions, fastModeAvailability, fastModeTip, modelRows,
  type EffortOptions, type FastAvailability, type ModelRow,
} from "../session/model-catalog";

/**
 * The Code Review page's model, as plain functions over plain data: what the column's lists are
 * called and how their pages add up, what the search box was given, the request's facts in the
 * page's words, and the review being written — what Submit will post, built in one place so the
 * line that says what will be posted and the payload that is posted cannot disagree.
 */

export const SECTION_LABEL: Record<PrSection, string> = {
  authored: "Authored by me",
  review: "Needs my review",
  team: "Needs my team's review",
};

/** How long ago, in the column's few characters: "now", "12m", "3h", "2d", "5mo", "2y". */
export function age(ts: number, now = Date.now()): string {
  const m = Math.floor((now - ts) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d`;
  const mo = Math.floor(d / 30); if (mo < 12) return `${mo}mo`;
  return `${Math.floor(d / 365)}y`;
}

/** How long ago, as a phrase: "just now", "12m ago" — never "now ago". */
export function ago(ts: number, now = Date.now()): string {
  const a = age(ts, now);
  return a === "now" ? "just now" : `${a} ago`;
}

/** What the search box holds: nothing, an address (a pasted link, `owner/repo#42`), or words. */
export type ColumnQuery = { kind: "none" } | { kind: "ref"; ref: PrRef } | { kind: "search"; query: string };
export function readQuery(text: string): ColumnQuery {
  const t = text.trim();
  if (!t) return { kind: "none" };
  const ref = parsePrRef(t);
  return ref ? { kind: "ref", ref } : { kind: "search", query: t };
}

/** A further page added to what is held, one row per request: a request that moved between the two
 *  reads (updated, so re-sorted) would otherwise be listed twice. */
export function appendPage(held: readonly PrSummary[], page: PrPage): PrSummary[] {
  const seen = new Set(held.map((p) => prKey(p.ref)));
  return [...held, ...page.prs.filter((p) => !seen.has(prKey(p.ref)))];
}

export const sameRef = (a: PrRef | null | undefined, b: PrRef | null | undefined): boolean => !!a && !!b && prKey(a) === prKey(b);

/**
 * The owners the column's menu names: both lists of the profile's choice, and the owner of every
 * row the three lists hold as they are loaded. Each once, however it is spelled, in name order
 * without regard to case. A row's spelling is GitHub's own as of that read, so it is the one kept
 * where a list spells the same owner another way.
 */
export function namedOwners(owners: PrOwners, rows: readonly PrSummary[]): string[] {
  const named = new Map<string, string>();
  for (const owner of [...rows.map((r) => r.ref.owner), ...owners.hidden, ...owners.shown]) {
    if (!named.has(owner.toLowerCase())) named.set(owner.toLowerCase(), owner);
  }
  return [...named.values()].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
}

/** Whether an owner's row is ticked, which is whether its pull requests are listed. With `others`
 *  that is every owner not in `hidden`, and without it the owners in `shown` and nobody else. */
export const ownerTicked = (owners: PrOwners, owner: string): boolean =>
  owners.others ? !owners.hidden.some((o) => sameOwner(o, owner)) : owners.shown.some((o) => sameOwner(o, owner));

/**
 * A press on an owner's row. That owner alone changes, and moves to the other list. A ticked one
 * goes to `hidden` and an unticked one to `shown`, whichever list is in play, so the owner is in one
 * list afterwards and stays named in the menu once its last row has left the lists.
 */
export function pressOwner(owners: PrOwners, owner: string): PrOwners {
  const without = (list: readonly string[]) => list.filter((o) => !sameOwner(o, owner));
  return ownerTicked(owners, owner)
    ? { ...owners, hidden: [...without(owners.hidden), owner], shown: without(owners.shown) }
    : { ...owners, hidden: without(owners.hidden), shown: [...without(owners.shown), owner] };
}

/**
 * A press on "Other owners", where `named` is the owners the menu names at that moment. Turned off,
 * every owner ticked then becomes `shown`, so the lists hold after the press what they held before
 * it. Turned on, both lists are kept, so the owners that were unticked stay unticked.
 */
export function pressOthers(owners: PrOwners, named: readonly string[]): PrOwners {
  if (!owners.others) return { ...owners, others: true };
  return { hidden: owners.hidden, shown: named.filter((o) => ownerTicked(owners, o)), others: false };
}

/** Whether two choices come to the same search, and so to the same lists. */
export const sameListing = (a: PrOwners, b: PrOwners): boolean => ownerQualifiers(a) === ownerQualifiers(b);

/** The rows a list keeps from the moment the choice changes until it has been read again, which are
 *  the rows the new choice still lists. */
export const stillListed = (owners: PrOwners, prs: readonly PrSummary[]): PrSummary[] => prs.filter((p) => ownerTicked(owners, p.ref.owner));

/** Names in a sentence: "a", "a and b", "a, b, and c". */
const inSentence = (names: readonly string[]): string =>
  names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]!}`;

/**
 * What the column says, over the lists, while the profile's choice of owners leaves anything out,
 * and null while it leaves nothing out. `how` and `who` are the line as it is drawn, which is the
 * way the choice runs and then the owners, each once. The owners are what is cut where the line is
 * longer than the column. `sentence` says all of it to a screen reader, and `tip` says it on hover.
 * The two differ only where they name the menu the choice is made in, which is the way out when no
 * owner is selected. Each names it as its reader meets it: the tooltip by the label the button
 * shows, and the sentence by the button's accessible name (`PrColumn`).
 *
 * Over the three lists both say that the pinned requests are no part of the choice. With `searched`
 * the line stands over the results of a search of plain words, and both say only what is true of
 * those. The choice is added to that search, and nothing puts a pinned request back among its
 * results.
 */
export type OwnersLine = { how: string; who: string; sentence: string; tip: string };
export function ownersLine(owners: PrOwners, searched = false): OwnersLine | null {
  const once = ownersOnce(owners.others ? owners.hidden : owners.shown);
  if (once.length === 0) {
    if (owners.others) return null;
    const why = searched ? "No owner is selected, so this search finds nothing." : "No owner is selected, so this profile lists only pinned pull requests.";
    return {
      how: "No owner is selected.", who: "",
      sentence: `${why} In Code review options, select an owner or Other owners.`,
      tip: `${why} In the More menu, select an owner or Other owners.`,
    };
  }
  const whose = inSentence(once);
  const sentence = owners.others
    ? searched ? `This search leaves out pull requests in repositories owned by ${whose}.` : `This profile leaves out pull requests in repositories owned by ${whose}, unless they are pinned.`
    : searched ? `This search finds only pull requests in repositories owned by ${whose}.` : `This profile lists only pinned pull requests and those in repositories owned by ${whose}.`;
  return { how: owners.others ? "Not listed:" : "Only", who: once.join(", "), sentence, tip: sentence };
}

/**
 * How a choice of owners bears on what an empty list says. False while it lists every owner, and
 * the line is the one from before there was a choice. True while it leaves any out and lists some,
 * and the line keeps to the owners that are listed. Null where it lists no owner at all, and the
 * list says nothing: the line over the lists says that none is selected, and "the listed owners"
 * would name nobody.
 */
export function narrowing(owners: PrOwners): boolean | null {
  const gained = ownerQualifiers(owners);
  return gained === null ? null : gained !== "";
}

/**
 * What a list says when it holds nothing. `narrowed` is `narrowing`'s answer for the choice the
 * column is drawn under, and null as well while that choice is not known. True, the line keeps to
 * the owners that are listed, since a request may be open under one that is not. Null, the list
 * says nothing.
 */
export function emptyLine(section: PrSection, narrowed: boolean | null): string | undefined {
  if (narrowed === null) return undefined;
  if (section === "authored") return narrowed ? "Nothing of yours is open for the listed owners." : "Nothing of yours is open.";
  if (section === "review") return narrowed ? "Nobody is waiting on your review for the listed owners." : "Nobody is waiting on your review.";
  return narrowed ? "No team of yours is waiting on a review for the listed owners." : "No team of yours is waiting on a review.";
}

/** What a search says when nothing matches. `narrowed` is as for `emptyLine`, and holds only for a
 *  search the choice of owners is added to. One sent as typed is not narrowed by it. */
export function noMatchLine(query: string, narrowed: boolean | null): string | undefined {
  if (narrowed === null) return undefined;
  return narrowed ? `No pull request you are part of matches “${query}” for the listed owners.` : `No pull request you are part of matches “${query}”.`;
}

/* ───────────────────────────── the request's facts ───────────────────────────── */

export type Fact = { tone: "ok" | "bad" | "wait" | "quiet"; text: string };

/** Whether it can merge, in a sentence — GitHub's `mergeable` and `mergeStateStatus` read together,
 *  because "no conflicts" and "can merge" are different claims when a review is still required. */
export function mergeFact(d: Pick<PrDetail, "state" | "draft" | "mergeable" | "mergeState" | "decision" | "base">): Fact {
  if (d.state === "merged") return { tone: "quiet", text: "Merged" };
  if (d.state === "closed") return { tone: "quiet", text: "Closed without merging" };
  if (d.mergeable === "conflicting" || d.mergeState === "dirty") return { tone: "bad", text: "Has conflicts that must be resolved" };
  if (d.mergeable === "unknown" || d.mergeState === "unknown") return { tone: "wait", text: "GitHub is still checking whether it can merge" };
  if (d.draft || d.mergeState === "draft") return { tone: "quiet", text: "A draft — not ready to merge yet" };
  if (d.mergeState === "behind") return { tone: "wait", text: `Behind ${d.base}; needs updating before it can merge` };
  if (d.mergeState === "blocked") {
    return { tone: "wait", text: d.decision === "changes_requested" ? "Blocked: changes were requested" : d.decision === "review_required" ? "Blocked until it has an approving review" : "Blocked by a branch rule" };
  }
  if (d.mergeState === "unstable") return { tone: "wait", text: "Can merge, but some checks are failing" };
  return { tone: "ok", text: "Can merge without conflicts" };
}

/** The checks in one line: what passed, failed and is still running, by count. */
export function checksFact(checks: readonly { state: CheckState }[]): Fact {
  if (checks.length === 0) return { tone: "quiet", text: "No checks" };
  const n = (s: CheckState) => checks.filter((c) => c.state === s).length;
  const failed = n("failure"), pending = n("pending"), passed = n("success");
  const parts = [failed && `${failed} failed`, pending && `${pending} running`, passed && `${passed} passed`,
    (n("skipped") + n("neutral")) && `${n("skipped") + n("neutral")} skipped`].filter(Boolean) as string[];
  return { tone: failed ? "bad" : pending ? "wait" : "ok", text: parts.join(" · ") };
}

export const REVIEWER_STATE_LABEL: Record<ReviewerState, string> = {
  approved: "Approved", changes_requested: "Requested changes", commented: "Commented", dismissed: "Dismissed", pending: "Waiting",
};

/* ─────────────────────────────── the reviewer ─────────────────────────────── */

/** A reviewer runs read-only, so only an agent Realm can hold to that reviews (`review` refuses the
 *  rest on the server, delegation/review.ts's rule). */
export const canReview = (kind: AgentKind): boolean => AGENT_SUPPORTS_PLAN_MODE[kind] === true;

/**
 * The models a reviewer can run on, as the prompter's picker lists them: only an agent's that can
 * review, and only by routes that can — a model Codex and Cursor both run is offered through Codex
 * alone. The scripted agent joins them where this Realm runs one: a check that drives the page has to
 * be able to pick it.
 */
export function reviewerRows({ kind, model, agentProbe, favorites }: {
  kind: AgentKind; model: string | null; agentProbe: AgentProbe[]; favorites: readonly string[];
}): ModelRow[] {
  const reviewable = (rows: ModelRow[]) => rows.filter((r) => canReview(r.kind))
    .map((r) => ({ ...r, harnesses: r.harnesses.filter(canReview), alternates: r.alternates.filter(canReview) }));
  const rows = reviewable(modelRows({ kind, model, agentProbe, canSwitchAgent: true, favorites }));
  if (kind === "fake" || !agentProbe.some((p) => p.kind === "fake")) return rows;
  const scripted = reviewable(modelRows({ kind: "fake", model: null, agentProbe, canSwitchAgent: true, favorites }))
    .filter((r) => r.kind === "fake").map((r) => ({ ...r, selected: false }));
  return [...rows, ...scripted];
}

/** What the reviewer could run on and how, read as the prompter reads it for a session: the
 *  reviewers' rows, the levels the picked model takes and its default, and what is known about its
 *  fast mode before anything has run. */
export type ReviewerCatalog = { rows: ModelRow[]; levels: EffortOptions; fast: FastAvailability; tip: string };

export function reviewerCatalog({ pick, agentProbe, favorites, info, effortSupport, fastSupport }: {
  pick: Pick<ReviewerPick, "agentKind" | "model">; agentProbe: AgentProbe[]; favorites: readonly string[];
  /** The model catalog, the levels Claude Code has named per model and its fast-mode answers, as the
   *  store mirrors them. */
  info: Record<string, ModelInfo>; effortSupport: Record<string, string[]>; fastSupport: Record<string, boolean>;
}): ReviewerCatalog {
  const { agentKind: kind, model } = pick;
  const rows = reviewerRows({ kind, model, agentProbe, favorites });
  const levels = effortOptions({ kind, model, agentProbe, info: info[rows.find((r) => r.selected)?.key ?? ""], remembered: effortSupport });
  return { rows, levels, fast: fastModeAvailability({ kind, model, agentProbe, remembered: fastSupport, rows }), tip: fastModeTip(kind, model, agentProbe) };
}

/**
 * How a review started from the pick runs, which is what Review with… says: the level the card shows
 * chosen — one held from another model gives way to this one's own default, which is what the card
 * shows in its place, and so does any level for a model that names none (Haiku, or a Codex model its
 * catalog has not described yet) — and fast mode where it is asked for, of a harness that can be
 * asked, on a model nothing has said cannot run it. Nothing has run on the pick yet, so there is no
 * report to say otherwise. The pick keeps its level either way, for a model that takes it.
 */
export function reviewRun(pick: ReviewerPick, c: ReviewerCatalog): { effort: string | null; fastMode: boolean } {
  const level = effortCurrent({ ...c.levels, value: pick.effort });
  return {
    effort: level.chosen ? level.choice!.id : null,
    fastMode: pick.fastMode && c.fast.state !== "none" && c.fast.state !== "unavailable",
  };
}

/** The reviewer in a sentence, for a tooltip: "Opus 5.5", "Opus 5.5 at XHigh effort in fast mode". */
export const reviewerPhrase = (label: string, level: string | null, fast = false): string =>
  `${label}${level ? ` at ${level} effort` : ""}${fast ? " in fast mode" : ""}`;

/** Why Review with… cannot start a review now, as its tooltip says it — or null when it can. */
export function reviewBlocked(detail: Pick<PrDetail, "changedFiles"> | null, hasPlace: boolean, running: boolean): string | null {
  if (running) return "A review of this pull request is running — its findings land here when it is done";
  if (!detail) return "Nothing to review until the pull request has been read";
  if (detail.changedFiles === 0) return "This pull request changes no files, so there is nothing to review";
  if (!hasPlace) return "There is no space to run the review in yet";
  return null;
}

/** Two logins naming one account: GitHub's are case-insensitive, and gh prints them as registered. */
export const sameLogin = (a: string | null, b: string | null): boolean => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** GitHub refuses an author's Approve and Request changes on their own request; a comment is fine. */
export const isOwnRequest = (d: Pick<PrDetail, "author">, login: string | null): boolean => sameLogin(d.author, login);

/**
 * The account a read or a write goes out as, for the wire: the profile's pick (`GhStatus.account`),
 * and nothing at all for gh's own active account — whose calls are sent exactly as they were before
 * there was an account to pick.
 */
export const sentAs = (account: string | null): { account?: string } => (account ? { account } : {});

/* ─────────────────────────────── the review ─────────────────────────────── */

/** A line comment waiting in the review: a reviewer's finding the person kept, or their own. */
export type DraftComment = { id: string; path: string; line: number; side: ReviewSide; body: string; from: "finding" | "me" };
/** The review being written, per request, until it is posted or let go. `fromBody` is the findings
 *  folded into the comment's text — the unanchored ones, which GitHub would refuse as line comments. */
export type ReviewDraft = { event: ReviewEvent; body: string; comments: DraftComment[]; fromBody: string[] };
export const EMPTY_DRAFT: ReviewDraft = { event: "COMMENT", body: "", comments: [], fromBody: [] };

export const REVIEW_EVENTS: readonly { event: ReviewEvent; label: string; line: string }[] = [
  { event: "COMMENT", label: "Comment", line: "Share feedback or ask questions" },
  { event: "APPROVE", label: "Approve", line: "Endorse merging these changes" },
  { event: "REQUEST_CHANGES", label: "Request changes", line: "Ask for revisions before merging" },
];

/** Ready to post: a comment with words in it, which GitHub wants for every event the page offers. */
export const canSubmit = (draft: ReviewDraft): boolean => draft.body.trim() !== "";

/** Exactly what Submit sends — the comment as typed, every kept line comment on its side, and the
 *  account the line beside Submit names when the profile picked one. */
export function reviewPayload(ref: PrRef, headSha: string, draft: ReviewDraft, account: string | null = null): Omit<SubmitReview, "account"> & { account?: string } {
  return {
    ref, headSha, event: draft.event, body: draft.body,
    comments: draft.comments.map((c) => ({ path: c.path, line: c.line, side: c.side, body: c.body })),
    ...sentAs(account),
  };
}

/** The line beside Submit that says what it will do, in the words GitHub will show. */
export function postsLine(ref: PrRef, draft: ReviewDraft, login: string | null): string {
  const verb = REVIEW_EVENTS.find((e) => e.event === draft.event)!.label;
  const lines = draft.comments.length;
  const extra = lines === 0 ? "" : ` with ${lines === 1 ? "1 line comment" : `${lines} line comments`}`;
  return `Posts ${verb === "Comment" ? "a comment" : verb === "Approve" ? "an approval" : "a request for changes"}${extra} to ${prName(ref)}${login ? ` as @${login}` : ""}.`;
}

/** Keep a finding: as a line comment where GitHub will take one, otherwise as a paragraph of the
 *  review's own text that says which line it is about. Keeping one twice changes nothing. */
export function keepFinding(draft: ReviewDraft, f: Finding): ReviewDraft {
  if (draft.comments.some((c) => c.id === f.id) || draft.fromBody.includes(f.id)) return draft;
  if (f.anchored) return { ...draft, comments: [...draft.comments, { id: f.id, path: f.path, line: f.line, side: f.side, body: f.body, from: "finding" }] };
  const para = `**${f.path}, line ${f.line}** — ${f.body}`;
  return { ...draft, body: draft.body.trim() ? `${draft.body.replace(/\s+$/, "")}\n\n${para}` : para, fromBody: [...draft.fromBody, f.id] };
}

export const isKept = (draft: ReviewDraft, id: string): boolean => draft.comments.some((c) => c.id === id) || draft.fromBody.includes(id);

export const dropComment = (draft: ReviewDraft, id: string): ReviewDraft => ({ ...draft, comments: draft.comments.filter((c) => c.id !== id) });

/** The reviewer's summary as the comment's opening, where the person has written nothing yet. */
export function keepSummary(draft: ReviewDraft, summary: string): ReviewDraft {
  const s = summary.trim();
  if (!s || draft.body.includes(s)) return draft;
  return { ...draft, body: draft.body.trim() ? `${s}\n\n${draft.body}` : s };
}

/**
 * A description as the page renders it: GitHub's markdown, less what would reach the network. A
 * picture becomes a link to itself — the window loads no image from the internet — and HTML comments
 * go, as GitHub hides them, since they are mostly a template's instructions to the author.
 */
export function prMarkdown(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, alt: string, url: string) => `[${alt.trim() || "Image"}](${url})`)
    .replace(/<img\b[^>]*?\bsrc=["']([^"']+)["'][^>]*>/gi, (_m, url: string) => `[Image](${url})`)
    .trim();
}
