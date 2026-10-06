import { Icon } from "@realm/ui";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  AGENT_META, REVIEW_INSTRUCTIONS_MAX, REVIEW_INSTRUCTION_EXAMPLES,
  prName, type AgentKind, type PrDetail, type PrPlace, type PrRef, type PrReview,
} from "@realm/contracts";
import { useDissolve } from "../../components/ScrollFades";
import { useAnchoredPopover } from "../../components/use-anchored-popover";
import { FALLBACK_AGENT, useApp } from "../../state/store";
import { chipLabel, modelRows, type ModelRow } from "../session/model-catalog";
import { ModelPicker } from "../session/ModelPicker";
import {
  EMPTY_DRAFT, REVIEW_EVENTS, canReview, canSubmit, isOwnRequest, postsLine, reviewBlocked, reviewPayload, reviewerRows, type ReviewDraft,
} from "./code-review-model";
import { codeReview } from "./code-review-api";
import { reviewerPick } from "./held";

type Pick = { kind: AgentKind; model: string | null };
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A model's name as the picker's chip writes it — "Fable 5.1", "GPT-5.6" — which is how it reads
 *  beside its harness's mark: the mark already says Claude, so the name does not. */
export function useReviewerLabel(kind: AgentKind, model: string | null): string {
  const agentProbe = useApp((s) => s.agentProbe);
  return useMemo(() => chipLabel(kind, model, modelRows({ kind, model, agentProbe, canSwitchAgent: false })), [kind, model, agentProbe]);
}

/**
 * Review with… — ONE control with a second target on it, the shape Codex gives its own: the
 * harness's mark and the model's name, which start a read-only reviewer over this request's diff
 * under the saved instructions, and a chevron after the name that opens how to review — the model,
 * each with its harness's mark, and those instructions. The findings land on the page; none of them
 * is posted unless the person adds it to their review and presses Submit.
 *
 * The chevron is the group's second stop for Tab, and it stays live while the body cannot run — a
 * review in flight, a request still being read — because what it sets is for the next review, and
 * setting it never needed one to be possible now. While one runs, the body is that review: its
 * reviewer's mark, whatever the menu has been changed to since.
 */
export function ReviewWith({ pr, detail, profileId, place, review, onStarted }: {
  pr: PrRef; detail: PrDetail | null; profileId: string; place: PrPlace | null; review: PrReview | null; onStarted: (r: PrReview) => void;
}) {
  const lastAgentKind = useApp((s) => s.lastAgentKind);
  const agentProbe = useApp((s) => s.agentProbe);
  const favorites = useApp((s) => s.modelFavorites);
  const run = useApp((s) => s.run);
  const [pick, setPickState] = useState<Pick>(() => reviewerPick.current
    ?? { kind: lastAgentKind && canReview(lastAgentKind) ? lastAgentKind : FALLBACK_AGENT, model: null });
  const setPick = (p: Pick) => { reviewerPick.current = p; setPickState(p); };
  const rows = useMemo(() => reviewerRows({ ...pick, agentProbe, favorites }), [pick, agentProbe, favorites]);
  const label = chipLabel(pick.kind, pick.model, rows);
  const [open, setOpen] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const running = review?.state === "running";
  const reviewer = useReviewerLabel(review?.agentKind ?? pick.kind, review?.model ?? null);
  const blocked = reviewBlocked(detail, place !== null, running);
  const start = () => run(async () => {
    if (!detail || !place) return;
    onStarted(await codeReview.review({ ref: pr, profileId, spaceId: place.spaceId, projectId: place.projectId, agentKind: pick.kind, model: pick.model }));
  });
  return (
    <span className="cr-review-with" role="group" aria-label="Review with a model">
      <button type="button" className="btn cr-review-run" disabled={blocked !== null} aria-busy={running || undefined} onClick={start}
        title={running ? `${reviewer} is reviewing this pull request` : blocked ?? `A read-only ${label} reads the diff and leaves findings for you — nothing is posted`}>
        <Icon name={AGENT_META[running && review ? review.agentKind : pick.kind].icon} size={14} colored />
        <span className="cr-review-label">{running ? "Reviewing…" : `Review with ${label}`}</span>
      </button>
      <button ref={more} type="button" className="icon-btn cr-review-more" aria-label="Review instructions" title="How to review — the model and your instructions"
        aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}><Icon name="chevronDown" size={12} /></button>
      {open && (
        <InstructionsPopover anchorRef={more} profileId={profileId} pick={pick} rows={rows} onPick={setPick} onClose={() => setOpen(false)}
          blocked={blocked} onRun={start} />
      )}
    </span>
  );
}

