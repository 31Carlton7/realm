import { Icon } from "@realm/ui";
import { useRef, useState } from "react";
import { AGENT_META, prName, type CheckState, type Finding, type PrDetail, type PrReview, type ReviewerState } from "@realm/contracts";
import { useDissolve } from "../../components/ScrollFades";
import { useApp } from "../../state/store";
import { Markdown } from "../session/Markdown";
import {
  REVIEWER_STATE_LABEL, age, checksFact, isKept, keepFinding, keepSummary, mergeFact, prMarkdown, type Fact, type ReviewDraft,
} from "./code-review-model";
import { Monogram } from "./PrColumn";
import { useReviewerLabel } from "./ReviewTools";

/** A request's state as a pill: its mark and its word, the one place on the page a status is a pill. */
export function StatePill({ detail }: { detail: Pick<PrDetail, "state" | "draft"> }) {
  const [icon, word] = detail.state === "merged" ? ["merged", "Merged"] : detail.state === "closed" ? ["prClosed", "Closed"]
    : detail.draft ? ["prDraft", "Draft"] : ["pullRequest", "Open"];
  return <span className="cr-pill" data-state={detail.draft && detail.state === "open" ? "draft" : detail.state}><Icon name={icon} size={12} />{word}</span>;
}

const FACT_ICON: Record<Fact["tone"], string> = { ok: "checkCircle", bad: "errorCircle", wait: "pending", quiet: "info" };
const CHECK_ICON: Record<CheckState, string> = { success: "checkCircle", failure: "errorCircle", pending: "pending", skipped: "minus", neutral: "minus" };
const REVIEWER_ICON: Record<ReviewerState, string> = { approved: "checkCircle", changes_requested: "errorCircle", commented: "comment", dismissed: "minus", pending: "pending" };

/**
 * The Summary tab: the request as its author wrote it — state, title, who and which branches, then
 * the description — with the facts that decide what happens to it in a column beside: whether it can
 * merge, the conversation's end, who has reviewed, and the checks. A reviewer's run sits between the
 * head and the description, since it is the newest thing said about the change.
 */
