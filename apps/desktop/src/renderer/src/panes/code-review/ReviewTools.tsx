import { Icon } from "@realm/ui";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  AGENT_META, AGENT_MODELS, AGENT_SUPPORTS_PLAN_MODE, AgentKindSchema, DEFAULT_MODEL_LABEL, REVIEW_INSTRUCTIONS_MAX, REVIEW_INSTRUCTION_EXAMPLES,
  prName, type AgentKind, type PrDetail, type PrPlace, type PrRef, type PrReview,
} from "@realm/contracts";
import { useDissolve } from "../../components/ScrollFades";
import { useAnchoredPopover } from "../../components/use-anchored-popover";
import { FALLBACK_AGENT, useApp } from "../../state/store";
import { groupRows, modelLabel, modelRows } from "../session/model-catalog";
import { EMPTY_DRAFT, REVIEW_EVENTS, canSubmit, isOwnRequest, postsLine, reviewPayload, type ReviewDraft } from "./code-review-model";
import { codeReview } from "./code-review-api";
import { reviewerPick } from "./held";

type Pick = { kind: AgentKind; model: string | null };
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** A reviewer runs read-only, so only an agent Realm can hold to that is offered (`review` refuses
 *  the rest on the server, delegation/review.ts's rule). */
const canReview = (kind: AgentKind) => AGENT_SUPPORTS_PLAN_MODE[kind] === true;

/** A model's name as the picker writes it: "Fable 5.1", "GPT-5.6". */
export function useReviewerLabel(kind: AgentKind, model: string | null): string {
  const agentProbe = useApp((s) => s.agentProbe);
  return useMemo(() => {
    if (model === null) return DEFAULT_MODEL_LABEL[kind];
    const known = [...(agentProbe.find((p) => p.kind === kind)?.models ?? []), ...AGENT_MODELS[kind]].find((m) => m.id === model);
    return known?.label ?? model;
  }, [kind, model, agentProbe]);
}

/**
 * Review with… — a reviewer on the model the person picks, over this request's diff, under their
 * saved instructions; the gear beside it is where both are set. The findings land on the page; none
 * of them is posted unless the person adds it to their review and presses Submit.
 */
export function ReviewWith({ pr, detail, profileId, place, review, onStarted }: {
  pr: PrRef; detail: PrDetail | null; profileId: string; place: PrPlace | null; review: PrReview | null; onStarted: (r: PrReview) => void;
}) {
  const lastAgentKind = useApp((s) => s.lastAgentKind);
  const run = useApp((s) => s.run);
  const [pick, setPickState] = useState<Pick>(() => reviewerPick.current
    ?? { kind: lastAgentKind && canReview(lastAgentKind) ? lastAgentKind : FALLBACK_AGENT, model: null });
  const setPick = (p: Pick) => { reviewerPick.current = p; setPickState(p); };
  const label = useReviewerLabel(pick.kind, pick.model);
  const [open, setOpen] = useState(false);
  const gear = useRef<HTMLButtonElement>(null);
  const running = review?.state === "running";
  const start = () => run(async () => {
    if (!detail || !place) return;
    onStarted(await codeReview.review({ ref: pr, profileId, spaceId: place.spaceId, projectId: place.projectId, agentKind: pick.kind, model: pick.model }));
  });
  return (
    <span className="cr-bar-group cr-review-with" role="group" aria-label="Review with a model">
      <button type="button" className="btn cr-review-run" disabled={!detail || !place || running} aria-busy={running || undefined} onClick={start}
        title={running ? "A review of this pull request is running" : `A read-only ${label} reads the diff and leaves findings for you — nothing is posted`}>
        {running ? "Reviewing…" : `Review with ${label}`}
      </button>
      <button ref={gear} type="button" className="icon-btn" aria-label="Review instructions" title="How to review — the model and your instructions"
        aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}><Icon name="settings" size={14} /></button>
      {open && (
        <InstructionsPopover anchorRef={gear} profileId={profileId} pick={pick} onPick={setPick} onClose={() => setOpen(false)}
          canRun={!!detail && !!place && !running} onRun={start} />
      )}
    </span>
  );
}

/**
 * "Tell the reviewer how to review your code": the model, and the profile's standing instructions,
 * which every review in the profile follows. Add example offers what people tell a reviewer, one a
 * press, appended where the person can edit it. Save and run does both in that order.
 */
function InstructionsPopover({ anchorRef, profileId, pick, onPick, onClose, canRun, onRun }: {
  anchorRef: RefObject<HTMLButtonElement | null>; profileId: string; pick: Pick; onPick: (p: Pick) => void; onClose: () => void;
  canRun: boolean; onRun: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const { pos, closing, close } = useAnchoredPopover({ ref, anchorRef, align: "right", onClose, returnFocusRef: anchorRef, exit: true });
  const run = useApp((s) => s.run);
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
      <label className="cr-pop-row">
        <span>Review with</span>
        <ReviewerModelSelect pick={pick} onPick={onPick} />
      </label>
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
        <button type="button" className="btn primary" disabled={text === null || over || !canRun}
          onClick={() => run(async () => { await save(); close(); onRun(); })}>Save and run</button>
      </div>
    </div>,
    document.body,
  );
}

/** The models a reviewer can run on, as the prompter's picker groups them — read-only agents only. */
function ReviewerModelSelect({ pick, onPick }: { pick: Pick; onPick: (p: Pick) => void }) {
  const agentProbe = useApp((s) => s.agentProbe);
  const favorites = useApp((s) => s.modelFavorites);
  const probeAgents = useApp((s) => s.probeAgents);
  const run = useApp((s) => s.run);
  useEffect(() => { run(() => probeAgents()); }, [probeAgents, run]);
  const value = (k: AgentKind, m: string | null) => `${k}|${m ?? ""}`;
  const groups = useMemo(() => {
    const rows = modelRows({ kind: pick.kind, model: pick.model, agentProbe, canSwitchAgent: true, favorites }).filter((r) => canReview(r.kind));
    const out = groupRows(rows, { query: "", kind: pick.kind }).map((g) => ({
      label: g.label, options: g.rows.filter((r) => canReview(r.kind)).map((r) => ({ value: value(r.kind, r.modelId), label: g.byHarness ? r.agentLabel : modelLabel(r) })),
    })).filter((g) => g.options.length > 0);
    // The scripted agent, where this Realm runs one: a check that drives the page has to pick it here.
    if (agentProbe.some((p) => p.kind === "fake")) out.push({ label: AGENT_META.fake.label, options: AGENT_MODELS.fake.map((m) => ({ value: value("fake", m.id), label: m.label })) });
    return out;
  }, [pick.kind, pick.model, agentProbe, favorites]);
  const selected = value(pick.kind, pick.model);
  const listed = groups.some((g) => g.options.some((o) => o.value === selected));
  return (
    <select className="cr-select" aria-label="Review with" value={selected}
      onChange={(e) => {
        const [k, m] = e.target.value.split("|");
        const parsed = AgentKindSchema.safeParse(k);
        if (parsed.success) onPick({ kind: parsed.data, model: m ? m : null });
      }}>
      {!listed && <option value={selected}>{pick.model ?? DEFAULT_MODEL_LABEL[pick.kind]}</option>}
      {groups.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </optgroup>
      ))}
    </select>
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
