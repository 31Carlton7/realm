import { pickSpaceColor } from "@realm/contracts";
import { useState } from "react";
import { useApp } from "../../state/store";
import { Sheet } from "../Sheet";

/** Minimal "new space" sheet: name + profile; icon and color are auto-picked and editable later in Space settings. */
export function NewSpaceSheet() {
  const profiles = useApp((s) => s.profiles);
  const spaces = useApp((s) => s.spaces);
  const activeProfileId = useApp((s) => s.activeSpace()?.profileId ?? null);
  const createSpace = useApp((s) => s.createSpace);
  const closeSheet = useApp((s) => s.closeSheet);
  const run = useApp((s) => s.run);
  const [name, setName] = useState("");
  const [profileId, setProfileId] = useState(activeProfileId ?? profiles[0]?.id ?? "");
  const submit = () => {
    const n = name.trim(); if (!n || !profileId) return;
    run(() => createSpace({ name: n, icon: "folder", profileId, color: pickSpaceColor(spaces.length) }));
    closeSheet();
  };
  return (
    <Sheet title="New space" onClose={closeSheet} width={360}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label className="field"><span>Name</span><input aria-label="Space name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Versed" /></label>
        <label className="field"><span>Profile</span>
          <select aria-label="Profile" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
            {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <div className="form-actions">
          <button type="button" className="btn" onClick={closeSheet}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!name.trim() || !profileId}>Create</button>
        </div>
      </form>
    </Sheet>
  );
}
