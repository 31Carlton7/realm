import { Icon } from "@realm/ui";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  AGENT_META, REVIEW_INSTRUCTIONS_MAX, REVIEW_INSTRUCTION_EXAMPLES,
  prName, type AgentKind, type PrDetail, type PrPlace, type PrRef, type PrReview, type ReviewerPick,
} from "@realm/contracts";
import { useDissolve } from "../../components/ScrollFades";
import { useAnchoredPopover } from "../../components/use-anchored-popover";
import { FALLBACK_AGENT, useApp, type AgentProbe } from "../../state/store";
import { chipLabel, formatEffort, modelRows, usableModel, type EffortControl, type FastMode, type ModelRow } from "../session/model-catalog";
import { ModelPicker } from "../session/ModelPicker";
import {
  EMPTY_DRAFT, REVIEW_EVENTS, canReview, canSubmit, isOwnRequest, postsLine, reviewBlocked, reviewPayload, reviewRun, reviewerCatalog, reviewerPhrase,
  type ReviewDraft,
} from "./code-review-model";
import { codeReview } from "./code-review-api";
import { heldReviewer, useHeldReviewer } from "./held";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A reviewer as the page names it: its model's name as the picker's chip writes it — "Fable 5.1",
 *  "GPT-5.6", which is how it reads beside its harness's mark: the mark already says Claude, so the
 *  name does not — and the level it was started at, where one was asked for. */
export function useReviewerName(kind: AgentKind, model: string | null, effort: string | null): { label: string; level: string | null } {
  const agentProbe = useApp((s) => s.agentProbe);
  const label = useMemo(() => chipLabel(kind, model, modelRows({ kind, model, agentProbe, canSwitchAgent: false })), [kind, model, agentProbe]);
  return { label, level: effort ? formatEffort(effort) : null };
}

/** The reviewer in the chip's own words: the model, and the level a shade quieter after it. */
export function ReviewerName({ label, level }: { label: string; level: string | null }) {
  return <>{label}{level && <> <span className="cr-level">{level}</span></>}</>;
}

/** The reviewer a profile starts with, before one is picked: the agent last used where it can review,
 *  on the model chosen for new sessions on that agent (`defaultModels`) where its harness still
 *  offers it and otherwise on the harness's own default, at that model's own level and speed. The
 *  button names the reviewer's model before the review's session exists, so it is worked out here and
 *  named to `codeReview.review`. A saved pick is a model named, the harness's own default included,
 *  and is never run through this: the choice in Settings reaches only a reviewer nobody has picked. */
const firstReviewer = (lastAgentKind: AgentKind | null, defaultModels: Partial<Record<AgentKind, string>>, agentProbe: AgentProbe[]): ReviewerPick => {
  const agentKind = lastAgentKind && canReview(lastAgentKind) ? lastAgentKind : FALLBACK_AGENT;
  return { agentKind, model: usableModel(agentKind, defaultModels[agentKind] ?? null, agentProbe), effort: null, fastMode: false };
};

