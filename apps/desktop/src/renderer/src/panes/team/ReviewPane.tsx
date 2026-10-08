import { Icon } from "@realm/ui";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { mediaUrl, type TeamReviewDetail, type TeamReviewItem, type TeamReviewSummary } from "@realm/contracts";
import { useDissolve } from "../../components/ScrollFades";
import { REVIEW_GLYPH } from "../../components/sidebar/TeamRows";
import { useApp } from "../../state/store";
import type { Item } from "@realm/contracts";
import { ageShort, agoPhrase, duration, feedTime, money, reviewGroups, reviewStateLine } from "./team-format";

const IMAGE = /\.(png|jpe?g|gif|webp|heic|avif)$/i;
const ONE: Record<TeamReviewSummary["kind"], string> = { slideshows: "slideshow", message: "message", document: "document", report: "report" };
const EMPTY: readonly TeamReviewSummary[] = [];

/**
 * A space's Review: the list of what its team made and the one being read, Mail's shape (the Teams
 * plan, section 7). The list is grouped Waiting for you / Approved, not posted / Done this week; the
 * reading side shows the deliverable at the width it needs, the caption, what Realm checked, and how
 * it was made, with the run's dollars and minutes in the byline. The decision sits OUTSIDE the
 * scroller, so it never dissolves with the content (design.md).
 *
 * A card stays where it was while the pane is open — approving one swaps its state line in place, and
 * it moves to "Approved" the next time the list is opened — because a row never moves out from under
 * a press. Nothing here posts: Phase 1's Approve marks the batch ready, and the person posts it.
 */
/** The bar's far end: the waiting mark, while something waits — what the Review row says, on the pane. */
export function ReviewMeta({ item }: { item: Item }) {
  const waiting = useApp((s) => (s.teams[item.refId]?.reviews ?? EMPTY).filter((r) => r.state === "waiting").length);
  return waiting > 0 ? <span className="status-dot" data-status="waiting_permission" title={`${waiting} waiting for your review`} /> : null;
}

export function ReviewPane({ item }: { item: Item; visible: boolean; focused?: boolean }) {
  const spaceId = item.refId;
  const team = useApp((s) => s.teams[spaceId]);
  const root = useApp((s) => s.spaces.find((sp) => sp.id === spaceId)?.folderPath ?? null);
  const reviews = team?.reviews ?? EMPTY;
  const selectedId = useApp((s) => s.teamReviewSelected[spaceId]);
  const selectTeamReview = useApp((s) => s.selectTeamReview);
  /* Which group each card sat in when the pane opened, so a decision never moves the row under the
     pointer. A review that arrives later takes its own group. */
  const placed = useRef(new Map<string, string>());
  const groups = useMemo(() => {
    const fresh = reviewGroups(reviews);
    for (const g of fresh) for (const r of g.rows) if (!placed.current.has(r.id)) placed.current.set(r.id, g.label);
    const order = ["Waiting for you", "Approved, not posted", "Done this week"];
    const shown = reviews.filter((r) => placed.current.has(r.id) && (r.state !== "dismissed"));
    return order.map((label) => ({ label, rows: shown.filter((r) => placed.current.get(r.id) === label).sort((a, b) => b.createdAt - a.createdAt) }))
      .filter((g) => g.rows.length > 0);
  }, [reviews]);
  const flat = groups.flatMap((g) => g.rows);
  const selected = flat.find((r) => r.id === selectedId) ?? flat[0] ?? null;
  const waiting = reviews.filter((r) => r.state === "waiting").length;
  const list = useRef<HTMLDivElement>(null);
  useDissolve(list);

  // ↑/↓ walk the list as Mail's does; the card under the keyboard is the one being read.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const at = flat.findIndex((r) => r.id === selected?.id);
    const next = flat[Math.max(0, Math.min(flat.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))];
    if (!next) return;
    e.preventDefault();
    selectTeamReview(spaceId, next.id);
    list.current?.querySelector<HTMLElement>(`[data-review="${next.id}"]`)?.focus();
  };

  return (
    <div className="rv">
      <div className="rv-list">
        <div className="rv-list-head">
          <h2>Review</h2>
          <span className="page-vantage">{waiting > 0 ? `${waiting} waiting` : "Nothing waiting"}</span>
        </div>
        <div className="rv-scroll" ref={list} onKeyDown={onKeyDown} role="list" aria-label="Reviews">
          {groups.length === 0 && <p className="rv-empty">When a role sends work for your yes, it arrives here.</p>}
          {groups.map((g) => (
            <div key={g.label} role="presentation">
              <div className="rv-group">{g.label}</div>
              {g.rows.map((r) => (
                <ReviewCard key={r.id} review={r} root={root} selected={r.id === selected?.id} onSelect={() => selectTeamReview(spaceId, r.id)} />
              ))}
            </div>
          ))}
        </div>
      </div>
      {selected ? <ReviewDetail key={selected.id} summary={selected} /> : <div className="rv-detail rv-detail-empty" />}
    </div>
  );
}

