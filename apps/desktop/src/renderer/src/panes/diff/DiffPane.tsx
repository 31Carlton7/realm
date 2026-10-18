import { documentKindFor, ownerOfTab, type DiffFile, type DiffSummary, type FileDiff, type ReviewResult, type ShipResult, type TurnChanges, type TurnFile } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { relativeTime } from "../../components/CheckpointsSheet";
import { FileMark } from "../../components/file-icon";
import { useDissolve } from "../../components/ScrollFades";
import { forgetThumbnails, useThumbnail } from "../../components/use-thumbnail";
import { Markdown } from "../session/Markdown";
import { patchKey, turnPatchKey, useApp, type TurnDiffScope } from "../../state/store";
import type { PaneProps } from "../registry";
import { UnifiedPatch as Patch } from "./PatchView";
import { KIND_ICON, KIND_LABEL, changeKindOf, changePhrase, groupByKind, whatOf, type ChangeKind } from "./what-changed";
import { capabilities } from "../../platform";

/** Directory dim, basename bright: the hierarchy comes from the type tier, not from a second line. */
function PathLabel({ path }: { path: string }) {
  const cut = path.lastIndexOf("/");
  return (
    <span className="diff-path">
      {cut >= 0 && <span className="diff-dir">{path.slice(0, cut + 1)}</span>}
      <span className="diff-base">{path.slice(cut + 1)}</span>
    </span>
  );
}

/** What happened to the file, in a word or two, in its state's tone. The word carries it; the tone
 *  only repeats it. */
function What({ file }: { file: Pick<DiffFile, "status" | "oldPath"> }) {
  const what = whatOf(file.status, file.oldPath);
  return <span className="diff-what" data-status={file.status} title={what}>{what}</span>;
}

/** Lines added and removed, quiet at the row's end. Nothing for a file git does not count in lines:
 *  "binary" is a word about storage, and the row's mark or picture already says what the file is. */
function Counts({ additions, deletions }: { additions: number | null; deletions: number | null }) {
  if (additions === null || deletions === null || (additions === 0 && deletions === 0)) return null;
  return (
    <span className="diff-counts">
      {additions > 0 && <span className="diff-add">+{additions}</span>}
      {deletions > 0 && <span className="diff-del">−{deletions}</span>}
    </span>
  );
}

/** Kinds whose file a person reads as itself rather than as lines: they open, rendered, in Documents. */
const OPENS_AS_ITSELF: ReadonlySet<ChangeKind> = new Set(["document", "image", "media"]);
/** What Documents draws as a picture of the file rather than as its text. Git calls an untracked
 *  picture "not binary" only because it has not counted it yet, so the kind is asked instead. */
const DRAWN_NOT_READ = new Set(["preview", "pdf", "video", "unsupported"]);

/** The picture as the last commit had it, asked again whenever the list it belongs to is re-read —
 *  a commit moves HEAD, and with it what "before" means. */
function useHeadImage(cwd: string, path: string | null, read: unknown): string | null {
  const headImage = useApp((s) => s.headImage);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (path === null) { setUrl(null); return; }
    let live = true;
    headImage(cwd, path).then((u) => { if (live) setUrl(u); }, () => { if (live) setUrl(null); });
    return () => { live = false; };
  }, [cwd, path, read, headImage]);
  return url;
}

/** A changed picture, as pictures: the one the last commit had and the one on disk now, side by side
 *  when there are both. A new picture has no before and a deleted one no after. */
function Pictures({ cwd, root, file, read }: { cwd: string; root: string; file: DiffFile; read: unknown }) {
  const hadBefore = file.status !== "added" && file.status !== "untracked";
  const before = useHeadImage(cwd, hadBefore ? file.oldPath ?? file.path : null, read);
  const after = useThumbnail(file.status === "deleted" ? null : `${root}/${file.path}`, "card");
  return (
    <span className="diff-thumbs" aria-hidden="true">
      {before && <img className="diff-thumb" data-side="before" src={before} alt="" draggable={false} />}
      {before && after && <Icon name="arrowRight" size={12} className="diff-thumb-arrow" />}
      {after && <img className="diff-thumb" data-side="after" src={after} alt="" draggable={false} />}
      {!before && !after && <FileMark path={file.path} size={16} />}
    </span>
  );
}

