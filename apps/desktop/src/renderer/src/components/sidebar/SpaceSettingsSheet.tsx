import { SPACE_COLORS, SPACE_ICONS } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useState } from "react";
import { useApp } from "../../state/store";
import { Sheet } from "../Sheet";

const HEX = /^#[0-9a-f]{6}$/i;

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
