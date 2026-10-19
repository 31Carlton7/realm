import { Icon, type IconName } from "@realm/ui";
import { useEffect, useRef, useState } from "react";
import {
  bodyHead, inferFormat, itemNoun, itemVerb, reviewVerb, verbFamily,
  type TeamReviewDetail, type TeamReviewItem, type TeamReviewSummary, type TeamSpace,
} from "@realm/contracts";
import { useDissolve } from "../../../components/ScrollFades";
import { useApp } from "../../../state/store";
import { agoPhrase, duration, feedTime, money } from "../team-format";
import { DecisionDock } from "./Decision";
import { Deliverable, drawsBody, editable } from "./renderers";
import { phaseLabel, phaseTone, reviewPhase, type Decision, type ReviewPhase } from "./review-model";
import { reviewRole, RoleMark } from "./RoleMark";

const PHASE_ICON: Record<ReviewPhase, IconName> = {
  waiting: "pending", revised: "pending", changed: "alert", "to-press": "send", failed: "alert", changes: "undo", scheduled: "clock",
  "by-hand": "check", approved: "check", posted: "checkCircle", done: "checkCircle", finished: "checkCircle", rejected: "close",
  closed: "archive", replaced: "rotate", withdrawn: "minus", "put-away": "archive",
};

/** A review's state as a pill over its title: its mark and its word, tinted by what it asks of you. */
export function ReviewStatePill({ review }: { review: TeamReviewSummary }) {
  const phase = reviewPhase(review);
  return <span className="rv-pill" data-tone={phaseTone(phase)}><Icon name={PHASE_ICON[phase]} size={12} />{phaseLabel(phase, review)}</span>;
}

/**
 * One review, read: the draft as the thing itself under a head that says where it stands, who made
 * it and what that cost; the role's note above the work; and beside it, as Code review sets its
 * facts beside a request, what Realm checked before anything can go and how the work was made. The
 * decision is docked at the foot (`DecisionDock`).
 */
export function Reader({ team, summary, onBack, onDecided }: {
  team: TeamSpace | undefined; summary: TeamReviewSummary; onBack: () => void; onDecided: (id: string, decision: Decision) => void;
}) {
  const detail = useApp((s) => s.teamReviewDetail[summary.id]);
  const loadTeamReview = useApp((s) => s.loadTeamReview);
  const run = useApp((s) => s.run);
  // The summary moves with `team.changed`; the detail is re-read with it (team-slice.ts).
  useEffect(() => { run(() => loadTeamReview(summary.id).then(() => undefined)); }, [summary.id, summary.updatedAt, loadTeamReview, run]);
  const scroller = useRef<HTMLDivElement>(null);
  useDissolve(scroller);
  // Which item of the batch is being read: the body steps through it, and the dock acts on its post.
  const [step, setStep] = useState(0);
  if (!detail) return <article className="rv-detail" aria-busy="true"><BackBar onBack={onBack} /></article>;
  const item = detail.items[Math.min(step, Math.max(0, detail.items.length - 1))] ?? null;
  return (
    <article className="rv-detail" aria-labelledby={`rv-title-${detail.id}`}>
      <BackBar onBack={onBack} />
      <div className="rv-detail-scroll" ref={scroller}>
        <ReaderBody team={team} detail={detail} step={step} setStep={setStep} />
      </div>
      <DecisionDock team={team} detail={detail} item={item} onDecided={onDecided} />
    </article>
  );
}

/** In a pane too narrow for the inbox beside the draft, the way back to the inbox. */
function BackBar({ onBack }: { onBack: () => void }) {
  return (
    <div className="rv-back">
      <button type="button" className="btn-quiet" onClick={onBack}><Icon name="chevronLeft" size={14} />All reviews</button>
    </div>
  );
}