/**
 * A file row plus, when expanded, its patch. A file that is staged AND edited again has two patches
 * and shows both, labelled: they are different content, and merging them would be a lie.
 *
 * A document, a picture or a recording is opened by its row, rendered in Documents, because the file
 * is what a person looks at; its lines are one click further, on the chevron. Code is its lines, so
 * its row opens the patch.
 */
function FileRow({ cwd, root, file, read, onOpen }: { cwd: string; root: string; file: DiffFile; read: unknown; onOpen: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const staged = useApp((s) => s.patches[patchKey(cwd, file.path, true)]);
  const unstaged = useApp((s) => s.patches[patchKey(cwd, file.path, false)]);
  const loadPatch = useApp((s) => s.loadPatch);
  const stagePaths = useApp((s) => s.stagePaths);
  const unstagePaths = useApp((s) => s.unstagePaths);
  const run = useApp((s) => s.run);
  const bothSides = file.staged && file.unstaged;
  const kind = changeKindOf(file.path);
  const opens = OPENS_AS_ITSELF.has(kind) && file.status !== "deleted" && documentKindFor(file.path) !== "unsupported";
  const hasLines = !file.binary && !DRAWN_NOT_READ.has(documentKindFor(file.path));

  useEffect(() => {
    if (!open) return;
    if (file.staged) run(() => loadPatch(cwd, file.path, true));
    if (file.unstaged) run(() => loadPatch(cwd, file.path, false));
  }, [open, cwd, file.path, file.staged, file.unstaged, loadPatch, run]);

  const body: ReactNode = (
    <>
      {kind === "image" ? <Pictures cwd={cwd} root={root} file={file} read={read} /> : <FileMark path={file.path} size={16} />}
      <PathLabel path={file.path} />
      <What file={file} />
      {!file.binary && <Counts additions={file.additions} deletions={file.deletions} />}
    </>
  );
  return (
    <div className="diff-file" data-open={open || undefined} data-kind={kind}>
      <div className="diff-row">
        {opens
          ? <button type="button" className="diff-expand" aria-label={`Open ${file.path}`} title={`Open ${file.path} in Documents`}
              onClick={() => onOpen(`${root}/${file.path}`)}>{body}</button>
          : <button type="button" className="diff-expand" aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${file.path}`}
              onClick={() => setOpen((v) => !v)}>{body}</button>}
        {opens && hasLines && (
          <button type="button" className="icon-btn diff-disclose" aria-expanded={open}
            aria-label={`${open ? "Hide" : "Show"} the lines that changed in ${file.path}`} title={open ? "Hide the lines that changed" : "Show the lines that changed"}
            onClick={() => setOpen((v) => !v)}>
            <Icon name="chevronDown" size={12} />
          </button>
        )}
        <span className="diff-actions">
          {file.unstaged && (
            <button type="button" className="btn-quiet" onClick={() => run(() => stagePaths(cwd, [file.path]))}>Stage</button>
          )}
          {file.staged && (
            <button type="button" className="btn-quiet" onClick={() => run(() => unstagePaths(cwd, [file.path]))}>Unstage</button>
          )}
        </span>
      </div>
      {open && (
        <div className="diff-body">
          {file.staged && <>{bothSides && <div className="diff-side">Staged</div>}<Patch patch={staged} /></>}
          {file.unstaged && <>{bothSides && <div className="diff-side">Not staged</div>}<Patch patch={unstaged} /></>}
        </div>
      )}
    </div>
  );
}

/** Files under a head per kind — Documents, Images, Code — once there is more than one kind to tell
 *  apart. A list of one kind is already named by the summary above it, and a head repeating it is a
 *  second title. */
function Groups<T extends { path: string }>({ files, row }: { files: readonly T[]; row: (file: T) => ReactNode }) {
  const groups = groupByKind(files);
  if (groups.length <= 1) return <>{files.map(row)}</>;
  return (
    <>
      {groups.map((g) => (
        <section key={g.kind} className="diff-group" aria-label={KIND_LABEL[g.kind]}>
          <h3 className="diff-group-head">
            <Icon name={KIND_ICON[g.kind]} size={12} />
            <span>{KIND_LABEL[g.kind]}</span>
            <span className="diff-group-count">{g.files.length}</span>
          </h3>
          {g.files.map(row)}
        </section>
      ))}
    </>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The quiet line under the summary: where the work is kept and how it stands against the remote — the
 * facts the pill over the prompter used to lead with, which describe git rather than the work. A
 * conflict is the one of them a person has to act on, so it is the one with a tone.
 */
function Meta({ summary, ahead, behind }: { summary: DiffSummary | null; ahead: number; behind: number }) {
  const files = summary?.files ?? [];
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  const conflicts = files.filter((f) => f.status === "conflicted").length;
  return (
    <p className="diff-summary-meta">
      <span className="diff-meta-branch" title={summary?.branch ? `On the branch ${summary.branch}` : "Not on a branch"}>
        <Icon name="branch" size={12} /><span className="chip-label">{summary?.branch ?? "detached"}</span>
      </span>
      {conflicts > 0 && <span className="diff-meta-conflict">{plural(conflicts, "conflict", "conflicts")} to resolve</span>}
      {ahead > 0 && <span title={`This branch has ${plural(ahead, "commit", "commits")} its remote does not have yet.`}>{plural(ahead, "commit", "commits")} to push</span>}
      {behind > 0 && <span title={`The remote has ${plural(behind, "commit", "commits")} this checkout does not have yet.`}>{plural(behind, "commit", "commits")} to pull</span>}
      {(additions > 0 || deletions > 0) && (
        <span className="diff-counts" title="Lines added and removed">
          {additions > 0 && <span className="diff-add">+{additions}</span>}
          {deletions > 0 && <span className="diff-del">−{deletions}</span>}
        </span>
      )}
    </p>
  );
}

const REVIEW_OUTCOME_NOTE: Record<ReviewResult["outcome"], string | null> = {
  done: null,
  stopped: "The reviewer was stopped before finishing — this is partial.",
  interrupted: "The reviewer was interrupted before finishing — this is partial.",
  timeout: "The reviewer ran out of time — this is partial.",
  failed: "The reviewer session failed before finishing — this is partial.",
  gone: "The reviewer session was deleted before finishing.",
};

/**
 * The review section (Plan 13 W3): the reviewer's verdict, rendered as what it is — a subagent's
 * fenced output about this checkout, persisted per ENVIRONMENT in the settings KV so a reload keeps
 * it until the next review, a dismissal, or a ship (the server clears it on commit — a verdict about
 * a diff that no longer exists must not survive the diff).
 *
 * What this section is NOT: an actor. It renders text and offers dismiss + a jump to the reviewer's
 * session; it wires NOTHING toward the commit controls below it — review informs the human's ship
 * click, and the absence of any review→ship path here is deliberate and load-bearing (the plan's
 * ban; the server side is pinned structurally in delegation/structure.test.ts).
 */
function ReviewSection({ environmentId, review }: { environmentId: string; review: ReviewResult }) {
  const dismissReview = useApp((s) => s.dismissReview);
  const items = useApp((s) => s.items);
  const openItem = useApp((s) => s.openItem);
  const run = useApp((s) => s.run);
  const reviewerItem = items.find((i) => i.kind === "session" && i.refId === review.sessionId);
  const note = REVIEW_OUTCOME_NOTE[review.outcome];
  const body = useRef<HTMLDivElement>(null);
  useDissolve(body);
  return (
    <section className="diff-review" aria-label="Review" data-partial={note ? "" : undefined}>
      <div className="diff-review-head">
        <span className="diff-review-title">Review</span>
        {/* Partial-ness is a PROPERTY of the review, so it rides the title as a chip rather than
            sitting under the head as a second paragraph of prose. The card is short and the header
            is where a reader looks to find out what they are about to read. */}
        {note && <span className="diff-review-chip">Partial</span>}
        <span className="diff-head-spacer" />
        <span className="diff-review-dim">{relativeTime(review.createdAt, Date.now())}</span>
        {reviewerItem && (
          <button type="button" className="btn-quiet diff-review-by"
            title={`Open ${review.sessionTitle}`}
            onClick={() => run(() => openItem(reviewerItem.id))}>
            {review.sessionTitle}
          </button>
        )}
        <button type="button" className="icon-btn" aria-label="Dismiss review"
          onClick={() => run(() => dismissReview(environmentId))}>
          <Icon name="close" size={12} />
        </button>
      </div>
      {note && <p className="diff-review-note">{note}</p>}
      {/* Agent output, visibly fenced off from Realm's own chrome — the reviewer's words, verbatim. */}
      <div className="diff-review-body" ref={body} data-agent-output>
        <Markdown text={review.text} />
      </div>
    </section>
  );
}

/** The ship outcome as three sentences and, where there is one, a next action. Every state named in
 *  the contract is handled here; a state with no words would be the silence W3 exists to remove. */
function ShipReport({ cwd, environmentId, result }: { cwd: string; environmentId: string; result: ShipResult }) {
  const ship = useApp((s) => s.ship);
  const message = useApp((s) => s.commitMessages[cwd] ?? "");
  const run = useApp((s) => s.run);
  const { commit, push, pr } = result;
  return (
    <div className="ship-report" role="status">
      {commit.state === "committed" && <p><Icon name="commit" size={12} /> Committed <code>{commit.sha?.slice(0, 7)}</code> — {commit.subject}</p>}
      {commit.state === "nothing-to-commit" && <p>Nothing was staged, so no commit was made.</p>}
      {commit.state === "no-identity" && <p className="ship-bad">{commit.reason}</p>}
      {commit.state === "failed" && <p className="ship-bad">Commit failed: {commit.reason}</p>}

      {push.state === "pushed" && <p>Pushed to {push.remote}/{push.branch}.</p>}
      {push.state === "up-to-date" && <p>{push.remote}/{push.branch} was already up to date.</p>}
      {push.state === "no-remote" && <p className="ship-bad">This checkout has no remote, so there is nowhere to push. Add one with <code>git remote add origin …</code>.</p>}
      {push.state === "no-upstream" && (
        <p className="ship-bad">
          {push.reason}{" "}
          <button type="button" className="btn-quiet" onClick={() => run(() => ship({ cwd, environmentId, commit: false, message, push: true, setUpstream: true, openPr: true }))}>
            Push and set upstream
          </button>
        </p>
      )}
      {push.state === "rejected" && <p className="ship-bad">{push.reason}</p>}
      {push.state === "detached" && <p className="ship-bad">{push.reason}</p>}
      {push.state === "failed" && <p className="ship-bad">Push failed: {push.reason}</p>}

      {(pr.state === "created" || pr.state === "existing") && pr.url && (
        <p><Icon name="pullRequest" size={12} /> {pr.state === "created" ? "Opened" : "Already open"}: <a href={pr.url} target="_blank" rel="noreferrer">{pr.url}</a></p>
      )}
      {pr.state === "compare" && pr.url && (
        <p>{pr.reason} <a href={pr.url} target="_blank" rel="noreferrer">Open a pull request</a></p>
      )}
      {pr.state === "unavailable" && <p className="ship-bad">{pr.reason}</p>}
    </div>
  );
}

/**
 * The diff pane (Plan 7 W3): one checkout's working tree, per file, with per-file staging and one
 * button that commits, pushes and opens a pull request.
 *
 * `item.refId` is an ENVIRONMENT id, not a session id. That is the whole reason the pane cannot go
 * stale: the checkout path is read from the environment on every render, so a worktree that moves,
 * or a session that is deleted out from under the pane, changes nothing about which tree is shown.
 *
 * Staging is per FILE, not per hunk. A hunk stager has to rebuild a patch and feed it to
 * `git apply --cached`, and gets it wrong for mode changes, renames, CRLF and missing trailing
 * newlines — the cases where being wrong means losing an edit. Per file is the honest half.
 */
export function DiffPane({ item }: PaneProps) {
  const environmentId = item.refId;
  /* An edit card's Review puts the pane on one turn; everything else shows the checkout as it is. */
  const turn = useApp((s) => s.diffTurns[environmentId] ?? null);
  return turn ? <TurnDiff environmentId={environmentId} scope={turn} /> : <CheckoutDiff environmentId={environmentId} itemId={item.id} />;
}

/** The session whose side panel this pane is a tab of — where a file opened from it goes, beside the
 *  same session, as the edit card's rows send theirs. */
function useOwnerSession(itemId: string): string | null {
  return useApp((s) => {
    const owner = s.layout ? ownerOfTab(s.layout, itemId) : null;
    const it = owner ? s.items.find((i) => i.id === owner) : undefined;
    return it?.kind === "session" ? it.refId : null;
  });
}

function CheckoutDiff({ environmentId, itemId }: { environmentId: string; itemId: string }) {
  // Read live, never captured: an environment whose row changes must move this pane with it.
  const cwd = useApp((s) => s.environments[environmentId]?.path ?? null);
  const summary = useApp((s) => (cwd ? s.diffs[cwd] ?? null : null));
  const git = useApp((s) => (cwd ? s.gitInfo[cwd] ?? null : null));
  const owner = useOwnerSession(itemId);
  const openDocumentPath = useApp((s) => s.openDocumentPath);
  const known = useApp((s) => (cwd ? cwd in s.diffs : false));
  const loading = useApp((s) => (cwd ? s.diffLoading[cwd] === true : false));
  const message = useApp((s) => (cwd ? s.commitMessages[cwd] ?? "" : ""));
  const result = useApp((s) => (cwd ? s.shipResults[cwd] : undefined));
  const shipping = useApp((s) => (cwd ? s.shipping[cwd] === true : false));
  const refreshDiff = useApp((s) => s.refreshDiff);
  const setCommitMessage = useApp((s) => s.setCommitMessage);
  const stagePaths = useApp((s) => s.stagePaths);
  const unstagePaths = useApp((s) => s.unstagePaths);
  const ship = useApp((s) => s.ship);
  const openCheckpoints = useApp((s) => s.openCheckpoints);
  const review = useApp((s) => s.reviews[environmentId]);
  const reviewing = useApp((s) => s.reviewing[environmentId] === true);
  const requestReview = useApp((s) => s.requestReview);
  const refreshReview = useApp((s) => s.refreshReview);
  const run = useApp((s) => s.run);

  /* The list dissolves into the commit box below it rather than being cut off at it. Up here with
     the other hooks, not beside the markup it belongs to: three early returns follow. */
  const fileList = useRef<HTMLDivElement>(null);
  useDissolve(fileList);

  useEffect(() => { if (cwd) run(() => refreshDiff(cwd)); }, [cwd, refreshDiff, run]);
  // The persisted verdict (W3): fetched per ENVIRONMENT — a reload lands back on whatever the last
  // review said, until a new review, a dismissal, or a ship clears it.
  useEffect(() => { run(() => refreshReview(environmentId)); }, [environmentId, refreshReview, run]);
  // A thumbnail is cached by path, and a picture the agent has just redrawn keeps its path: each fresh
  // read of the list forgets the pictures in it, so the "after" is the file as it is now.
  useEffect(() => {
    if (!summary) return;
    forgetThumbnails(summary.files.filter((f) => f.status !== "deleted" && changeKindOf(f.path) === "image").map((f) => `${summary.root}/${f.path}`));
  }, [summary]);

  if (!cwd) return <div className="pane-placeholder muted">This checkout no longer exists.</div>;
  if (!known && loading) return <div className="pane-placeholder muted">Reading the working tree…</div>;
  if (known && summary === null) return <NoRepository cwd={cwd} />;

  const files = summary?.files ?? [];
  const root = summary?.root ?? cwd;
  const openFile = (path: string) => run(() => openDocumentPath(path, environmentId, null, { beside: owner ? { sessionId: owner } : true }));
  const stageable = files.filter((f) => f.unstaged).map((f) => f.path);
  const unstageable = files.filter((f) => f.staged).map((f) => f.path);
  const canCommit = unstageable.length > 0 && message.trim() !== "";
  const doShip = (openPr: boolean) => {
    if (!canCommit || shipping) return;
    run(() => ship({ cwd, environmentId, commit: true, message, push: openPr, setUpstream: false, openPr }));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); doShip(true); }
  };
  return (
    <div className="diff-pane">
      <div className="diff-head">
        {/* What changed, in the pill's own words, and under it how git is keeping it. */}
        <div className="diff-summary">
          <h2 className="diff-summary-title">{changePhrase(files, summary?.totalFiles ?? 0) ?? "No changes"}</h2>
          <Meta summary={summary} ahead={git?.ahead ?? 0} behind={git?.behind ?? 0} />
        </div>
        <span className="diff-head-spacer" />
        {stageable.length > 0 && <button type="button" className="btn-quiet" onClick={() => run(() => stagePaths(cwd, stageable))}>Stage all</button>}
        {unstageable.length > 0 && <button type="button" className="btn-quiet" onClick={() => run(() => unstagePaths(cwd, unstageable))}>Unstage all</button>}
        <button type="button" className="btn-quiet" disabled={reviewing}
          title={reviewing ? "A reviewer session is working on this checkout" : "Spawn a read-only reviewer session over this checkout (W3) — its verdict lands here"}
          onClick={() => run(() => requestReview(environmentId))}>{reviewing ? "Reviewing…" : "Request review"}</button>
        <button type="button" className="btn-quiet" title="Checkpoints taken before each turn (W4)"
          onClick={() => run(() => openCheckpoints(environmentId, null))}>History</button>
        <button type="button" className="icon-btn" aria-label="Refresh changes" title="Refresh" onClick={() => run(() => refreshDiff(cwd))}>
          <Icon name="diff" size={14} />
        </button>
      </div>

      {summary?.truncated && (
        <div className="diff-note">Showing {files.length} of {summary.totalFiles} changed files — too many to render at once.</div>
      )}

      <div className="diff-list-wrap">
        <div className="diff-list" ref={fileList}>
          {files.length === 0
            ? <div className="diff-empty">Nothing has changed in this checkout since the last commit.</div>
            : <Groups files={files} row={(f) => <FileRow key={f.path} cwd={cwd} root={root} file={f} read={summary} onOpen={openFile} />} />}
        </div>
      </div>

      {review && <ReviewSection environmentId={environmentId} review={review} />}

      <div className="diff-commit">
        {result && <ShipReport cwd={cwd} environmentId={environmentId} result={result} />}
        <div className="commit-card">
          <textarea className="commit-message" aria-label="Commit message" rows={2} placeholder="Describe the change…"
            value={message} onChange={(e) => setCommitMessage(cwd, e.target.value)} onKeyDown={onKeyDown} />
          <div className="diff-commit-bar">
            <span className="diff-staged-count">
              {unstageable.length === 0 ? "Nothing staged" : `${unstageable.length} staged`}
            </span>
            <button type="button" className="btn-quiet" disabled={!canCommit || shipping}
              onClick={() => doShip(false)}>Commit only</button>
            <button type="button" className="btn primary" disabled={!canCommit || shipping}
              title="Commit, push and open a pull request (⌘↵)"
              onClick={() => doShip(true)}>{shipping ? "Working…" : "Commit, push & PR"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Files a review opens unasked. A turn is usually a handful of files and reading them is the whole
 *  point; a codegen turn of two hundred is a list first, opened one at a time. */
const OPEN_UP_TO = 8;

/** One file of a turn: the same row the checkout's files wear, without staging — nothing in a
 *  finished turn is staged — and its patch fetched across the turn's own two trees. */
function TurnFileRow({ changes, file, start }: { changes: TurnChanges; file: TurnFile; start: boolean }) {
  const [open, setOpen] = useState(start);
  const [gone, setGone] = useState<string | null>(null);
  const patch = useApp((s) => s.turnPatches[turnPatchKey(changes, file.path)]);
  const loadTurnPatch = useApp((s) => s.loadTurnPatch);
  useEffect(() => {
    if (!open) return;
    // Caught here rather than by the toast: a turn whose snapshot `git gc` has since collected is
    // a fact about this file, and the place to say it is where its patch would have been.
    loadTurnPatch(changes, file.path, file.oldPath).catch((e: unknown) => setGone(e instanceof Error ? e.message : String(e)));
  }, [open, changes, file.path, file.oldPath, loadTurnPatch]);
  return (
    <div className="diff-file" data-open={open || undefined}>
      <div className="diff-row">
        <button type="button" className="diff-expand" aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${file.path}`}
          onClick={() => setOpen((v) => !v)}>
          <FileMark path={file.path} size={16} />
          <PathLabel path={file.path} />
          <What file={file} />
          <Counts additions={file.additions} deletions={file.deletions} />
        </button>
      </div>
      {open && <div className="diff-body">{gone ? <div className="diff-note">{gone}.</div> : <Patch patch={patch} />}</div>}
    </div>
  );
}

/**
 * One turn's changes, for an edit card's Review: the checkout as the turn's checkpoint found it,
 * against the checkout as the turn left it — the tree its settle recorded, so an edit made since is
 * not part of the answer. Read-only, because history has nothing to stage; "Show all changes" puts
 * the pane back on the checkout as it is now, and so does closing the pane (`closeFromLayout`) — not
 * unmounting it, which a tab switched away and StrictMode's rehearsal both do to a review still open.
 */
function TurnDiff({ environmentId, scope }: { environmentId: string; scope: TurnDiffScope }) {
  const closeTurnDiff = useApp((s) => s.closeTurnDiff);
  const fileList = useRef<HTMLDivElement>(null);
  useDissolve(fileList);
  const { changes, asked } = scope;
  const n = changes.totalFiles;
  const firstLine = asked?.trim().split("\n")[0] ?? null;
  return (
    <div className="diff-pane">
      <div className="diff-head">
        <div className="diff-summary">
          <h2 className="diff-summary-title">{changePhrase(changes.files, n) ?? "No changes"} in one turn</h2>
          {firstLine && <p className="diff-summary-meta"><span className="diff-turn-asked" title={asked ?? undefined}>{firstLine}</span></p>}
        </div>
        <span className="diff-head-spacer" />
        <button type="button" className="btn-quiet" onClick={() => closeTurnDiff(environmentId)}>Show all changes</button>
      </div>
      {changes.files.length < n && (
        <div className="diff-note">Showing {changes.files.length} of {n} changed files — the most one turn lists.</div>
      )}
      <div className="diff-list-wrap">
        <div className="diff-list" ref={fileList}>
          <Groups files={changes.files} row={(f) => <TurnFileRow key={f.path} changes={changes} file={f} start={changes.files.length <= OPEN_UP_TO} />} />
        </div>
      </div>
    </div>
  );
}

/**
 * A checkout with no repository in it.
 *
 * This was one grey sentence with the whole absolute path inlined into it, which for a real path is
 * a line of text nobody reads to the end of. What a person needs here is the folder itself — which
 * one, where — and the one thing they can still do with it, which is go and look at it. The pane's
 * subject is a directory, so the empty state draws a directory.
 */
function NoRepository({ cwd }: { cwd: string }) {
  const name = cwd.replace(/\/+$/, "").split("/").pop() || cwd;
  return (
    <div className="pane-empty">
      {/* off-ladder: the empty state's folder is a 64px illustration rather than a UI glyph — the
          rungs stop at 20, which on this tile would read as a lost icon rather than a picture. */}
      <div className="pane-empty-tile" aria-hidden="true"><Icon name="folder" size={28} /></div>
      <h2 className="pane-empty-title">{name}</h2>
      {/* The full path in mono, under the name rather than inside the sentence — it is machine text,
          and it is what someone checks when the folder name alone is ambiguous. */}
      <p className="pane-empty-path">{cwd}</p>
      <p className="pane-empty-line">There is no git repository here, so there is nothing to diff.</p>
      {/* `files.reveal`, not `media.reveal`: this is a DIRECTORY, and the media gate admits only what
          a media element can decode — so this button used to do nothing at all. */}
      <button type="button" className="btn" onClick={() => { void window.realm?.files?.reveal?.(cwd); }}>
        Reveal in {capabilities().fileManager}
      </button>
    </div>
  );
}