function ReviewCard({ review, root, selected, onSelect }: { review: TeamReviewSummary; root: string | null; selected: boolean; onSelect: () => void }) {
  const thumb = review.thumb && root ? mediaUrl(`${root}/${review.thumb}`) : null;
  const state = reviewStateLine(review);
  const meta = [review.roleName, review.channels.length ? review.channels.join(" + ") : kindWord(review)].filter(Boolean).join(" · ");
  return (
    <button type="button" className="rv-card" role="listitem" data-review={review.id} data-selected={selected || undefined}
      aria-current={selected || undefined} tabIndex={selected ? 0 : -1} onClick={onSelect}
      aria-label={`${review.title} — ${meta} — ${state.text}`}>
      {thumb
        ? <img className="rv-thumb" src={thumb} alt="" draggable={false} />
        : <span className="rv-thumb-glyph"><Icon name={REVIEW_GLYPH[review.kind]} size={20} /></span>}
      <span className="rv-title">{review.title}</span>
      <span className="rv-age">{ageShort(review.createdAt)}</span>
      <span className="rv-meta">{meta}</span>
      <span className="rv-state">{state.dot && <span className="t-dot" data-s="waiting" />}{state.text}</span>
    </button>
  );
}

const kindWord = (r: TeamReviewSummary) => (r.kind === "message" ? "email draft" : r.kind === "report" ? "report" : r.kind === "document" ? "document" : `${r.itemCount} ${ONE[r.kind]}${r.itemCount === 1 ? "" : "s"}`);