function ReaderBody({ team, detail, step, setStep }: { team: TeamSpace | undefined; detail: TeamReviewDetail; step: number; setStep: (i: number) => void }) {
  const editItem = useApp((s) => s.editTeamReviewItem);
  const revealSession = useApp((s) => s.revealSession);
  const run = useApp((s) => s.run);
  const [showPrevious, setShowPrevious] = useState(false);
  const items = showPrevious && detail.previous.length > 0 ? latestPrevious(detail.previous) : detail.items;
  const at = Math.min(step, Math.max(0, items.length - 1));
  const item = items[at];
  const many = items.length > 1;
  const noun = itemNoun(detail.kind);
  const format = item ? inferFormat(item) : null;
  // The text rides under its own head only where the drawing did not carry it.
  const caption = item?.body && format && !drawsBody(format, item) ? item.body : null;
  const edit = item && !showPrevious && editable(detail, item) ? { save: (body: string) => editItem(detail.id, item.id, body) } : null;
  const editedHere = !showPrevious ? editedThisVersion(detail) : [];
  const role = reviewRole(team, detail.roleId);
  const goal = role?.live?.goal && role.live.goal.runId === detail.runId ? role.live.goal : null;
  const family = verbFamily(reviewVerb(detail.kind, detail.items));
  const cost = [detail.costUsd !== null ? money(detail.costUsd) : null, detail.durationMs !== null ? duration(detail.durationMs) : null].filter(Boolean).join(" · ");
  return (
    <div className="rv-reader">
      <div className="rv-reader-main">
        <header className="rv-head">
          <div className="rv-head-line">
            <ReviewStatePill review={detail} />
            {detail.recordName && <span className="rv-head-for">For {detail.recordName}</span>}
          </div>
          <h1 id={`rv-title-${detail.id}`} className="rv-title">{detail.title}</h1>
          <p className="rv-byline">
            <RoleMark team={team} review={detail} size={16} />
            {detail.roleName && <span className="rv-byline-who">{detail.roleName}</span>}
            <span className="t-num">{agoPhrase(detail.createdAt)}</span>
            {cost && <><span aria-hidden="true">·</span><span className="t-num" title="What the run that made it spent, in API-equivalent dollars, and how long it took">{cost}</span></>}
          </p>
        </header>
        {detail.why && (
          <figure className="rv-why">
            <figcaption className="rv-why-who">Why {detail.roleName ?? "the role"} made it</figcaption>
            <blockquote className="rv-why-text" data-selectable="">{detail.why}</blockquote>
          </figure>
        )}
        {detail.version > 1 && (
          <p className="rv-version">
            {showPrevious ? `Version ${detail.version - 1}, before your changes.`
              : editedHere.length > 0 ? `Version ${detail.version}, with your edit to ${noun} ${editedHere.join(", ")}.`
              : `Version ${detail.version}, after you asked: “${detail.note ?? "changes"}”${/[.!?]$/.test(detail.note ?? "") ? "" : "."}`}{" "}
            <button type="button" className="btn-quiet rv-version-toggle" onClick={() => { setShowPrevious((v) => !v); setStep(0); }}>
              {showPrevious ? `Back to version ${detail.version}` : `Show version ${detail.version - 1}`}
            </button>
          </p>
        )}
        {many && (
          <div className="rv-stepper">
            <span className="rv-stepper-label t-num">{capital(noun)} {at + 1} of {items.length}</span>
            <fieldset className="settings-tabs rv-stepper-tabs" aria-label={`${noun} to read`}>
              {items.map((it, i) => (
                <label key={it.id} className="settings-tab" data-selected={i === at || undefined}>
                  <input type="radio" name={`rv-step-${detail.id}`} checked={i === at} onChange={() => setStep(i)} />{i + 1}
                </label>
              ))}
            </fieldset>
          </div>
        )}
        {item && detail.root && <Deliverable key={item.id} detail={detail} item={item} edit={edit} />}
        {caption && (
          <section className="rv-section">
            <h3 className="rv-fact-label">{bodyHead(itemVerb(detail.kind, item!) ?? reviewVerb(detail.kind, detail.items))}</h3>
            <div className="rv-caption" data-selectable="">{caption}</div>
          </section>
        )}
      </div>
      <aside className="rv-facts" aria-label="What Realm checked, and how it was made">
        {detail.checks.length > 0 && (
          <section className="rv-fact">
            <h3 className="rv-fact-label">{detail.state !== "waiting" ? "What Realm checked" : family === "send" ? "Before it can send" : family === "post" ? "Before it can post" : "Before it can go"}</h3>
            <ul className="rv-checks">
              {detail.checks.map((c) => (
                <li key={c.title} data-tone={c.ok === true ? "ok" : c.ok === false ? "bad" : "quiet"}>
                  <Icon name={c.ok === true ? "checkCircle" : c.ok === false ? "alert" : "info"} size={14} />
                  <span>{c.title}<small>{c.detail}</small></span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {(detail.ledger.length > 0 || goal || detail.sessionId) && (
          <section className="rv-fact">
            <h3 className="rv-fact-label">How it was made</h3>
            {goal && <p className="rv-goal">Toward its goal: “{goal.objective}”</p>}
            {detail.ledger.length > 0 && (
              <ol className="rv-ledger">
                {detail.ledger.map((l, i) => (
                  <li key={i}>
                    <span className="rv-ledger-glyph"><Icon name={l.glyph === "inbox" ? "review" : l.glyph === "note" ? "note" : l.glyph === "image" ? "image" : "alarm"} size={12} /></span>
                    <span className="rv-ledger-text">{l.text}{l.detail && <small>{l.detail}</small>}</span>
                    <time className="rv-ledger-time t-num">{feedTime(l.ts)}</time>
                  </li>
                ))}
              </ol>
            )}
            {detail.sessionId && (
              <button type="button" className="btn-quiet rv-run-link" onClick={() => run(() => revealSession(detail.sessionId!, detail.spaceId).then(() => undefined))}>
                <Icon name="session" size={14} />Open the run
              </button>
            )}
          </section>
        )}
      </aside>
    </div>
  );
}

/** The newest earlier version's items — the one a person compares against. */
function latestPrevious(items: TeamReviewItem[]): TeamReviewItem[] {
  const v = Math.max(...items.map((i) => i.version));
  return items.filter((i) => i.version === v).sort((a, b) => a.ord - b.ord);
}

/** The items of this version whose text the person edited, by place — not the ones carried over. */
function editedThisVersion(detail: TeamReviewDetail): number[] {
  const before = latestPrevious(detail.previous);
  return detail.items.filter((i) => i.editedBy === "user" && before.find((b) => b.ord === i.ord)?.body !== i.body).map((i) => i.ord + 1);
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
