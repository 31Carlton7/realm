import { Icon } from "@realm/ui";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  AGENT_META, PR_PATCHES_PER_CALL, prKey, type AgentKind, type FileDiff, type Finding, type PrDetail, type PrFile, type PrFiles, type PrReview, type ReviewSide,
} from "@realm/contracts";
import { Menu, type MenuItem } from "../../components/Menu";
import { useDissolve } from "../../components/ScrollFades";
import { FALLBACK_AGENT, useApp } from "../../state/store";
import { Markdown } from "../session/Markdown";
import { SplitPatch, UnifiedPatch } from "../diff/PatchView";
import { rowLineKey } from "../diff/split-rows";
import { dropComment, isKept, keepFinding, type DraftComment, type ReviewDraft } from "./code-review-model";
import { codeReview } from "./code-review-api";
import { fileTree, filterFiles, treeRows } from "./file-tree";
import { atHead, heldFiles, heldLines, heldPatches, patchId } from "./held";
import { ReviewerName, useReviewerName } from "./ReviewTools";

type SetDraft = (d: ReviewDraft | ((d: ReviewDraft) => ReviewDraft)) => void;
/** Who wrote a finding: the reviewer's harness, for its mark, its model's name and the level it ran at. */
type Reviewer = { kind: AgentKind; label: string; level: string | null };

/** The status as one letter, the way the diff pane and `git status` write it. */
const LETTER: Record<PrFile["status"], string> = { added: "A", modified: "M", deleted: "D", renamed: "R", copied: "C", changed: "T" };

/** A file's height before it has been drawn: its head, and a row a line. Measured as soon as it is
 *  drawn; until then this is what the scrollbar is built from, so it errs toward the real thing. */
const HEAD_H = 44, ROW_H = 20;
function estimate(f: PrFile, split: boolean, hidden: boolean): number {
  if (hidden) return HEAD_H;
  if (f.patch !== "text") return HEAD_H + 48;
  const rows = split ? Math.max(f.additions, f.deletions) : f.additions + f.deletions;
  return HEAD_H + 16 + Math.min(rows + 8, 4000) * ROW_H;
}
/** How far past the visible edge files are drawn: a screen's worth each way, so a flick of the
 *  trackpad lands on drawn content rather than on spacers. */
const OVERSCAN = 1200;

/**
 * The Changes tab: every changed file, side by side or as one column, with the tree of them beside.
 *
 * A big request stays quick because only what is near the screen exists. The list is WINDOWED —
 * the files above and below the view are spacers of their measured (or estimated) height — and a
 * file's patch is asked for when it first comes near the view, a screen's worth at a time, from the
 * server's copy of the request's files. Nothing about 600 files costs more than the dozen on screen.
 */