function ReviewDetail({ summary }: { summary: TeamReviewSummary }) {
  const detail = useApp((s) => s.teamReviewDetail[summary.id]);
  const loadTeamReview = useApp((s) => s.loadTeamReview);
  const run = useApp((s) => s.run);
  // The summary moves with `team.changed`; the detail is re-read with it (team-slice.ts).
  useEffect(() => { run(() => loadTeamReview(summary.id).then(() => undefined)); }, [summary.id, summary.updatedAt, loadTeamReview, run]);
  const [step, setStep] = useState(0);
  const [showPrevious, setShowPrevious] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  useDissolve(scroller);
  if (!detail) return <div className="rv-detail" aria-busy="true" />;
  const items = showPrevious && detail.previous.length > 0 ? latestPrevious(detail.previous) : detail.items;
  const at = Math.min(step, Math.max(0, items.length - 1));
  const item = items[at];
  const many = items.length > 1;
  const title = many ? `${detail.title} — ${ONE[detail.kind]} ${at + 1} of ${items.length}` : detail.title;
  return (
    <div className="rv-detail">
      <div className="rv-detail-scroll" ref={scroller}>
        <div className="rv-head">
          <div className="rv-head-text">
            <h1>{title}</h1>
            <div className="rv-byline">
              {detail.recordName && <span>For <b>{detail.recordName}</b></span>}
              {detail.roleName && <span className={detail.recordName ? "t-sep" : undefined}>made by {detail.roleName}</span>}
              <span className="t-sep t-num">{agoPhrase(detail.createdAt)}</span>
              {(detail.costUsd !== null || detail.durationMs !== null) && (
                <span className="t-sep t-num" title="What the run that made it spent, in API-equivalent dollars, and how long it took">
                  {[detail.costUsd !== null ? money(detail.costUsd) : null, detail.durationMs !== null ? duration(detail.durationMs) : null].filter(Boolean).join(" · ")}
                </span>
              )}
            </div>
          </div>
          {many && (
            <fieldset className="settings-tabs rv-stepper" aria-label={`${ONE[detail.kind]} to read`}>
              {items.map((it, i) => (
                <label key={it.id} className="settings-tab" data-selected={i === at || undefined}>
                  <input type="radio" name={`rv-step-${detail.id}`} checked={i === at} onChange={() => setStep(i)} />{i + 1}
                </label>
              ))}
            </fieldset>
          )}
        </div>
        {detail.version > 1 && (
          <p className="rv-version">
            {showPrevious ? `Version ${detail.version - 1}, before your changes.` : `Version ${detail.version}, after you asked: “${detail.note ?? "changes"}”${/[.!?]$/.test(detail.note ?? "") ? "" : "."}`}{" "}
            <button type="button" className="btn-quiet rv-version-toggle" onClick={() => { setShowPrevious((v) => !v); setStep(0); }}>
              {showPrevious ? `Back to version ${detail.version}` : `Show version ${detail.version - 1}`}
            </button>
          </p>
        )}
        {item && <Deliverable detail={detail} item={item} />}
        <div className="rv-cols">
          {item?.body && (
            <section className="rv-section">
              <h3>{detail.kind === "message" ? "Message" : "Caption"}</h3>
              <div className="rv-caption">{item.body}</div>
            </section>
          )}
          <section className="rv-section">
            <h3>{detail.kind === "message" ? "Before it can send" : "Before it can post"}</h3>
            <ul className="rv-checks">
              {detail.checks.map((c) => (
                <li key={c.title}>
                  <span className={c.ok === true ? "ok" : c.ok === false ? "warn" : "quiet"}>
                    <Icon name={c.ok === true ? "checkCircle" : c.ok === false ? "alert" : "info"} size={16} />
                  </span>
                  <span>{c.title}<small>{c.detail}</small></span>
                </li>
              ))}
            </ul>
          </section>
        </div>
        {detail.ledger.length > 0 && (
          <section className="rv-section rv-made">
            <h3>How it was made</h3>
            <ul className="tp-feed">
              {detail.ledger.map((l, i) => (
                <li key={i}>
                  <time>{feedTime(l.ts)}</time>
                  <span className="t-glyph"><Icon name={l.glyph === "inbox" ? "review" : l.glyph === "note" ? "note" : l.glyph === "image" ? "image" : "alarm"} size={12} /></span>
                  <span>{l.text}{l.detail && <small> · {l.detail}</small>}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <DecisionBar detail={detail} />
    </div>
  );
}

/** The newest earlier version's items — the one a person compares against. */
function latestPrevious(items: TeamReviewItem[]): TeamReviewItem[] {
  const v = Math.max(...items.map((i) => i.version));
  return items.filter((i) => i.version === v).sort((a, b) => a.ord - b.ord);
}

/** The thing itself, at the width it needs: a strip of 9:16 slides, or the files a message carries. */
function Deliverable({ detail, item }: { detail: TeamReviewDetail; item: TeamReviewItem }) {
  const openViewer = useApp((s) => s.openViewer);
  const root = detail.root;
  const pictures = item.files.filter((f) => IMAGE.test(f));
  const others = item.files.filter((f) => !IMAGE.test(f));
  if (!root) return null;
  const abs = (f: string) => `${root}/${f}`;
  return (
    <>
      {pictures.length > 0 && (
        <>
          <div className="rv-strip" style={{ gridTemplateColumns: `repeat(${Math.max(pictures.length, 5)}, minmax(0, 1fr))` }}>
            {pictures.map((f, i) => (
              <button key={f} type="button" className="rv-slide" aria-label={`Slide ${i + 1}, ${f}. Open it large`}
                onClick={(e) => openViewer({ files: pictures.map((p) => ({ path: abs(p) })), index: i, sessionId: detail.sessionId, spaceId: detail.spaceId, opener: e.currentTarget })}>
                <img src={mediaUrl(abs(f))} alt="" draggable={false} />
                <span className="rv-slide-n">{i + 1}</span>
              </button>
            ))}
          </div>
          <p className="rv-strip-note">{pictures.length} slide{pictures.length === 1 ? "" : "s"} in <span className="t-mono">{folderOf(pictures[0]!)}</span>. Open one to see it full size, or to ask {detail.roleName ?? "the role"} about it.</p>
        </>
      )}
      {others.length > 0 && (
        <ul className="settings-list rv-files">
          {others.map((f) => (
            <li key={f} className="settings-row">
              <Icon name="artifact" size={16} />
              <div className="settings-row-main"><span className="settings-row-name">{f.split("/").pop()}</span><span className="settings-row-detail t-mono">{f}</span></div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

const folderOf = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ".");

/**
 * The decision: a sentence of consequence, then Request changes and the one primary. Approve says
 * how many it approves; nothing is approved by accident and nothing posts. After a yes the bar offers
 * what a person does next by hand — the folder, then marking it posted.
 */
function DecisionBar({ detail }: { detail: TeamReviewDetail }) {
  const decide = useApp((s) => s.decideTeamReview);
  const requestChanges = useApp((s) => s.requestTeamReviewChanges);
  const run = useApp((s) => s.run);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { if (asking) field.current?.focus(); }, [asking]);
  const act = (fn: () => Promise<void>) => { setBusy(true); run(async () => { try { await fn(); } finally { setBusy(false); } }); };
  const n = detail.items.length;
  const reveal = window.realm?.files?.reveal;
  const send = () => { const text = note.trim(); if (!text) return; act(async () => { await requestChanges(detail.id, text); setAsking(false); setNote(""); }); };
  const pending = detail.state === "waiting" || detail.state === "changes";
  const sentence = detail.state === "changes" ? `You asked for changes${detail.decidedAt ? ` at ${feedTime(detail.decidedAt)}` : ""}. ${detail.roleName ?? "The role"} is on it.`
    : detail.state === "approved" ? `Approved by you${detail.decidedAt ? ` at ${feedTime(detail.decidedAt)}` : ""}. ${detail.kind === "message" ? "Realm doesn't send yet — send it yourself." : "Realm doesn't post yet — post it by hand."}`
    : detail.state === "done" ? "Done." : detail.note && detail.changedSinceApproval ? detail.note : detail.kind === "message" ? "Nothing sends until you approve." : "Nothing posts until you approve.";
  return (
    <div className="rv-decide-wrap">
      {asking && (
        <form className="rv-ask" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <input ref={field} className="rv-ask-field" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What should change?"
            aria-label={`What should change in ${detail.title}?`}
            onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setAsking(false); } }} />
          <button type="button" className="btn" onClick={() => setAsking(false)}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!note.trim() || busy}>Send to {detail.roleName ?? "the role"}</button>
        </form>
      )}
      <div className="rv-decide">
        <span className="rv-decide-note">{sentence}</span>
        {pending && !asking && (
          <>
            <button type="button" className="btn" disabled={busy} onClick={() => setAsking(true)}>Request changes</button>
            <button type="button" className="btn primary" disabled={busy || detail.state === "changes"}
              title={detail.state === "changes" ? "Waiting for the new version" : undefined}
              onClick={() => act(() => decide(detail.id, "approve"))}>
              <Icon name="check" size={16} />{n > 1 ? `Approve all ${n}` : "Approve"}
            </button>
          </>
        )}
        {detail.state === "approved" && (
          <>
            {reveal && detail.root && detail.items[0]?.files[0] && (
              <button type="button" className="btn" onClick={() => { void reveal(`${detail.root}/${detail.items[0]!.files[0]}`); }}>Show in Finder</button>
            )}
            <button type="button" className="btn" disabled={busy} onClick={() => act(() => decide(detail.id, "done"))}>Mark as posted</button>
          </>
        )}
      </div>
    </div>
  );
}