/**
 * Review with… — ONE control with a second target on it, the shape Codex gives its own: the
 * harness's mark and the model's name — with the level and the bolt where one is asked for, as the
 * prompter's chip says them — which start a read-only reviewer over this request's diff under the
 * saved instructions, and a chevron after the name that opens how to review: the model, each with its
 * harness's mark, its level and fast mode on the picker's own card, and those instructions. The
 * findings land on the page; none of them is posted unless the person adds it to their review and
 * presses Submit.
 *
 * The pick is the profile's, as its instructions are, and kept as it is made (`codeReview.reviewerPick`):
 * the model, the level and fast mode come back in the next window. What a review is started at is what
 * the body says (`reviewRun`), so a level set under another model is not sent to one that does not
 * take it — the card shows that model's default in its place, as the prompter's does.
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
  const defaultModels = useApp((s) => s.defaultModels);
  const favorites = useApp((s) => s.modelFavorites);
  const info = useApp((s) => s.modelInfo);
  const effortSupport = useApp((s) => s.effortSupport);
  const fastSupport = useApp((s) => s.fastSupport);
  const refreshFastSupport = useApp((s) => s.refreshFastSupport);
  const refreshModelCatalog = useApp((s) => s.refreshModelCatalog);
  const run = useApp((s) => s.run);
  const [held, hold] = useHeldReviewer(profileId);
  const pick = held ?? firstReviewer(lastAgentKind, defaultModels, agentProbe);
  // The levels each model takes and what is known of its fast mode, which the body names before the
  // menu is ever opened — loaded as a session pane loads them, for a page that may be opened first.
  useEffect(() => {
    run(() => refreshFastSupport());
    run(() => refreshModelCatalog());
  }, [run, refreshFastSupport, refreshModelCatalog]);
  // The profile's reviewer, where this window holds none for it yet. A pick made while the answer was
  // on its way is newer, and stays.
  useEffect(() => {
    let live = true;
    if (!heldReviewer(profileId)) {
      codeReview.reviewerPick(profileId).then((r) => { if (live && r.pick && !heldReviewer(profileId)) hold(r.pick); }, () => {});
    }
    return () => { live = false; };
  }, [profileId, hold]);
  const { agentKind: kind, model } = pick;
  const catalog = useMemo(() => reviewerCatalog({ pick: { agentKind: kind, model }, agentProbe, favorites, info, effortSupport, fastSupport }),
    [kind, model, agentProbe, favorites, info, effortSupport, fastSupport]);
  /* A change is the profile's at once: there is no Save for a pick. Laid over the pick as it is now
     rather than as this render saw it, so a level set straight after a model lands on that model. */
  const choose = (patch: Partial<ReviewerPick>) => {
    const next = { ...(heldReviewer(profileId) ?? firstReviewer(lastAgentKind, defaultModels, agentProbe)), ...patch };
    hold(next);
    run(() => codeReview.setReviewerPick(profileId, next));
  };
  const effort: EffortControl | undefined = catalog.levels.levels.length === 0 ? undefined
    : { ...catalog.levels, value: pick.effort, onChange: (id) => choose({ effort: id }) };
  // Nothing has run on the pick, so nothing has reported: the bolt is the request, and the review checks it.
  const fast: FastMode | undefined = catalog.fast.state === "none" ? undefined
    : { on: pick.fastMode, state: null, reason: null, requested: null, onChange: (on) => choose({ fastMode: on }), availability: catalog.fast, tip: catalog.tip };
  const runs = reviewRun(pick, catalog);
  const label = chipLabel(kind, model, catalog.rows);
  const level = runs.effort ? formatEffort(runs.effort) : null;
  const [open, setOpen] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const running = review?.state === "running";
  const reviewer = useReviewerName(review?.agentKind ?? kind, review?.model ?? null, review?.effort ?? null);
  const blocked = reviewBlocked(detail, place !== null, running);
  const start = () => run(async () => {
    if (!detail || !place) return;
    onStarted(await codeReview.review({ ref: pr, profileId, spaceId: place.spaceId, projectId: place.projectId, agentKind: kind, model, ...runs }));
  });
  return (
    <span className="cr-review-with" role="group" aria-label="Review with a model">
      <button type="button" className="btn cr-review-run" disabled={blocked !== null} aria-busy={running || undefined} onClick={start}
        title={running ? `${reviewerPhrase(reviewer.label, reviewer.level)} is reviewing this pull request`
          : blocked ?? `A read-only ${reviewerPhrase(label, level, runs.fastMode)} reads the diff and leaves findings for you — nothing is posted`}>
        <Icon name={AGENT_META[running && review ? review.agentKind : kind].icon} size={14} colored />
        {/* The verb and the model apart, so a narrow bar can keep the verb (styles.css); the level and
            the bolt are part of the model's name, and go with it. */}
        <span className="cr-review-label">{running ? "Reviewing…" : (
          <>Review<span className="cr-review-model"> with <ReviewerName label={label} level={level} />
            {runs.fastMode && <><Icon name="zap" size={12} className="cr-review-fast" /><span className="visually-hidden"> in fast mode</span></>}</span></>
        )}</span>
      </button>
      <button ref={more} type="button" className="icon-btn cr-review-more" aria-label="Review instructions" title="How to review — the model and your instructions"
        aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}><Icon name="chevronDown" size={12} /></button>
      {open && (
        <InstructionsPopover anchorRef={more} profileId={profileId} pick={pick} rows={catalog.rows} effort={effort} fast={fast}
          onPick={(agentKind, picked) => choose({ agentKind, model: picked })} onClose={() => setOpen(false)} blocked={blocked} onRun={start} />
      )}
    </span>
  );
}

/**
 * "Tell the reviewer how to review your code": the model, and the profile's standing instructions,
 * which every review in the profile follows. Add example offers what people tell a reviewer, one a
 * press, appended where the person can edit it. Save and run does both in that order.
 */
function InstructionsPopover({ anchorRef, profileId, pick, rows, effort, fast, onPick, onClose, blocked, onRun }: {
  anchorRef: RefObject<HTMLButtonElement | null>; profileId: string; pick: ReviewerPick; rows: ModelRow[];
  /** The picked model's level and fast mode as its card sets them, or absent where its harness takes neither. */
  effort?: EffortControl; fast?: FastMode;
  onPick: (kind: AgentKind, model: string | null) => void; onClose: () => void;
  /** Why the review cannot start now, or null when Save and run may run it. */
  blocked: string | null; onRun: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const { pos, closing, close } = useAnchoredPopover({ ref, anchorRef, align: "right", onClose, returnFocusRef: anchorRef, exit: true });
  const run = useApp((s) => s.run);
  const modelInfo = useApp((s) => s.modelInfo);
  const eggs = useApp((s) => s.easterEggs);
  const probeAgents = useApp((s) => s.probeAgents);
  const refreshModelFavorites = useApp((s) => s.refreshModelFavorites);
  const toggleModelFavorite = useApp((s) => s.toggleModelFavorite);
  useEffect(() => {
    run(() => probeAgents());
    run(() => refreshModelFavorites());
  }, [probeAgents, refreshModelFavorites, run]);
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
            keys, and the card under the list for the level and fast mode — a pick leaves it open, so
            a model and how it runs are set in one visit. Opened from in here it is part of this
            popover while it is up (use-anchored-popover). */}
        <ModelPicker kind={pick.agentKind} model={pick.model} effort={effort} fast={fast} rows={rows} info={modelInfo} eggs={eggs}
          onToggleFavorite={(key) => run(() => toggleModelFavorite(key))} onPick={onPick} />
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