export function PrChanges({ detail, review, draft, setDraft, split, tree, jump }: {
  detail: PrDetail; review: PrReview | null; draft: ReviewDraft; setDraft: SetDraft;
  split: boolean; tree: boolean; jump: { path: string; line: number; side: ReviewSide; n: number } | null;
}) {
  const key = prKey(detail.ref);
  const run = useApp((s) => s.run);
  const [files, setFiles] = useState<PrFiles | null>(() => heldFiles.get(atHead(key, detail.headSha)) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [, bump] = useState(0);
  const repaint = useCallback(() => bump((n) => n + 1), []);
  const headSha = files?.headSha ?? detail.headSha;

  useEffect(() => {
    if (files) return;
    let live = true;
    codeReview.files(detail.ref, detail.headSha).then(
      (f) => { if (!live) return; heldFiles.set(atHead(key, f.headSha), f); setFiles(f); },
      (e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)); },
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per head
  }, [key, detail.headSha]);

  const shown = useMemo(() => (files ? filterFiles(files.files, filter) : []), [files, filter]);

  /* Patches, asked for in batches as files come near the view. */
  const wanted = useRef(new Set<string>());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const want = useCallback((paths: string[]) => {
    if (!files) return;
    for (const p of paths) if (!heldPatches.has(patchId(key, headSha, p))) wanted.current.add(p);
    if (wanted.current.size === 0 || flushTimer.current) return;
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null;
      const batch = [...wanted.current].slice(0, PR_PATCHES_PER_CALL);
      for (const p of batch) wanted.current.delete(p);
      codeReview.patches(detail.ref, headSha, batch).then((r) => {
        for (const patch of r.patches) heldPatches.set(patchId(key, headSha, patch.path), patch);
        repaint();
        if (wanted.current.size > 0) want([]);
      }, (e: unknown) => run(() => Promise.reject(e)));
    }, 16);
  }, [files, key, headSha, detail.ref, repaint, run]);
  useEffect(() => () => { if (flushTimer.current) clearTimeout(flushTimer.current); }, []);

  const scroller = useRef<HTMLDivElement>(null);
  const win = useFileWindow(scroller, shown, split, hidden);
  useEffect(() => { want(win.drawn.map((f) => f.path).filter((p) => shown.find((f) => f.path === p)?.patch === "text")); }, [win.drawn, want, shown]);

  // A finding's "Show in changes": the file to the top, then its line to the middle once drawn.
  const pendingJump = useRef<typeof jump>(null);
  useEffect(() => {
    if (!jump) return;
    pendingJump.current = jump;
    setFilter("");
    setHidden((h) => { if (!h.has(jump.path)) return h; const n = new Set(h); n.delete(jump.path); return n; });
    win.scrollTo(jump.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new jump is a new `n`
  }, [jump?.n]);
  useLayoutEffect(() => {
    const j = pendingJump.current; if (!j) return;
    const el = scroller.current?.querySelector<HTMLElement>(`[data-file="${CSS.escape(j.path)}"] [data-line="${j.side}:${j.line}"]`);
    if (el) { el.scrollIntoView({ block: "center" }); pendingJump.current = null; }
  });

  const findings = useMemo(() => {
    const by = new Map<string, Finding[]>();
    for (const f of review?.findings ?? []) if (f.anchored) by.set(f.path, [...(by.get(f.path) ?? []), f]);
    return by;
  }, [review]);
  const { label: reviewerLabel, level: reviewerLevel } = useReviewerName(review?.agentKind ?? FALLBACK_AGENT, review?.model ?? null, review?.effort ?? null);
  const reviewer = useMemo<Reviewer | null>(() => (review ? { kind: review.agentKind, label: reviewerLabel, level: reviewerLevel } : null), [review, reviewerLabel, reviewerLevel]);

  if (error) return <div className="cr-empty"><h2 className="cr-empty-title">The changes could not be read</h2><p className="cr-empty-line">{error}</p></div>;
  if (!files) return <div className="cr-empty"><p className="cr-empty-line">Reading the changed files…</p></div>;

  const toggleHidden = (path: string) => setHidden((h) => { const n = new Set(h); if (!n.delete(path)) n.add(path); return n; });
  return (
    <div className="cr-changes" data-tree={tree || undefined}>
      <div ref={scroller} className="cr-diffs">
        {files.truncated && <p className="diff-note">GitHub lists the first {files.files.length} of {detail.changedFiles} changed files; the rest are on GitHub.</p>}
        {shown.length === 0 && <p className="cr-empty-line cr-diffs-none">{filter ? "No changed file matches that." : "This pull request changes no files."}</p>}
        <div style={{ height: win.top, overflowAnchor: "none" }} aria-hidden="true" />
        {win.drawn.map((f) => (
          <FileDiffBlock key={f.path} file={f} detail={detail} headSha={headSha} split={split} hidden={hidden.has(f.path)}
            patch={heldPatches.get(patchId(key, headSha, f.path))} measure={win.measure}
            findings={findings.get(f.path) ?? []} reviewer={reviewer} draft={draft} setDraft={setDraft} onToggle={() => toggleHidden(f.path)} />
        ))}
        <div style={{ height: win.bottom, overflowAnchor: "none" }} aria-hidden="true" />
      </div>
      {tree && <FileTreeColumn files={files.files} shown={shown} filter={filter} onFilter={setFilter} current={win.current} onPick={(p) => win.scrollTo(p)} />}
    </div>
  );
}

/**
 * The window over a list of files: which are drawn, the spacers' heights either side, the file at
 * the top of the view, and a way to bring one to the top. Heights are measured as files are drawn.
 *
 * What a measurement above the view does to the line being read is the browser's to settle: its
 * scroll anchoring holds the visible file still while the content above it changes height. Doing it
 * here as well counted every change twice — at the end of the list, where the browser also clamps,
 * each measurement pushed the view a file further up, until Show-the-end landed near the top. The
 * spacers are kept out of anchor selection, so the anchor is always a file.
 */
