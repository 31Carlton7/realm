import type { MemoryRepoState } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect } from "react";
import { useApp } from "../../state/store";
import { ago } from "../../panes/code-review/code-review-model";

/**
 * The memory repo, as rows: the memory AGENTS write (Agent Memory Repo), beside the documents the
 * user writes. One per profile, inherited by its spaces.
 *
 * Its state is said in words rather than a dot — a repo with uncommitted changes refuses saves until
 * someone commits them, and the reason has to be readable where the repo is shown.
 */
export function repoStatus(r: MemoryRepoState, now = Date.now()): { text: string; tone: "danger" | "warning" | null } {
  if (!r.valid) return { text: `Not a memory repo: ${r.reason ?? "unknown"}.`, tone: "danger" };
  if (!r.clean) return { text: `${r.reason ?? "Uncommitted changes"}.`, tone: "warning" };
  if (r.lastCommitAt === null) return { text: "No commits yet.", tone: null };
  return { text: `Last saved ${ago(r.lastCommitAt, now)}: ${r.lastCommitSubject ?? ""}`, tone: null };
}

/** At the profile's own Memory page: create or attach, then the repo with its folder and history. */
export function MemoryRepoRow({ profileId }: { profileId: string }) {
  const repo = useApp((s) => s.profileMemoryRepo[profileId]);
  const log = useApp((s) => s.memoryRepoLog[profileId]);
  const refreshProfileMemoryRepo = useApp((s) => s.refreshProfileMemoryRepo);
  const refreshMemoryRepoLog = useApp((s) => s.refreshMemoryRepoLog);
  const createMemoryRepo = useApp((s) => s.createMemoryRepo);
  const attachMemoryRepo = useApp((s) => s.attachMemoryRepo);
  const detachMemoryRepo = useApp((s) => s.detachMemoryRepo);
  const run = useApp((s) => s.run);
  useEffect(() => { run(() => refreshProfileMemoryRepo(profileId)); }, [profileId, refreshProfileMemoryRepo, run]);
  const hasRepo = repo !== undefined && repo !== null;
  useEffect(() => { if (hasRepo) run(() => refreshMemoryRepoLog(profileId)); }, [hasRepo, profileId, refreshMemoryRepoLog, run]);

  if (repo === undefined) return <div className="settings-group"><p className="env-empty">Loading…</p></div>;
  if (repo === null) {
    return (
      <div className="settings-group memory-repo">
        <div className="settings-row">
          <div className="settings-row-main">
            <span className="settings-row-name">No memory repo</span>
            <span className="settings-row-desc">Agents save what they learn about you to a git repo of Markdown files, and every engine reads it back in later sessions.</span>
          </div>
          <span className="memory-repo-actions">
            <button type="button" className="btn" title="Choose a folder that already holds a memory repo, such as ~/agent-memory"
              onClick={() => run(() => attachMemoryRepo(profileId))}>Attach existing…</button>
            <button type="button" className="btn primary" title="Make a new memory repo under Realm's folder on this Mac"
              onClick={() => run(() => createMemoryRepo(profileId))}>Create</button>
          </span>
        </div>
      </div>
    );
  }
  const status = repoStatus(repo);
  const reveal = window.realm?.files?.reveal;
  return (
    <div className="settings-group memory-repo">
      <div className="settings-row">
        <div className="settings-row-main">
          <span className="settings-row-name">Memory repo</span>
          <span className="settings-row-desc memory-repo-status" data-tone={status.tone ?? undefined}>{status.text}</span>
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
          onClick={() => run(() => detachMemoryRepo(profileId))}>Detach</button>
      </div>
      <div className="settings-row">
        <div className="settings-row-main">
          <span className="settings-row-name">Syncs to</span>
          <span className="settings-row-desc">{repo.remote ? <><code className="env-path">{repo.remote}</code> — Realm does not push to it</> : "Nowhere. It stays on this Mac."}</span>
        </div>
      </div>
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
  if (!repos || repos.length === 0) return null;
  return (
    <>
      {repos.map((r) => {
        const status = repoStatus(r);
        return (
          <label key={r.path} className="settings-row" title={r.path}>
            <div className="settings-row-main">
              <span className="settings-row-name">{profileName}'s memory repo</span>
              <span className="settings-row-desc memory-repo-status" data-tone={status.tone ?? undefined}>
                {r.inheritedHere ? status.text : "Off in this space: its sessions neither read it nor save to it."}
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