export function PrSummary({ detail, review, draft, setDraft, onShow }: {
  detail: PrDetail; review: PrReview | null; draft: ReviewDraft; setDraft: (d: ReviewDraft | ((d: ReviewDraft) => ReviewDraft)) => void;
  onShow: (path: string, line: number, side: "LEFT" | "RIGHT") => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  useDissolve(scroller);
  const merge = mergeFact(detail);
  const checks = checksFact(detail.checks);
  const [checksOpen, setChecksOpen] = useState(false);
  const body = detail.body.trim();
  return (
    <div ref={scroller} className="cr-summary">
      <div className="cr-summary-main">
        <header className="cr-head">
          <div className="cr-head-line">
            <StatePill detail={detail} />
            <span className="cr-head-repo">{detail.ref.owner}/{detail.ref.repo} #{detail.ref.number}</span>
          </div>
          <h2 className="cr-title">{detail.title}</h2>
          <p className="cr-head-meta">
            <Monogram name={detail.author} />
            <span className="cr-head-author">{detail.author ?? "ghost"}</span>
            <span>{age(detail.createdAt)} ago</span>
            <span aria-hidden="true">·</span>
            <span className="cr-branch" title="The branch being merged">{detail.headOwner ? `${detail.headOwner}:` : ""}{detail.head}</span>
            <Icon name="arrowRight" size={12} className="cr-head-arrow" />
            <span className="cr-branch" title="The branch it merges into">{detail.base}</span>
          </p>
        </header>
        {review && <ReviewPanel review={review} draft={draft} setDraft={setDraft} onShow={onShow} />}
        <div className="cr-body">
          {body ? <Markdown text={prMarkdown(body)} /> : <p className="cr-quiet">No description provided.</p>}
        </div>
      </div>
      <aside className="cr-facts" aria-label={`${prName(detail.ref)} facts`}>
        <section className="cr-fact">
          <h3 className="cr-fact-label">Merge status</h3>
          <p className="cr-fact-line" data-tone={merge.tone}><Icon name={FACT_ICON[merge.tone]} size={14} />{merge.text}</p>
        </section>
        <section className="cr-fact">
          <h3 className="cr-fact-label">Comments{detail.comments.total > 0 ? ` · ${detail.comments.total}` : ""}</h3>
          {detail.comments.total === 0 ? <p className="cr-quiet">No comments</p> : (
            <ul className="cr-comments">
              {detail.comments.recent.map((c, i) => (
                <li key={`${c.createdAt}-${i}`} className="cr-comment">
                  <span className="cr-comment-who"><Monogram name={c.author} />{c.author ?? "ghost"}<span className="cr-quiet">{age(c.createdAt)}</span></span>
                  <span className="cr-comment-body">{c.body}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="cr-fact">
          <h3 className="cr-fact-label">Reviews</h3>
          {detail.reviewers.length === 0 ? <p className="cr-quiet">Nobody yet</p> : (
            <ul className="cr-reviewers">
              {detail.reviewers.map((r) => (
                <li key={`${r.team ? "team" : "user"}:${r.name}`} className="cr-reviewer" data-state={r.state}>
                  <Icon name={REVIEWER_ICON[r.state]} size={14} />
                  {r.team ? <Icon name="user" size={14} /> : <Monogram name={r.name} />}
                  <span className="cr-reviewer-name">{r.team ? `${r.name} (team)` : r.name}</span>
                  <span className="cr-quiet">{REVIEWER_STATE_LABEL[r.state]}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="cr-fact">
          {detail.checks.length === 0 ? (
            <><h3 className="cr-fact-label">Checks</h3><p className="cr-quiet">No checks</p></>
          ) : (
            <>
              <button type="button" className="cr-fact-label cr-fact-toggle" aria-expanded={checksOpen} onClick={() => setChecksOpen((o) => !o)}>
                Checks<Icon name="chevronRight" size={12} />
              </button>
              <p className="cr-fact-line" data-tone={checks.tone}><Icon name={FACT_ICON[checks.tone]} size={14} />{checks.text}</p>
              {checksOpen && (
                <ul className="cr-checks">
                  {detail.checks.map((c, i) => (
                    <li key={`${c.name}-${i}`} className="cr-check" data-state={c.state}>
                      <Icon name={CHECK_ICON[c.state]} size={14} />
                      {c.url ? <a href={c.url} target="_blank" rel="noreferrer">{c.name}</a> : <span>{c.name}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      </aside>
    </div>
  );
}

const STATE_WORD: Record<PrReview["state"], string | null> = {
  running: null, done: null, stopped: "was stopped before it finished", interrupted: "was cut off before it finished",
  timeout: "ran out of time", failed: "failed", gone: "lost its session",
};

/**
 * A reviewer's run, as findings for the person: its summary, then each line it pointed at, with
 * the two things that can happen to one — keep it in the review, or look at it in the diff. Keeping
 * is not posting: what is kept waits in Submit review, which says what it will post before it does.
 */
function ReviewPanel({ review, draft, setDraft, onShow }: {
  review: PrReview; draft: ReviewDraft; setDraft: (d: ReviewDraft | ((d: ReviewDraft) => ReviewDraft)) => void;
  onShow: (path: string, line: number, side: "LEFT" | "RIGHT") => void;
}) {
  const label = useReviewerLabel(review.agentKind, review.model);
  const revealSession = useApp((s) => s.revealSession);
  const closePageOverlay = useApp((s) => s.closePageOverlay);
  const run = useApp((s) => s.run);
  const running = review.state === "running";
  const note = STATE_WORD[review.state];
  const unkept = review.findings.filter((f) => !isKept(draft, f.id));
  const openSession = () => run(async () => { closePageOverlay(); await revealSession(review.sessionId, review.spaceId); });
  return (
    <section className="cr-review" aria-label="Review" data-state={review.state}>
      <div className="cr-review-head">
        <Icon name={AGENT_META[review.agentKind].icon} size={14} colored />
        <span className="cr-review-title">{running ? `${label} is reviewing…` : `Review by ${label}`}</span>
        {!running && review.finishedAt && <span className="cr-quiet">{age(review.finishedAt)} ago</span>}
        <span className="cr-bar-spacer" />
        <button type="button" className="btn-quiet" onClick={openSession} title="Its whole trace, in the session it ran in">Open session</button>
      </div>
      {note && <p className="cr-review-note">The reviewer {note}{review.summary && review.state === "failed" ? `: ${review.summary}` : "."}</p>}
      {!running && review.summary && review.state !== "failed" && (
        <div className="cr-review-summary" data-agent-output><Markdown text={review.summary} /></div>
      )}
      {review.findings.length > 0 && (
        <ul className="cr-findings">
          {review.findings.map((f) => <FindingRow key={f.id} f={f} kept={isKept(draft, f.id)} onKeep={() => setDraft((d) => keepFinding(d, f))} onShow={onShow} />)}
        </ul>
      )}
      {!running && (review.summary || unkept.length > 0) && (
        <div className="cr-review-actions">
          {review.summary && review.state !== "failed" && (
            <button type="button" className="btn-quiet" onClick={() => setDraft((d) => keepSummary(d, review.summary))}>Use the summary in my comment</button>
          )}
          {unkept.length > 1 && (
            <button type="button" className="btn-quiet" onClick={() => setDraft((d) => unkept.reduce(keepFinding, d))}>Keep all {unkept.length} findings</button>
          )}
        </div>
      )}
      {!running && review.state === "done" && review.findings.length === 0 && <p className="cr-quiet">No line findings.</p>}
    </section>
  );
}

function FindingRow({ f, kept, onKeep, onShow }: { f: Finding; kept: boolean; onKeep: () => void; onShow: (path: string, line: number, side: "LEFT" | "RIGHT") => void }) {
  return (
    <li className="cr-finding" data-kept={kept || undefined}>
      <div className="cr-finding-head">
        {f.anchored ? (
          <button type="button" className="cr-finding-where" title="Show it in the changes" onClick={() => onShow(f.path, f.line, f.side)}>
            {f.path}<span className="cr-quiet">:{f.line}</span>
          </button>
        ) : (
          <span className="cr-finding-where" title="Not on a line this pull request changes, so it can only go in the comment">
            {f.path}<span className="cr-quiet">:{f.line} · not in the diff</span>
          </span>
        )}
        <span className="cr-bar-spacer" />
        {kept
          ? <span className="cr-kept"><Icon name="check" size={12} />In your review</span>
          : <button type="button" className="btn-quiet" onClick={onKeep}>{f.anchored ? "Add to review" : "Add to my comment"}</button>}
      </div>
      <div className="cr-finding-body" data-agent-output><Markdown text={f.body} /></div>
    </li>
  );
}
