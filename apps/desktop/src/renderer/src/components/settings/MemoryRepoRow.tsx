import type { MemoryClaudeImport, MemoryRemoteCheck, MemoryRepoState } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useState, type FormEvent } from "react";
import { memoryRepoKey, useApp, type MemoryRepoOwner } from "../../state/store";
import { ago } from "../../panes/code-review/code-review-model";
import { CommandCopy } from "../CommandCopy";

/**
 * The memory repo, as rows: the memory AGENTS write (Agent Memory Repo), beside the documents the
 * user writes. One per profile, inherited by its spaces, and one per space that wants its own.
 *
 * Its state is said in words rather than a dot, as the first row's name — a repo with uncommitted
 * changes refuses saves until someone commits them, and the reason has to be readable where the repo
 * is shown.
 */
const cap = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);

export function repoStatus(r: MemoryRepoState, now = Date.now()): { name: string; text: string; sentence: string; tone: "danger" | "warning" | null } {
  if (!r.valid) {
    const why = r.reason ?? "unknown";
    return { name: "Not a memory repo", text: `${cap(why)}.`, sentence: `Not a memory repo: ${why}.`, tone: "danger" };
  }
  if (!r.clean || r.sync === "diverged") {
    const why = r.reason ?? "uncommitted changes";
    return { name: "Saving paused", text: `${cap(why)}.`, sentence: `Saving paused: ${why}.`, tone: "warning" };
  }
  if (r.lastCommitAt === null) return { name: "No commits yet", text: "", sentence: "No commits yet.", tone: null };
  const when = ago(r.lastCommitAt, now);
  return { name: "Last saved", text: `${cap(when)}: ${r.lastCommitSubject ?? ""}`, sentence: `Last saved ${when}: ${r.lastCommitSubject ?? ""}`, tone: null };
}

/** What a row says when its owner has no repo yet. */
const EMPTY = {
  profile: { name: "No memory repo", desc: "Agents save what they learn about you to a git repo of Markdown files, and every engine reads it back in later sessions." },
  space: { name: "No repo of its own", desc: "Give this space a memory repo beside your own — one a team shares, so everyone's agents read and save the same facts." },
} as const;

