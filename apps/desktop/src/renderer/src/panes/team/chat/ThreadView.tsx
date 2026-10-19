import { Icon, Realmite, parseRealmiteSpec } from "@realm/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { mediaUrl, type TeamReviewSummary, type TeamRole, type TeamSpace } from "@realm/contracts";
import { Markdown } from "../../session/Markdown";
import { Transcript } from "../../session/Transcript";
import type { Transcript as TranscriptModel } from "../../session/transcript-model";
import { realmiteState, reviewGlyph } from "../../../components/sidebar/TeamRows";
import { useApp } from "../../../state/store";
import { useApprovalReceipt } from "../review/Decision";
import { duration, feedTime, goalLine, handoffChip, reviewStateLine } from "../team-format";
import type { ThreadItem, ThreadRow } from "./thread";

/**
 * A teammate's thread as a conversation: the person's words on the right, the teammate's beside its
 * Realmite on the left, and lines across the middle for what happened to it — woken by its clock,
 * stopped at a limit. A group of bubbles from one side wears its avatar and its time once, on its
 * last bubble. What the teammate said is the transcript's own Markdown; the whole run behind it opens
 * in place, drawn by the transcript itself.
 */
export function ThreadView({ items, role, team, now, onSendBack }: {
  items: readonly ThreadItem[];
  role: TeamRole;
  team: TeamSpace;
  now: number;
  /** "Send back" on a draft: the composer takes the changes for it. */
  onSendBack: (review: TeamReviewSummary) => void;
}) {
  // What was there when the chat opened is simply there; only what arrives while it is open rises in.
  const shown = useRef<Set<string> | null>(null);
  shown.current ??= new Set(items.map((i) => i.key));
  const known = shown.current;
  useEffect(() => { for (const i of items) known.add(i.key); }, [items, known]);
  return (
    <div className="tc-thread">
      {items.map((item) => {
        if (item.kind === "day") return <div key={item.key} className="tc-day" role="separator"><span>{item.label}</span></div>;
        if (item.side === "center") return <CenterLine key={item.key} row={item} team={team} enter={!known.has(item.key)} />;
        return (
          <div key={item.key} className="tc-row" data-side={item.side} data-start={item.groupStart || undefined} data-end={item.groupEnd || undefined}
            data-enter={!known.has(item.key) || undefined}>
            {item.side === "them" && (
              <span className="tc-avatar" aria-hidden="true">
                {item.groupStart && <Realmite spec={parseRealmiteSpec(role.realmite, role.id)} size={32} state={realmiteState(role)} />}
              </span>
            )}
            <div className="tc-stack">
              <Entry row={item} role={role} team={team} now={now} onSendBack={onSendBack} />
              {item.groupEnd && item.kind !== "typing" && item.kind !== "said" && <Stamp ts={item.ts} now={now} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Entry({ row, role, team, now, onSendBack }: { row: ThreadRow; role: TeamRole; team: TeamSpace; now: number; onSendBack: (r: TeamReviewSummary) => void }) {
  switch (row.kind) {
    case "you": return (
      <>
        {row.about && <span className="tc-about"><Icon name="undo" size={12} />{row.about}</span>}
        <div className="tc-bubble" data-selectable="">{row.text}</div>
      </>
    );
    case "goal": return (
      <div className="tc-bubble tc-goal">
        <span className="tc-card-kicker"><Icon name="target" size={12} />Goal</span>
        <span data-selectable="">{row.objective}</span>
        {role.goal && role.goal.runId === row.runId && <span className="tc-goal-state">{goalLine(role.goal).text}</span>}
      </div>
    );
    case "said": return <Said row={row} now={now} />;
    case "typing": return <Typing row={row} role={role} now={now} />;
    case "ask": return (
      <div className="tc-card tc-ask" role="note">
        <span className="tc-card-kicker"><span className="status-dot" data-status="waiting_permission" />Asks you</span>
        <span className="tc-ask-text" data-selectable="">{row.question}</span>
        <span className="tc-card-line">Your next message is its answer.</span>
      </div>
    );
    case "draft": return <DraftCard review={row.review} spaceId={team.spaceId} onSendBack={onSendBack} />;
    case "handoff": return <HandoffCard row={row} team={team} />;
    case "record": return <RecordCard row={row} spaceId={team.spaceId} />;
    default: return null;
  }
}

/** What the teammate said for a run, and the run itself one click under it — opened, the run takes
 *  the report's place, since the report is its last word. */
function Said({ row, now }: { row: Extract<ThreadRow, { kind: "said" }>; now: number }) {
  const [open, setOpen] = useState(false);
  const meta = (
    <span className="tc-meta">
      {row.groupEnd && <Stamp ts={row.ts} now={now} />}
      {row.meta && <span className="tc-run-meta">{row.meta}</span>}
      {row.sessionId && (
        <button type="button" className="tc-run-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "Hide the run" : "Show the run"}<Icon name={open ? "chevronUp" : "chevronDown"} size={12} />
        </button>
      )}
    </span>
  );
  if (open && row.sessionId) return <>{meta}<RunLog sessionId={row.sessionId} from={row.from} to={row.to} /></>;
  return <><div className="tc-bubble tc-said" data-selectable=""><Markdown text={row.text} className="md tc-md" /></div>{meta}</>;
}

/** When a group's last word was said, under it. */
function Stamp({ ts, now }: { ts: number; now: number }) {
  return <time className="tc-time" dateTime={new Date(ts).toISOString()} title={new Date(ts).toLocaleString()}>{feedTime(ts, now)}</time>;
}

function Typing({ row, role, now }: { row: Extract<ThreadRow, { kind: "typing" }>; role: TeamRole; now: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="tc-bubble tc-typing" role="status" aria-label={`${role.name} is working`}><i /><i /><i /></div>
      <span className="tc-typing-line">
        Working · {duration(now - row.since)}
        {row.sessionId && (
          <button type="button" className="tc-run-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? "Hide" : "Watch it work"}
          </button>
        )}
      </span>
      {open && row.sessionId && <RunLog sessionId={row.sessionId} from={row.since} to={null} />}
    </>
  );
}

/**
 * One run's stretch of its session, drawn by the transcript itself — tool calls, code, its questions —
 * in a well of its own height. The session's other runs (a conversation continues one session) and
 * the task text Realm sent it are left out: the chat already says what the person asked.
 */
function RunLog({ sessionId, from, to }: { sessionId: string; from: number; to: number | null }) {
  const entry = useApp((s) => s.transcripts[sessionId]);
  const status = useApp((s) => s.sessionStatus[sessionId] ?? s.sessions[sessionId]?.status ?? "idle");
  const openSession = useApp((s) => s.openSession);
  const loadEarlierEvents = useApp((s) => s.loadEarlierEvents);
  const respondPermission = useApp((s) => s.respondPermission);
  const run = useApp((s) => s.run);
  useEffect(() => { if (!entry) run(() => openSession(sessionId)); }, [entry, sessionId, openSession, run]);
  // The run may start before the stretch the session's first read reached.
  const reaches = !entry || !entry.t.earlier || (entry.t.blocks[0]?.ts ?? Infinity) <= from;
  useEffect(() => { if (!reaches) run(() => loadEarlierEvents(sessionId)); }, [reaches, sessionId, loadEarlierEvents, run]);
  const slice = useMemo(() => (entry ? runSlice(entry.t, from, to) : null), [entry, from, to]);
  return (
    <div className="tc-runlog">
      {slice
        ? <Transcript transcript={slice} sessionStatus={to === null ? status : "idle"} visible focused={false} requestsOwnEscape={false}
            onDecide={(requestId, d, answers) => run(() => respondPermission(sessionId, requestId, d, answers))} />
        : <p className="tp-empty">Loading the run…</p>}
    </div>
  );
}

/** The blocks between a run's start and its end, without the messages Realm sent to start it. */
export function runSlice(t: TranscriptModel, from: number, to: number | null): TranscriptModel {
  const start = t.blocks.findIndex((b) => b.ts >= from);
  const first = start < 0 ? t.blocks.length : start;
  const blocks = t.blocks.slice(first).filter((b) => (to === null || b.ts <= to) && b.kind !== "user");
  const { earlier: _held, ...rest } = t;
  return { ...rest, blocks, base: (t.base ?? 0) + first, summary: null, promptHint: null };
}

/** A draft waiting for the person: what it is, where it stands, and the two answers Review gives. */
function DraftCard({ review, spaceId, onSendBack }: { review: TeamReviewSummary; spaceId: string; onSendBack: (r: TeamReviewSummary) => void }) {
  const space = useApp((s) => s.spaces.find((x) => x.id === spaceId));
  const decide = useApp((s) => s.decideTeamReview);
  const openTeamReview = useApp((s) => s.openTeamReview);
  const run = useApp((s) => s.run);
  const approvalReceipt = useApprovalReceipt();
  const [busy, setBusy] = useState(false);
  const open = review.state === "waiting";
  const line = reviewStateLine(review);
  const approve = () => { setBusy(true); run(async () => { try { await decide(review.id, "approve"); approvalReceipt(review.id); } finally { setBusy(false); } }); };
  return (
    <div className="tc-card tc-draft" data-open={open || undefined}>
      <div className="tc-draft-head">
        {review.thumb && space
          ? <img className="tc-draft-thumb" src={mediaUrl(`${space.folderPath}/${review.thumb}`)} alt="" draggable={false} />
          : <span className="tc-draft-glyph"><Icon name={reviewGlyph(review)} size={16} /></span>}
        <span className="tc-draft-text">
          <span className="tc-card-title">{review.title}</span>
          <span className="tc-card-line">
            {line.dot && <span className="status-dot" data-status="waiting_permission" />}
            {line.text}{review.itemCount > 1 ? ` · ${review.itemCount} items` : ""}
          </span>
        </span>
      </div>
      <div className="tc-draft-actions">
        {open && <button type="button" className="btn primary" disabled={busy} onClick={approve}>Approve</button>}
        {open && <button type="button" className="btn" onClick={() => onSendBack(review)}>Send back</button>}
        <button type="button" className="btn-quiet" onClick={() => run(() => openTeamReview(spaceId, review.id))}>Open in Review</button>
      </div>
    </div>
  );
}

function HandoffCard({ row, team }: { row: Extract<ThreadRow, { kind: "handoff" }>; team: TeamSpace }) {
  const setSpacePageTab = useApp((s) => s.setSpacePageTab);
  const h = row.handoff;
  const live = h.otherId ? team.roles.find((r) => r.id === h.otherId) : undefined;
  const other = live ?? (h.otherId ? team.formerRoles.find((r) => r.id === h.otherId) : undefined);
  const chip = h.state ? handoffChip(h.state) : null;
  return (
    <div className="tc-card tc-handoff">
      <span className="tc-card-kicker">
        {other ? <Realmite spec={parseRealmiteSpec(other.realmite, other.id)} size={16} {...(live ? { state: realmiteState(live) } : {})} /> : <Icon name="user" size={12} />}
        {row.direction === "in" ? `${h.otherName} handed over work` : `Handed work to ${h.otherName}`}
        {chip && <span className="tp-chip" data-tone={chip.tone ?? undefined}>{chip.word}</span>}
      </span>
      <span className="tc-handoff-note" data-selectable="">“{h.note}”</span>
      {(h.recordPath || h.files.length > 0) && (
        <span className="tc-card-line">{[h.recordPath, h.files.length ? `${h.files.length} file${h.files.length === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ")}</span>
      )}
      {live && (
        <button type="button" className="btn-quiet tc-card-link" onClick={() => setSpacePageTab(team.spaceId, `role:${live.id}`)}>Open {h.otherName}'s chat</button>
      )}
    </div>
  );
}

function RecordCard({ row, spaceId }: { row: Extract<ThreadRow, { kind: "record" }>; spaceId: string }) {
  const setSpacePageTab = useApp((s) => s.setSpacePageTab);
  return (
    <div className="tc-card tc-record">
      <span className="tc-card-kicker"><Icon name="records" size={12} />Updated {row.name}'s record</span>
      {row.line && <span className="tc-card-line" data-selectable="">{row.line}</span>}
      {row.path && <button type="button" className="btn-quiet tc-card-link" onClick={() => setSpacePageTab(spaceId, `record:${row.path}`)}>Open the record</button>}
    </div>
  );
}

/** A line across the thread: a wake, an end, a skip, or work another teammate handed over. */
function CenterLine({ row, team, enter }: { row: ThreadRow; team: TeamSpace; enter: boolean }) {
  if (row.kind === "handoff") return <div className="tc-row" data-side="center" data-enter={enter || undefined}><HandoffCard row={row} team={team} /></div>;
  if (row.kind !== "note") return null;
  return (
    <div className="tc-note" data-tone={row.tone === "plain" ? undefined : row.tone} data-enter={enter || undefined}>
      <Icon name={row.glyph} size={12} />
      <span>{row.text}{row.detail && <span className="tc-note-detail" data-selectable=""> · {row.detail}</span>}</span>
    </div>
  );
}
