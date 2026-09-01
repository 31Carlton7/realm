import { SPACE_COLORS, SPACE_ICONS } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useState } from "react";
import { useApp } from "../../state/store";
import { Sheet } from "../Sheet";
import { McpSection } from "./McpSection";

const HEX = /^#[0-9a-f]{6}$/i;

const KIND_LABEL = { primary: "Space folder", checkout: "Linked checkout", worktree: "Worktree" } as const;

/**
 * Every checkout this space knows about (W1/W2), and which sessions are in each (W3).
 *
 * This is the only place the split Plan 7 made is actually visible as a list — the prompter shows a
 * session its OWN environment, which answers "where am I" but never "what else is running". Removal
 * lives here too, because a worktree outlives the session that opened it: after that session is
 * deleted there is otherwise nothing left pointing at the directory.
 *
 * `environments.list` is empty for a brand-new space — the primary row is created lazily on first
 * use — so an empty list is a normal state and says so rather than rendering nothing.
 */
export function EnvironmentList({ spaceId }: { spaceId: string }) {
  const environments = useApp((s) => s.environments);
  const sessions = useApp((s) => s.sessions);
  const openDiff = useApp((s) => s.openDiff);
  const askRemoveWorktree = useApp((s) => s.askRemoveWorktree);
  const closeSheet = useApp((s) => s.closeSheet);
  const run = useApp((s) => s.run);
  const list = Object.values(environments).filter((e) => e.spaceId === spaceId);
  return (
    <div className="field">
      <span>Checkouts</span>
      {list.length === 0
        ? <p className="env-empty">This space has not run anything yet, so it has no checkout on record.</p>
        : (
          <ul className="env-list">
            {list.map((e) => {
              const here = Object.values(sessions).filter((s) => s.environmentId === e.id);
              return (
                <li key={e.id} className="env-row">
                  <div className="env-main">
                    <Icon name={e.kind === "worktree" ? "branch" : "folder"} size={14} />
                    <span className="env-name">{e.branch ?? e.path.replace(/\/+$/, "").split("/").pop()}</span>
                    <span className="env-kind">{KIND_LABEL[e.kind]}</span>
                  </div>
                  <div className="env-meta">
                    <code className="env-path">{e.path}</code>
                    {/* A RANGE Realm reserved, not a claim about what is listening on it. */}
                    {e.portBlockStart !== null && <span className="env-ports">ports {e.portBlockStart}–{e.portBlockStart + 9} reserved</span>}
                    <span className="env-sessions">{here.length === 0 ? "no sessions" : here.length === 1 ? "1 session" : `${here.length} sessions`}</span>
                  </div>
                  <div className="env-actions">
                    <button type="button" className="btn-quiet" onClick={() => { closeSheet(); run(() => openDiff(e.id)); }}>Changes</button>
                    {e.kind === "worktree" && (
                      <button type="button" className="btn-quiet" onClick={() => run(() => askRemoveWorktree(e.id))}>Remove…</button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
    </div>
  );
}

/** Edit a space: name, icon, color (presets + custom hex), profile; delete with inline confirm. */
export function SpaceSettingsSheet({ spaceId }: { spaceId: string }) {
  const space = useApp((s) => s.spaces.find((x) => x.id === spaceId));
  const profiles = useApp((s) => s.profiles);
  const updateSpace = useApp((s) => s.updateSpace);
  const deleteSpace = useApp((s) => s.deleteSpace);
  const closeSheet = useApp((s) => s.closeSheet);
  const run = useApp((s) => s.run);
  const [name, setName] = useState(space?.name ?? "");
  const [hex, setHex] = useState(space?.color ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => { if (space) setHex(space.color); }, [space?.color]);
  // The space vanished (deleted elsewhere): nothing to edit.
  useEffect(() => { if (!space) closeSheet(); }, [space, closeSheet]);
  if (!space) return null;

  const commitName = () => { const n = name.trim(); if (n && n !== space.name) run(() => updateSpace({ id: space.id, name: n })); else setName(space.name); };
  const commitHex = (v: string) => { const h = v.trim().toLowerCase(); setHex(h); if (HEX.test(h) && h !== space.color) run(() => updateSpace({ id: space.id, color: h })); };

  return (
    <Sheet title="Space settings" onClose={closeSheet}>
      <div className="form">
        <label className="field"><span>Name</span>
          <input aria-label="Space name" value={name} onChange={(e) => setName(e.target.value)} onBlur={commitName}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
        </label>
        <div className="field"><span>Icon</span>
          <div className="icon-grid" role="radiogroup" aria-label="Icon">
            {SPACE_ICONS.map((ic) => (
              <button key={ic} type="button" role="radio" aria-checked={space.icon === ic} aria-label={`Icon ${ic}`} className="icon-choice" data-selected={space.icon === ic || undefined}
                onClick={() => run(() => updateSpace({ id: space.id, icon: ic }))}><Icon name={ic} size={18} /></button>
            ))}
          </div>
        </div>
        <div className="field"><span>Color</span>
          <div className="swatches" role="radiogroup" aria-label="Color">
            {SPACE_COLORS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={space.color === c} aria-label={`Color ${c}`} className="swatch" data-selected={space.color === c || undefined}
                style={{ background: c }} onClick={() => commitHex(c)} />
            ))}
            <input aria-label="Custom color" className="hex" value={hex} onChange={(e) => commitHex(e.target.value)} placeholder="#rrggbb" spellCheck={false} />
          </div>
        </div>
        <label className="field"><span>Profile</span>
          <select aria-label="Profile" value={space.profileId} onChange={(e) => run(() => updateSpace({ id: space.id, profileId: e.target.value }))}>
            {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <EnvironmentList spaceId={space.id} />
        <McpSection spaceId={space.id} />
        <div className="form-actions danger-zone">
          {confirmDelete ? (
            <>
              <span className="muted">Delete “{space.name}” and its items?</span>
              <button type="button" className="btn" onClick={() => setConfirmDelete(false)}>Cancel</button>
              <button type="button" className="btn danger" onClick={() => { closeSheet(); run(() => deleteSpace(space.id)); }}>Delete</button>
            </>
          ) : <button type="button" className="btn danger" onClick={() => setConfirmDelete(true)}>Delete space…</button>}
        </div>
      </div>
    </Sheet>
  );
}