/** One owner's repo: create or attach, then the repo with its folder, sync, Claude import and history. */
export function MemoryRepoRow({ owner }: { owner: MemoryRepoOwner }) {
  const repo = useApp((s) => (owner.scope === "profile"
    ? s.profileMemoryRepo[owner.id]
    : s.spaceMemoryRepos[owner.id] === undefined ? undefined : s.spaceMemoryRepos[owner.id]!.find((r) => r.scope === "space") ?? null));
  const log = useApp((s) => s.memoryRepoLog[memoryRepoKey(owner)]);
  const refreshMemoryRepoOf = useApp((s) => s.refreshMemoryRepoOf);
  const refreshMemoryRepoLog = useApp((s) => s.refreshMemoryRepoLog);
  const createMemoryRepo = useApp((s) => s.createMemoryRepo);
  const attachMemoryRepo = useApp((s) => s.attachMemoryRepo);
  const detachMemoryRepo = useApp((s) => s.detachMemoryRepo);
  const run = useApp((s) => s.run);
  const { scope, id } = owner;
  useEffect(() => { run(() => refreshMemoryRepoOf({ scope, id })); }, [scope, id, refreshMemoryRepoOf, run]);
  const hasRepo = repo !== undefined && repo !== null;
  // The log follows the head: a save, a pull or an import brings it up to date without a reload.
  const head = repo?.head ?? null;
  useEffect(() => { if (hasRepo) run(() => refreshMemoryRepoLog({ scope, id })); }, [hasRepo, head, scope, id, refreshMemoryRepoLog, run]);

  if (repo === undefined) return <div className="settings-group"><p className="env-empty">Loading…</p></div>;
  if (repo === null) {
    return (
      <div className="settings-group memory-repo" data-scope={scope}>
        <div className="settings-row">
          <div className="settings-row-main">
            <span className="settings-row-name">{EMPTY[scope].name}</span>
            <span className="settings-row-desc">{EMPTY[scope].desc}</span>
          </div>
          <span className="memory-repo-actions">
            <button type="button" className="btn" title="Choose a folder that already holds a memory repo, such as ~/agent-memory or a team's clone"
              onClick={() => run(() => attachMemoryRepo(owner))}>Attach existing…</button>
            <button type="button" className="btn primary" title="Make a new memory repo under Realm's folder on this Mac"
              onClick={() => run(() => createMemoryRepo(owner))}>Create</button>
          </span>
        </div>
      </div>
    );
  }
  const status = repoStatus(repo);
  const reveal = window.realm?.files?.reveal;
  return (
    <div className="settings-group memory-repo" data-scope={scope}>
      <div className="settings-row">
        <div className="settings-row-main">
          <span className="settings-row-name memory-repo-status" data-tone={status.tone ?? undefined}>{status.name}</span>
          {status.text && <span className="settings-row-desc">{status.text}</span>}
        </div>
        {repo.head && <code className="memory-repo-head" title="The latest commit">{repo.head}</code>}
      </div>
      <div className="settings-row memory-path-row">
        <div className="settings-row-main">
          <span className="settings-row-name">Stored at</span>
          <code className="env-path settings-row-desc">{repo.path}</code>
        </div>
        {reveal && <button type="button" className="btn-quiet" onClick={() => { void reveal(repo.path); }}>Show in Finder</button>}
        <button type="button" className="btn-quiet" title="Stop using this repo. The folder and its history stay where they are."
          onClick={() => run(() => detachMemoryRepo(owner))}>Detach</button>
      </div>
      {repo.valid && <SyncRows owner={owner} repo={repo} />}
      {repo.valid && <ClaudeImportRow owner={owner} head={repo.head} />}
      {log && log.length > 0 && (
        <details className="settings-row settings-disclosure">
          <summary>
            <div className="settings-row-main">
              <span className="settings-row-name">Recent memories</span>
              <span className="settings-row-desc">What agents saved, newest first.</span>
            </div>
            <Icon name="chevronRight" size={14} className="settings-disclosure-caret" />
          </summary>
          <ul className="settings-disclosure-body memory-repo-log">
            {log.map((c) => (
              <li key={c.sha}>
                <span className="memory-repo-log-subject">{c.subject}</span>
                <span className="memory-repo-log-when">{ago(c.at)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * Where the repo syncs, and the way to turn that on. Sync is opt-in and only ever to a private
 * remote: Realm asks GitHub where it can, and otherwise the user has to say so in a checkbox that is
 * never pre-ticked. A remote GitHub calls public gets no button at all. Once on, the row says in
 * words whether saves are waiting to push and, when the repo and its remote have diverged, the exact
 * commands to resolve it in Terminal — Realm itself never merges.
 */
function SyncRows({ owner, repo }: { owner: MemoryRepoOwner; repo: MemoryRepoState }) {
  const setMemoryRepoRemote = useApp((s) => s.setMemoryRepoRemote);
  const checkMemoryRepoRemote = useApp((s) => s.checkMemoryRepoRemote);
  const setMemoryRepoSync = useApp((s) => s.setMemoryRepoSync);
  const syncMemoryRepo = useApp((s) => s.syncMemoryRepo);
  const run = useApp((s) => s.run);
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState("");
  const [check, setCheck] = useState<MemoryRemoteCheck | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  // A different remote is a different question: an answer about the last one never carries over.
  useEffect(() => { setCheck(null); setConfirmed(false); }, [repo.remote]);

  const saveRemote = (e: FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    run(async () => { await setMemoryRepoRemote(owner, url.trim()); setEditing(false); setUrl(""); });
  };
  const turnOn = () => run(async () => { await setMemoryRepoSync(owner, true, check?.verdict === "unknown" && confirmed); setCheck(null); setConfirmed(false); });

  if (editing) {
    return (
      <form className="settings-row memory-remote-form" onSubmit={saveRemote}>
        <div className="settings-row-main">
          <span className="settings-row-name">Remote</span>
          <span className="settings-row-desc">A private repository you own. Nothing is pushed until you turn sync on.</span>
        </div>
        <input className="settings-text" aria-label="Remote URL" value={url} spellCheck={false} autoFocus placeholder="git@github.com:you/memory.git"
          onChange={(e) => setUrl(e.target.value)} />
        <span className="memory-repo-actions">
          <button type="button" className="btn" onClick={() => { setEditing(false); setUrl(""); }}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!url.trim()}>Save</button>
        </span>
      </form>
    );
  }
  if (repo.remote === null) {
    return (
      <div className="settings-row">
        <div className="settings-row-main">
          <span className="settings-row-name">Syncs to</span>
          <span className="settings-row-desc">Nowhere. It stays on this Mac.</span>
        </div>
        <button type="button" className="btn-quiet" title="Name a private remote this repo can sync with" onClick={() => setEditing(true)}>Add remote…</button>
      </div>
    );
  }
  if (!repo.pushEnabled) {
    return (
      <>
        <div className="settings-row">
          <div className="settings-row-main">
            <span className="settings-row-name">Syncs to</span>
            <code className="env-path settings-row-desc">{repo.remote}</code>
            <span className="settings-row-desc">Not synced. Realm only syncs memory to a private remote.</span>
          </div>
          <button type="button" className="btn-quiet" onClick={() => { setUrl(repo.remote ?? ""); setEditing(true); }}>Change…</button>
          {check === null && (
            <button type="button" className="btn" onClick={() => run(async () => setCheck(await checkMemoryRepoRemote(owner)))}>Turn on sync…</button>
          )}
        </div>
        {check && (
          <div className="settings-row memory-sync-check" data-verdict={check.verdict}>
            <div className="settings-row-main">
              <span className="settings-row-name memory-repo-status" data-tone={check.verdict === "public" ? "danger" : undefined}>
                {check.verdict === "private" ? "Private" : check.verdict === "public" ? "Public" : "Not checked"}
              </span>
              <span className="settings-row-desc">
                {check.verdict === "private" && `${check.detail}. Realm pulls before each save and pushes after it, never forced.`}
                {check.verdict === "public" && `${check.detail}. Memory never syncs to a public remote.`}
                {check.verdict === "unknown" && `${cap(check.detail)}. Turn sync on only for a private repository you own.`}
              </span>
              {check.verdict === "unknown" && (
                <label className="memory-sync-confirm">
                  <input type="checkbox" className="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                  I confirm this remote is private
                </label>
              )}
            </div>
            <span className="memory-repo-actions">
              <button type="button" className="btn" onClick={() => { setCheck(null); setConfirmed(false); }}>Cancel</button>
              {check.verdict !== "public" && (
                <button type="button" className="btn primary" disabled={check.verdict === "unknown" && !confirmed} onClick={turnOn}>Turn on sync</button>
              )}
            </span>
          </div>
        )}
      </>
    );
  }
  // git names the remote in its own words; the URL is on the line above, so the sentence says "the remote".
  const why = repo.syncError?.split(`'${repo.remote}'`).join("the remote").split(repo.remote).join("the remote") ?? null;
  const text = repo.sync === "synced" ? `Up to date${repo.lastSyncAt ? ` as of ${ago(repo.lastSyncAt)}` : ""}.`
    : repo.sync === "queued" ? `${plural(repo.ahead, "save", "saves")} waiting to push${why ? ` — ${why}` : ""}. Realm tries again on the next save.`
    : "It and this repo have both changed since they last matched. Realm never merges memory.";
  return (
    <>
      <div className="settings-row memory-sync-row" data-sync={repo.sync}>
        <div className="settings-row-main">
          <span className="settings-row-name">Syncs to</span>
          <code className="env-path settings-row-desc">{repo.remote}</code>
          <span className="settings-row-desc memory-repo-status" data-tone={repo.sync === "queued" ? "warning" : repo.sync === "diverged" ? "danger" : undefined}>{text}</span>
        </div>
        {repo.sync !== "synced" && <button type="button" className="btn" onClick={() => run(() => syncMemoryRepo(owner))}>Retry now</button>}
        <button type="button" className="btn-quiet" title="Stop pulling and pushing. The remote keeps what it has."
          onClick={() => run(() => setMemoryRepoSync(owner, false))}>Turn off</button>
      </div>
      {repo.sync === "diverged" && (
        <div className="settings-row memory-resolve-row">
          <div className="settings-row-main">
            <span className="settings-row-name">Resolve in Terminal</span>
            <span className="settings-row-desc">Pull, merge what both sides saved, and commit. Saving resumes once this repo holds the remote's history.</span>
            <CommandCopy command={`cd ${shellQuote(repo.path)} && git pull --no-rebase`} />
          </div>
        </div>
      )}
    </>
  );
}

/** A path as one shell word: bare when it is safe, single-quoted otherwise. */
const shellQuote = (p: string): string => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`);

/**
 * The Claude CLI memory Realm already imported, offered to this repo. Counted before anything is
 * written — the preview IS the button's label — and absent when there is nothing to add, so a user
 * with no Claude memory never sees it. Running it twice adds nothing.
 */
function ClaudeImportRow({ owner, head }: { owner: MemoryRepoOwner; head: string | null }) {
  const importClaudeMemory = useApp((s) => s.importClaudeMemory);
  const run = useApp((s) => s.run);
  const [preview, setPreview] = useState<MemoryClaudeImport | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [added, setAdded] = useState<number | null>(null);
  const { scope, id } = owner;
  useEffect(() => { run(async () => setPreview(await importClaudeMemory({ scope, id }, true))); }, [scope, id, head, importClaudeMemory, run]);

  if (added !== null && (preview === null || preview.entries === 0)) {
    return (
      <div className="settings-row">
        <div className="settings-row-main">
          <span className="settings-row-name">Claude memory</span>
          <span className="settings-row-desc">Imported {plural(added, "memory", "memories")}. Each entry names the file it came from.</span>
        </div>
      </div>
    );
  }
  if (preview === null || preview.entries === 0) return null;
  const left = preview.skipped.length > 0 ? ` ${plural(preview.skipped.length, "file stays", "files stay")} out: ${preview.skipped[0]!.reason}.` : "";
  return (
    <div className="settings-row memory-import-row">
      <div className="settings-row-main">
        <span className="settings-row-name">Claude memory</span>
        <span className="settings-row-desc">
          {confirming
            ? `Add ${plural(preview.entries, "memory", "memories")} and ${plural(preview.files, "file", "files")} to this repo as one commit? Each entry names the file it came from.${left}`
            : `${plural(preview.entries, "memory", "memories")} from ${plural(preview.projects, "project", "projects")} you imported from Claude ${preview.entries === 1 ? "is" : "are"} not in this repo yet.`}
        </span>
      </div>
      <span className="memory-repo-actions">
        {confirming ? (
          <>
            <button type="button" className="btn" onClick={() => setConfirming(false)}>Cancel</button>
            <button type="button" className="btn primary" onClick={() => run(async () => {
              const r = await importClaudeMemory(owner, false);
              setAdded(r.entries);
              setConfirming(false);
              setPreview(await importClaudeMemory(owner, true));
            })}>Import {preview.entries}</button>
          </>
        ) : (
          <button type="button" className="btn" onClick={() => setConfirming(true)}>Import…</button>
        )}
      </span>
    </div>
  );
}

/**
 * In a space: the profile's repo as this space inherits it, with the space's own switch — which turns
 * the repo off HERE and never touches the repo or the profile. Nothing at all when the profile has none:
 * a switch for a repo that does not exist is a control with no outcome.
 */
export function InheritedMemoryRepoRow({ spaceId, profileName }: { spaceId: string; profileName: string }) {
  const repos = useApp((s) => s.spaceMemoryRepos[spaceId]);
  const refreshSpaceMemoryRepos = useApp((s) => s.refreshSpaceMemoryRepos);
  const setMemoryRepoInherited = useApp((s) => s.setMemoryRepoInherited);
  const run = useApp((s) => s.run);
  useEffect(() => { run(() => refreshSpaceMemoryRepos(spaceId)); }, [spaceId, refreshSpaceMemoryRepos, run]);
  const inherited = (repos ?? []).filter((r) => r.scope === "profile");
  if (inherited.length === 0) return null;
  return (
    <>
      {inherited.map((r) => {
        const status = repoStatus(r);
        return (
          <label key={r.path} className="settings-row" title={r.path}>
            <div className="settings-row-main">
              <span className="settings-row-name">{profileName}'s memory repo</span>
              <span className="settings-row-desc memory-repo-status" data-tone={status.tone ?? undefined}>
                {r.inheritedHere ? status.sentence : "Off in this space: its sessions neither read it nor save to it."}
              </span>
            </div>
            <input type="checkbox" role="switch" className="switch" aria-label={`Use ${profileName}'s memory repo in this space`}
              checked={r.inheritedHere === true} onChange={(e) => run(() => setMemoryRepoInherited(spaceId, e.target.checked))} />
          </label>
        );
      })}
    </>
  );
}