/**
 * "Tell the reviewer how to review your code": the model, and the profile's standing instructions,
 * which every review in the profile follows. Add example offers what people tell a reviewer, one a
 * press, appended where the person can edit it. Save and run does both in that order.
 */
function InstructionsPopover({ anchorRef, profileId, pick, rows, onPick, onClose, blocked, onRun }: {
  anchorRef: RefObject<HTMLButtonElement | null>; profileId: string; pick: Pick; rows: ModelRow[]; onPick: (p: Pick) => void; onClose: () => void;
  /** Why the review cannot start now, or null when Save and run may run it. */
  blocked: string | null; onRun: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const { pos, closing, close } = useAnchoredPopover({ ref, anchorRef, align: "right", onClose, returnFocusRef: anchorRef, exit: true });
  const run = useApp((s) => s.run);
  const modelInfo = useApp((s) => s.modelInfo);
  const probeAgents = useApp((s) => s.probeAgents);
  const toggleModelFavorite = useApp((s) => s.toggleModelFavorite);
  useEffect(() => { run(() => probeAgents()); }, [probeAgents, run]);
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [nth, setNth] = useState(0);
  useEffect(() => {
    let live = true;
    codeReview.instructions(profileId).then((i) => { if (live) { setText(i.text); setSaved(i.text); } }, (e: unknown) => run(() => Promise.reject(e)));
    return () => { live = false; };
  }, [profileId, run]);
  useEffect(() => { if (pos && text !== null) field.current?.focus(); }, [pos !== null, text !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const over = (text?.length ?? 0) > REVIEW_INSTRUCTIONS_MAX;
  const save = async () => { if (text === null) return; const r = await codeReview.setInstructions(profileId, text); setSaved(r.text); };
  const addExample = () => {
    const ex = REVIEW_INSTRUCTION_EXAMPLES[nth % REVIEW_INSTRUCTION_EXAMPLES.length]!;
    setNth((n) => n + 1);
    setText((t) => (t && t.trim() ? `${t.replace(/\s+$/, "")}\n${ex}` : ex));
    field.current?.focus();
  };
  return createPortal(
    <div ref={ref} className="cr-pop cr-instructions" role="dialog" aria-label="Review instructions"
      style={{ position: "fixed", left: pos?.left ?? -9999, top: pos?.top ?? -9999, visibility: pos ? "visible" : "hidden", transformOrigin: pos?.origin ?? "top right" }}
      data-closing={closing || undefined} inert={closing}>
      <h2 className="cr-pop-title">Tell the reviewer how to review your code</h2>
      <div className="cr-pop-row">
        <span>Review with</span>
        {/* The prompter's own picker: each model under its harness's mark, with its search and its
            keys. Opened from in here it is part of this popover while it is up (use-anchored-popover). */}
        <ModelPicker kind={pick.kind} model={pick.model} rows={rows} info={modelInfo}
          onToggleFavorite={(key) => run(() => toggleModelFavorite(key))} onPick={(kind, model) => onPick({ kind, model })} />
      </div>
      <textarea ref={field} className="cr-field" rows={5} aria-label="Review instructions" disabled={text === null}
        placeholder="For example: I care most about the data model. Tell me where we might be overcomplicating things."
        value={text ?? ""} onChange={(e) => setText(e.target.value)} />
      <p className="cr-pop-note" data-tone={over ? "bad" : undefined}>
        {over ? `Up to ${REVIEW_INSTRUCTIONS_MAX.toLocaleString("en-US")} characters — this is ${(text ?? "").length.toLocaleString("en-US")}.`
          : "Every review in this profile follows these."}
      </p>
      <div className="cr-pop-actions">
        <button type="button" className="btn" onClick={addExample} disabled={text === null}>Add example</button>
        <span className="cr-bar-spacer" />
        <button type="button" className="btn" disabled={text === null || over || text === saved} onClick={() => run(save)}>Save</button>
        <button type="button" className="btn primary" disabled={text === null || over || blocked !== null} title={blocked ?? undefined}
          onClick={() => run(async () => { await save(); close(); onRun(); })}>Save and run</button>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Submit review ▾ — the one control on the page that writes to GitHub. Its sheet is the review as it
 * will be posted: the decision, the comment (required), every line comment kept, and a sentence
 * saying where it goes and as whom. Only its Submit posts.
 */
export function SubmitReview({ pr, detail, login, draft, setDraft }: {
  pr: PrRef; detail: PrDetail | null; login: string | null; draft: ReviewDraft; setDraft: (d: ReviewDraft | ((d: ReviewDraft) => ReviewDraft)) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const waiting = draft.comments.length;
  return (
    <>
      <button ref={anchor} type="button" className="btn primary cr-submit" disabled={!detail} aria-haspopup="dialog" aria-expanded={open}
        aria-label={waiting ? `Submit review, ${waiting} line ${waiting === 1 ? "comment" : "comments"} waiting` : "Submit review"}
        onClick={() => setOpen((o) => !o)}>
        Submit review{waiting > 0 && <span className="cr-submit-count" aria-hidden="true">{waiting}</span>}<Icon name="chevronDown" size={12} />
      </button>
      {open && detail && <SubmitPopover anchorRef={anchor} pr={pr} detail={detail} login={login} draft={draft} setDraft={setDraft} onClose={() => setOpen(false)} />}
    </>
  );
}

function SubmitPopover({ anchorRef, pr, detail, login, draft, setDraft, onClose }: {
  anchorRef: RefObject<HTMLButtonElement | null>; pr: PrRef; detail: PrDetail; login: string | null; draft: ReviewDraft;
  setDraft: (d: ReviewDraft | ((d: ReviewDraft) => ReviewDraft)) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const pending = useRef<HTMLUListElement>(null);
  useDissolve(pending);
  const { pos, closing, close } = useAnchoredPopover({ ref, anchorRef, align: "right", onClose, returnFocusRef: anchorRef, exit: true });
  const toast = useApp((s) => s.toast);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const own = isOwnRequest(detail, login);
  // GitHub refuses the author's Approve or Request changes; a review written before that was known
  // falls back to the one it will take.
  useEffect(() => { if (own && draft.event !== "COMMENT") setDraft((d) => ({ ...d, event: "COMMENT" })); }, [own, draft.event, setDraft]);
  useEffect(() => { if (pos) field.current?.focus(); }, [pos !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    setPosting(true); setError(null);
    try {
      const posted = await codeReview.submit(reviewPayload(pr, detail.headSha, draft));
      setDraft(EMPTY_DRAFT);
      close();
      toast({ tone: "success", text: `Posted your review to ${prName(pr)}${posted.url ? "" : ", though GitHub sent no link back"}` });
    } catch (e) { setError(message(e)); } finally { setPosting(false); }
  };
  return createPortal(
    <div ref={ref} className="cr-pop cr-submit-pop" role="dialog" aria-label="Submit review"
      style={{ position: "fixed", left: pos?.left ?? -9999, top: pos?.top ?? -9999, visibility: pos ? "visible" : "hidden", transformOrigin: pos?.origin ?? "top right" }}
      data-closing={closing || undefined} inert={closing}>
      <fieldset className="cr-decision">
        <legend className="cr-pop-title">Review decision</legend>
        {REVIEW_EVENTS.map((e) => (
          <label key={e.event} className="cr-decision-opt" data-disabled={(own && e.event !== "COMMENT") || undefined}>
            <input type="radio" name="cr-review-event" value={e.event} checked={draft.event === e.event} disabled={own && e.event !== "COMMENT"}
              onChange={() => setDraft((d) => ({ ...d, event: e.event }))} />
            <span className="cr-decision-text"><span className="cr-decision-name">{e.label}</span><span className="cr-decision-line">{e.line}</span></span>
          </label>
        ))}
      </fieldset>
      {own && <p className="cr-pop-note">This is your own pull request, and GitHub lets its author comment on it but not approve it or request changes.</p>}
      <label className="cr-pop-label" htmlFor="cr-review-body"><span>Review comment</span><span className="cr-quiet">Required</span></label>
      <textarea id="cr-review-body" ref={field} className="cr-field" rows={4} placeholder="Add a comment…" value={draft.body}
        onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSubmit(draft) && !posting) { e.preventDefault(); void submit(); } }} />
      {draft.comments.length > 0 && (
        <ul ref={pending} className="cr-pending" aria-label="Line comments in this review">
          {draft.comments.map((c) => (
            <li key={c.id} className="cr-pending-row">
              <span className="cr-pending-where">{c.path}<span className="cr-quiet">:{c.line}{c.side === "LEFT" ? " (old)" : ""}</span></span>
              <span className="cr-pending-body">{c.body}</span>
              <button type="button" className="icon-btn" aria-label={`Leave out the comment on ${c.path} line ${c.line}`} title="Leave it out"
                onClick={() => setDraft((d) => ({ ...d, comments: d.comments.filter((x) => x.id !== c.id) }))}><Icon name="close" size={12} /></button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="cr-pop-note" data-tone="bad" role="alert">{error}</p>}
      <div className="cr-pop-actions">
        <p className="cr-posts">{postsLine(pr, draft, login)}</p>
        <button type="button" className="btn primary" disabled={!canSubmit(draft) || posting} aria-busy={posting || undefined}
          title="Post this review to GitHub (⌘↵)" onClick={() => void submit()}>{posting ? "Posting…" : "Submit"}</button>
      </div>
    </div>,
    document.body,
  );
}