function useFileWindow(scroller: RefObject<HTMLDivElement | null>, files: readonly PrFile[], split: boolean, hidden: ReadonlySet<string>) {
  const heights = useRef(new Map<string, number>());
  const [view, setView] = useState({ top: 0, height: 800 });
  /** Bumped when a measurement lands, which is what rebuilds the offsets. */
  const [measured, setMeasured] = useState(0);
  const offsets = useMemo(() => {
    const out = new Array<number>(files.length + 1);
    out[0] = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i]!;
      out[i + 1] = out[i]! + (heights.current.get(`${split}:${f.path}`) ?? estimate(f, split, hidden.has(f.path)));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `measured` is the heights map changing
  }, [files, split, hidden, measured]);
  // Read through a ref by `measure`, so its identity holds across every measurement it causes.
  const live = useRef({ split });
  live.current = { split };

  /* Attached to whatever element the ref holds NOW, checked on every render: the scroller is drawn
     only once the files have arrived, so an effect keyed on the ref object alone would run once
     against nothing and never listen (useScrollEdges's own lesson). */
  const attached = useRef<{ el: HTMLElement; off: () => void } | null>(null);
  useEffect(() => {
    const el = scroller.current;
    if (attached.current?.el === el) return;
    attached.current?.off();
    attached.current = null;
    if (!el) return;
    let frame = 0;
    const read = () => { frame = 0; setView((v) => (v.top === el.scrollTop && v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight })); };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(read); };
    read();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(read);
    ro?.observe(el);
    attached.current = { el, off: () => { el.removeEventListener("scroll", onScroll); ro?.disconnect(); if (frame) cancelAnimationFrame(frame); } };
  });
  useEffect(() => () => { attached.current?.off(); attached.current = null; }, []);

  const first = Math.max(0, upper(offsets, view.top - OVERSCAN) - 1);
  const last = Math.min(files.length, upper(offsets, view.top + view.height + OVERSCAN));
  const drawn = useMemo(() => files.slice(first, last), [files, first, last]);
  const current = files[Math.max(0, upper(offsets, view.top + 8) - 1)]?.path ?? null;

  const measure = useCallback((path: string, h: number) => {
    const k = `${live.current.split}:${path}`;
    if (heights.current.get(k) === h) return;
    heights.current.set(k, h);
    setMeasured((n) => n + 1);
  }, []);

  const scrollTo = useCallback((path: string) => {
    const i = files.findIndex((f) => f.path === path);
    if (i >= 0 && scroller.current) scroller.current.scrollTop = offsets[i]!;
  }, [files, offsets, scroller]);

  return { drawn, top: offsets[first] ?? 0, bottom: (offsets[files.length] ?? 0) - (offsets[last] ?? 0), current, measure, scrollTo };
}

/** The first index whose offset is past `y` (offsets ascend). */
function upper(offsets: readonly number[], y: number): number {
  let lo = 0, hi = offsets.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (offsets[mid]! <= y) lo = mid + 1; else hi = mid; }
  return lo;
}

