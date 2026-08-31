import type { DiffFile, FileDiff, ShipResult } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useState, type KeyboardEvent } from "react";
import { patchKey, useApp } from "../../state/store";
import type { PaneProps } from "../registry";

/** One letter, the way `git status` writes it — the densest honest label for a row. */
const STATUS_LETTER: Record<DiffFile["status"], string> = {
  added: "A", modified: "M", deleted: "D", renamed: "R", copied: "C",
  "type-changed": "T", untracked: "?", conflicted: "U",
};

/** Directory dim, basename bright: the hierarchy comes from the type tier, not from a second line. */
function PathLabel({ path, oldPath }: { path: string; oldPath: string | null }) {
  const cut = path.lastIndexOf("/");
  return (
    <span className="diff-path">
      {cut >= 0 && <span className="diff-dir">{path.slice(0, cut + 1)}</span>}
      <span className="diff-base">{path.slice(cut + 1)}</span>
      {oldPath && <span className="diff-dir"> ← {oldPath}</span>}
    </span>
  );
}

/** One side of one file, once it has been fetched. Renders nothing but lines: the pane's own header
 *  already said which file and which side, so a second header here would be noise. */
function Patch({ patch }: { patch: FileDiff | undefined }) {
  if (!patch) return <div className="diff-loading">Loading…</div>;
  if (patch.binary) return <div className="diff-note">Binary file — no preview.</div>;
  if (patch.hunks.length === 0) return <div className="diff-note">No textual changes.</div>;
  return (
    <div className="diff-hunks">
      {patch.hunks.map((h, i) => (
        <div className="diff-hunk" key={`${h.oldStart}-${h.newStart}-${i}`}>
          <div className="diff-hunk-head">@@ −{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@{h.header ? ` ${h.header}` : ""}</div>
          {h.lines.map((l, j) => (
            <div className="diff-line" data-kind={l.kind} key={j}>
              <span className="diff-gutter">{l.oldLine ?? ""}</span>
              <span className="diff-gutter">{l.newLine ?? ""}</span>
              <span className="diff-mark">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : l.kind === "meta" ? "\\" : " "}</span>
              <span className="diff-text">{l.text}</span>
            </div>
          ))}
        </div>
      ))}
      {patch.truncated && <div className="diff-note">Cut short — {patch.truncatedReason}. Open the file to see the rest.</div>}
    </div>
  );
}

/** A file row plus, when expanded, its patch. A file that is staged AND edited again has two
 *  patches and shows both, labelled: they are different content, and merging them would be a lie. */
