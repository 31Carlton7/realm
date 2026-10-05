import {
  parsePrRef, prKey, prName,
  type CheckState, type Finding, type PrDetail, type PrPage, type PrRef, type PrSection, type PrSummary, type ReviewerState,
  type ReviewEvent, type ReviewSide, type SubmitReview,
} from "@realm/contracts";

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

/** GitHub refuses an author's Approve and Request changes on their own request; a comment is fine. */
export const isOwnRequest = (d: Pick<PrDetail, "author">, login: string | null): boolean =>
  !!login && !!d.author && d.author.toLowerCase() === login.toLowerCase();

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

/** Exactly what Submit sends — the comment as typed, every kept line comment on its side. */
export function reviewPayload(ref: PrRef, headSha: string, draft: ReviewDraft): SubmitReview {
  return {
    ref, headSha, event: draft.event, body: draft.body,
    comments: draft.comments.map((c) => ({ path: c.path, line: c.line, side: c.side, body: c.body })),
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