/** One file: its head (status, path, counts, hide, menu) and its patch. */
function FileDiffBlock({ file, detail, headSha, split, hidden, patch, measure, findings, reviewer, draft, setDraft, onToggle }: {
  file: PrFile; detail: PrDetail; headSha: string; split: boolean; hidden: boolean; patch: FileDiff | undefined;
  measure: (path: string, h: number) => void; findings: Finding[]; reviewer: Reviewer | null; draft: ReviewDraft; setDraft: SetDraft; onToggle: () => void;
}) {
  const box = useRef<HTMLElement>(null);
  const [menu, setMenu] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const [writing, setWriting] = useState<{ side: ReviewSide; line: number } | null>(null);
  const key = prKey(detail.ref);
  const [lines, setLines] = useState<string[] | null | undefined>(() => heldLines.get(patchId(key, headSha, file.path)));
  const run = useApp((s) => s.run);
  const toast = useApp((s) => s.toast);

  useLayoutEffect(() => {
    const el = box.current; if (!el) return;
    measure(file.path, el.offsetHeight);
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => measure(file.path, el.offsetHeight));
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [file.path, measure]);

  const openBand = (index: number) => {
    setOpen((o) => new Set([...o, index]));
    if (lines !== undefined || file.status === "deleted") return;
    codeReview.fileLines(detail.ref, headSha, file.path).then((l) => { heldLines.set(patchId(key, headSha, file.path), l.lines); setLines(l.lines); },
      (e: unknown) => run(() => Promise.reject(e)));
  };

  const notes = new Map<string, ReactNode>();
  for (const f of findings) {
    notes.set(rowLineKey(f.side, f.line), <FindingNote f={f} by={reviewer} kept={isKept(draft, f.id)} onKeep={() => setDraft((d) => keepFinding(d, f))}
      onDrop={() => setDraft((d) => dropComment(d, f.id))} />);
  }
  for (const c of draft.comments) {
    if (c.path !== file.path || c.from !== "me") continue;
    notes.set(rowLineKey(c.side, c.line), <OwnComment c={c} onDrop={() => setDraft((d) => dropComment(d, c.id))} />);
  }
  if (writing) {
    notes.set(rowLineKey(writing.side, writing.line), <CommentEditor onCancel={() => setWriting(null)} onSave={(body) => {
      setDraft((d) => ({ ...d, comments: [...d.comments, { id: `me-${Date.now()}`, path: file.path, line: writing.line, side: writing.side, body, from: "me" }] }));
      setWriting(null);
    }} />);
  }

  const items: MenuItem[] = [
    { label: "Copy path", icon: <Icon name="copy" size={14} />, onSelect: () => { void navigator.clipboard.writeText(file.path).then(() => toast({ tone: "success", text: `Copied ${file.path}`, icon: "copy" })); } },
    { label: "Show every unchanged line", icon: <Icon name="unfold" size={14} />, disabled: !split || !patch || file.status === "added" || file.status === "deleted",
      onSelect: () => { for (let i = 0; i <= (patch?.hunks.length ?? 0); i++) openBand(i); } },
  ];
  const cut = file.path.lastIndexOf("/");
  return (
    <section ref={box} className="cr-file" data-file={file.path} data-hidden={hidden || undefined} aria-label={file.path}>
      <header className="cr-file-head">
        <span className="diff-status" data-status={file.status === "deleted" ? "deleted" : file.status} title={file.status}>{LETTER[file.status]}</span>
        <span className="diff-path" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
          {cut >= 0 && <span className="diff-dir">{file.path.slice(0, cut + 1)}</span>}
          <span className="diff-base">{file.path.slice(cut + 1)}</span>
          {file.oldPath && <span className="diff-dir"> ← {file.oldPath}</span>}
        </span>
        <span className="diff-counts">
          {file.additions > 0 && <span className="diff-add">+{file.additions}</span>}
          {file.deletions > 0 && <span className="diff-del">−{file.deletions}</span>}
        </span>
        <button type="button" className="icon-btn" aria-pressed={hidden} aria-label={hidden ? `Show ${file.path}` : `Hide ${file.path}`}
          title={hidden ? "Show this file's changes" : "Hide this file's changes"} onClick={onToggle}><Icon name={hidden ? "hide" : "peek"} size={14} /></button>
        <button ref={more} type="button" className="icon-btn" aria-label={`More for ${file.path}`} title="More" aria-haspopup="menu" aria-expanded={menu}
          onClick={() => setMenu((m) => !m)}><Icon name="more" size={14} /></button>
        {menu && <Menu items={items} anchorRef={more} align="right" label={`${file.path} actions`} onClose={() => setMenu(false)} />}
      </header>
      {!hidden && (
        file.patch === "too-large" ? <p className="diff-note">GitHub does not send a diff this large. <a href={`${detail.url}/files`} target="_blank" rel="noreferrer">See it on GitHub</a>.</p>
          : file.patch === "none" ? <p className="diff-note">No lines changed{file.status === "renamed" ? " — the file was only renamed" : " — a binary file, or its mode"}.</p>
            : !patch ? <div className="diff-loading">Loading…</div>
              : split ? (
                <SplitPatch patch={patch} open={open} headLines={lines ?? null} trailing={file.status !== "added" && file.status !== "deleted"}
                  onOpenBand={file.status === "deleted" ? undefined : openBand} notes={notes} onComment={(side, line) => setWriting({ side, line })} />
              ) : (
                <>
                  <UnifiedPatch patch={patch} />
                  {notes.size > 0 && <div className="cr-file-notes">{[...notes.values()]}</div>}
                </>
              )
      )}
    </section>
  );
}