function FileRow({ cwd, file }: { cwd: string; file: DiffFile }) {
  const [open, setOpen] = useState(false);
  const staged = useApp((s) => s.patches[patchKey(cwd, file.path, true)]);
  const unstaged = useApp((s) => s.patches[patchKey(cwd, file.path, false)]);
  const loadPatch = useApp((s) => s.loadPatch);
  const stagePaths = useApp((s) => s.stagePaths);
  const unstagePaths = useApp((s) => s.unstagePaths);
  const run = useApp((s) => s.run);
  const bothSides = file.staged && file.unstaged;

  useEffect(() => {
    if (!open) return;
    if (file.staged) run(() => loadPatch(cwd, file.path, true));
    if (file.unstaged) run(() => loadPatch(cwd, file.path, false));
  }, [open, cwd, file.path, file.staged, file.unstaged, loadPatch, run]);

  return (
    <div className="diff-file" data-open={open || undefined}>
      <div className="diff-row">
        <button type="button" className="diff-expand" aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${file.path}`}
          onClick={() => setOpen((v) => !v)}>
          <span className="diff-status" data-status={file.status} title={file.status}>{STATUS_LETTER[file.status]}</span>
          <PathLabel path={file.path} oldPath={file.oldPath} />
          {file.binary
            ? <span className="diff-counts">binary</span>
            : <span className="diff-counts">
                {file.additions > 0 && <span className="diff-add">+{file.additions}</span>}
                {file.deletions > 0 && <span className="diff-del">−{file.deletions}</span>}
              </span>}
        </button>
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

/** The ship outcome as three sentences and, where there is one, a next action. Every state named in
 *  the contract is handled here; a state with no words would be the silence W3 exists to remove. */
function ShipReport({ cwd, result }: { cwd: string; result: ShipResult }) {
  const ship = useApp((s) => s.ship);
  const message = useApp((s) => s.commitMessages[cwd] ?? "");
  const run = useApp((s) => s.run);
  const { commit, push, pr } = result;
  return (
    <div className="ship-report" role="status">
      {commit.state === "committed" && <p><Icon name="commit" size={13} /> Committed <code>{commit.sha?.slice(0, 7)}</code> — {commit.subject}</p>}
      {commit.state === "nothing-to-commit" && <p>Nothing was staged, so no commit was made.</p>}
      {commit.state === "no-identity" && <p className="ship-bad">{commit.reason}</p>}
      {commit.state === "failed" && <p className="ship-bad">Commit failed: {commit.reason}</p>}

      {push.state === "pushed" && <p>Pushed to {push.remote}/{push.branch}.</p>}
      {push.state === "up-to-date" && <p>{push.remote}/{push.branch} was already up to date.</p>}
      {push.state === "no-remote" && <p className="ship-bad">This checkout has no remote, so there is nowhere to push. Add one with <code>git remote add origin …</code>.</p>}
      {push.state === "no-upstream" && (
        <p className="ship-bad">
          {push.reason}{" "}
          <button type="button" className="btn-quiet" onClick={() => run(() => ship({ cwd, commit: false, message, push: true, setUpstream: true, openPr: true }))}>
            Push and set upstream
          </button>
        </p>
      )}
      {push.state === "rejected" && <p className="ship-bad">{push.reason}</p>}
      {push.state === "detached" && <p className="ship-bad">{push.reason}</p>}
      {push.state === "failed" && <p className="ship-bad">Push failed: {push.reason}</p>}

      {(pr.state === "created" || pr.state === "existing") && pr.url && (
        <p><Icon name="pullRequest" size={13} /> {pr.state === "created" ? "Opened" : "Already open"}: <a href={pr.url} target="_blank" rel="noreferrer">{pr.url}</a></p>
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
  // Read live, never captured: an environment whose row changes must move this pane with it.
  const cwd = useApp((s) => s.environments[environmentId]?.path ?? null);
  const summary = useApp((s) => (cwd ? s.diffs[cwd] ?? null : null));
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
  const run = useApp((s) => s.run);

  useEffect(() => { if (cwd) run(() => refreshDiff(cwd)); }, [cwd, refreshDiff, run]);

  if (!cwd) return <div className="pane-placeholder muted">This checkout no longer exists.</div>;
  if (!known && loading) return <div className="pane-placeholder muted">Reading the working tree…</div>;
  if (known && summary === null) return <div className="pane-placeholder muted">{cwd} is not a git repository, so there is nothing to diff.</div>;

  const files = summary?.files ?? [];
  const stageable = files.filter((f) => f.unstaged).map((f) => f.path);
  const unstageable = files.filter((f) => f.staged).map((f) => f.path);
  const canCommit = unstageable.length > 0 && message.trim() !== "";
  const doShip = (openPr: boolean) => {
    if (!canCommit || shipping) return;
    run(() => ship({ cwd, commit: true, message, push: openPr, setUpstream: false, openPr }));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); doShip(true); }
  };

  return (
    <div className="diff-pane">
      <div className="diff-head">
        <span className="composer-chip git-branch"><Icon name="branch" size={12} /><span className="chip-label">{summary?.branch ?? "detached"}</span></span>
        <span className="diff-head-count">{files.length === 0 ? "No changes" : `${files.length} ${files.length === 1 ? "file" : "files"}`}</span>
        <span className="diff-head-spacer" />
        {stageable.length > 0 && <button type="button" className="btn-quiet" onClick={() => run(() => stagePaths(cwd, stageable))}>Stage all</button>}
        {unstageable.length > 0 && <button type="button" className="btn-quiet" onClick={() => run(() => unstagePaths(cwd, unstageable))}>Unstage all</button>}
        <button type="button" className="btn-quiet" title="Checkpoints taken before each turn (W4)"
          onClick={() => run(() => openCheckpoints(environmentId, null))}>History</button>
        <button type="button" className="icon-btn" aria-label="Refresh changes" title="Refresh" onClick={() => run(() => refreshDiff(cwd))}>
          <Icon name="diff" size={13} />
        </button>
      </div>

      {summary?.truncated && (
        <div className="diff-note">Showing {files.length} of {summary.totalFiles} changed files — too many to render at once.</div>
      )}

      <div className="diff-list">
        {files.length === 0
          ? <div className="diff-empty">Nothing has changed in this checkout since the last commit.</div>
          : files.map((f) => <FileRow key={f.path} cwd={cwd} file={f} />)}
      </div>

      <div className="diff-commit">
        {result && <ShipReport cwd={cwd} result={result} />}
        <textarea className="commit-message" aria-label="Commit message" rows={2} placeholder="Describe the change…"
          value={message} onChange={(e) => setCommitMessage(cwd, e.target.value)} onKeyDown={onKeyDown} />
        <div className="diff-commit-bar">
          <span className="diff-staged-count">
            {unstageable.length === 0 ? "Nothing staged" : `${unstageable.length} staged`}
          </span>
          <button type="button" className="btn" disabled={!canCommit || shipping}
            onClick={() => doShip(false)}>Commit only</button>
          <button type="button" className="btn primary" disabled={!canCommit || shipping}
            title="Commit, push and open a pull request (⌘↵)"
            onClick={() => doShip(true)}>{shipping ? "Working…" : "Commit, push & PR"}</button>
        </div>
      </div>
    </div>
  );
}
