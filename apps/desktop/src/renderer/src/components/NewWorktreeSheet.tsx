import { BRANCH_PREFIX, slugifyBranch } from "@realm/contracts";
import { useEffect, useRef, useState } from "react";
import { useApp } from "../state/store";
import { Sheet } from "./Sheet";
import { Spinner } from "./Spinner";

/**
 * A worktree with a name: what it is for, and the branch it starts from. The branch it gets is
 * derived from the name as it is typed, so there is nothing else to fill in — the name has the
 * keyboard, the space folder's current branch is already chosen, and Return creates.
 *
 * Making a thing lands you in it (design.md): Create opens a new session in the worktree with the
 * keyboard in its prompter. A blank name still makes one, called `realm/session` until the session's
 * first message names it, which is what the instant "New session in a worktree" does.
 */
export function NewWorktreeSheet({ spaceId }: { spaceId: string }) {
  const space = useApp((s) => s.spaces.find((x) => x.id === spaceId));
  const list = useApp((s) => s.worktreeBranches[spaceId] ?? null);
  const newSessionInWorktree = useApp((s) => s.newSessionInWorktree);
  const closeSheet = useApp((s) => s.closeSheet);
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const branches = list?.branches ?? [];
  const [base, setBase] = useState(list?.current ?? branches[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => { nameRef.current?.focus(); }, []);

  // What the server will call it, before `-2` if that one is taken.
  const branch = BRANCH_PREFIX + slugifyBranch(name.trim() || "session");
  const submit = () => {
    if (busy) return;
    setBusy(true); setFailure(null);
    newSessionInWorktree(null, spaceId, { title: name.trim() || null, base: base || null })
      .then(() => closeSheet())
      .catch((e: unknown) => {
        setFailure(`The worktree wasn't created: ${e instanceof Error ? e.message : String(e)}`);
        setBusy(false);
      });
  };

  return (
    <Sheet title="New worktree" onClose={closeSheet} width={460}>
      <form className="form new-worktree" aria-busy={busy || undefined} onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <fieldset className="new-space-fields" disabled={busy}>
          <label className="field"><span>Name</span>
            <input ref={nameRef} aria-label="Worktree name" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Fix the login flow" spellCheck={false} />
          </label>
          <label className="field"><span>Start from</span>
            <select aria-label="Start from" value={base} onChange={(e) => setBase(e.target.value)}>
              {branches.map((b) => <option key={b} value={b}>{b === list?.current ? `${b} (checked out)` : b}</option>)}
            </select>
          </label>
          <p className="wt-derived" title={`A checkout of its own, so ${space?.name ?? "the space"}'s folder is left as it is`}>
            Makes branch <code className="wt-branch">{branch}</code>{base && <> from <code className="wt-branch">{base}</code></>}.
          </p>
        </fieldset>
        <div className="new-space-foot">
          {failure
            ? <p className="new-space-summary" role="alert" data-tone="danger">{failure}</p>
            : <p className="new-space-summary">Opens on a new session in it.</p>}
          <button type="button" className="btn" onClick={closeSheet}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy} aria-busy={busy || undefined}>
            {busy ? <><Spinner size={14} /> Creating…</> : "Create"}
          </button>
        </div>
      </form>
    </Sheet>
  );
}