/** A reviewer's finding under its line, headed by who said it — the person keeps it in the review,
 *  or lets it be. */
function FindingNote({ f, by, kept, onKeep, onDrop }: { f: Finding; by: Reviewer | null; kept: boolean; onKeep: () => void; onDrop: () => void }) {
  return (
    <div className="cr-note" data-kept={kept || undefined}>
      {by && <p className="cr-note-by"><Icon name={AGENT_META[by.kind].icon} size={12} colored /><span><ReviewerName label={by.label} level={by.level} /></span></p>}
      <div className="cr-note-body" data-agent-output><Markdown text={f.body} /></div>
      <div className="cr-note-actions">
        {kept
          ? <><span className="cr-kept"><Icon name="check" size={12} />In your review</span><button type="button" className="btn-quiet" onClick={onDrop}>Take it out</button></>
          : <button type="button" className="btn-quiet" onClick={onKeep}>Add to review</button>}
      </div>
    </div>
  );
}

function OwnComment({ c, onDrop }: { c: DraftComment; onDrop: () => void }) {
  return (
    <div className="cr-note" data-kept="" data-own="">
      <div className="cr-note-body"><Markdown text={c.body} /></div>
      <div className="cr-note-actions"><span className="cr-kept"><Icon name="check" size={12} />In your review</span>
        <button type="button" className="btn-quiet" onClick={onDrop}>Remove</button></div>
    </div>
  );
}

/** A line comment being written. It waits in the review; Submit review is what posts it. */
function CommentEditor({ onSave, onCancel }: { onSave: (body: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { field.current?.focus(); }, []);
  return (
    <div className="cr-note cr-note-editor">
      <textarea ref={field} className="cr-field" rows={3} aria-label="Line comment" placeholder="Leave a comment on this line" value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) { e.preventDefault(); onSave(text); }
        }} />
      <div className="cr-note-actions">
        <span className="cr-bar-spacer" />
        <button type="button" className="btn-quiet" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn" disabled={!text.trim()} onClick={() => onSave(text)} title="Add it to your review (⌘↵)">Add to review</button>
      </div>
    </div>
  );
}

/**
 * The files as a tree, beside the diffs: a filter over both, each file's lines, the file at the top
 * of the diffs lit, and a click to bring one there.
 */
function FileTreeColumn({ files, shown, filter, onFilter, current, onPick }: {
  files: readonly PrFile[]; shown: readonly PrFile[]; filter: string; onFilter: (q: string) => void; current: string | null; onPick: (path: string) => void;
}) {
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const nodes = useMemo(() => fileTree(filter ? shown : files), [files, shown, filter]);
  const rows = useMemo(() => treeRows(nodes, folded), [nodes, folded]);
  const list = useRef<HTMLUListElement>(null);
  useDissolve(list);
  const fold = (path: string) => setFolded((f) => { const n = new Set(f); if (!n.delete(path)) n.add(path); return n; });
  return (
    <aside className="cr-tree" aria-label="Changed files">
      <div className="cr-tree-filter">
        <Icon name="search" size={14} className="cr-col-search-mark" />
        <input className="search-field" type="search" aria-label="Filter files" placeholder="Filter files…" value={filter}
          onChange={(e) => onFilter(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape" && filter) { e.stopPropagation(); onFilter(""); } }} />
      </div>
      <ul ref={list} className="cr-tree-rows">
        {rows.map(({ node, depth }) => (
          <li key={`${node.kind}:${node.path}`}>
            {node.kind === "dir" ? (
              <button type="button" className="cr-tree-row" data-kind="dir" style={{ paddingLeft: 8 + depth * 12 }} aria-expanded={!folded.has(node.path)} onClick={() => fold(node.path)}>
                <Icon name="chevronRight" size={12} className="cr-tree-chevron" />
                <span className="cr-tree-name">{node.name}</span>
              </button>
            ) : (
              <button type="button" className="cr-tree-row" data-kind="file" data-current={current === node.path || undefined} style={{ paddingLeft: 20 + depth * 12 }}
                onClick={() => onPick(node.path)} title={node.path}>
                <span className="cr-tree-name">{node.name}</span>
                <span className="diff-counts">
                  {node.file.additions > 0 && <span className="diff-add">+{node.file.additions}</span>}
                  {node.file.deletions > 0 && <span className="diff-del">−{node.file.deletions}</span>}
                </span>
              </button>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
