import { pickSpaceColor } from "@realm/contracts";
import { useState } from "react";
import { useApp } from "../../state/store";
import { Sheet } from "../Sheet";

/** Minimal "new space" sheet: name + profile; icon and color are auto-picked and editable later in
 *  Space settings. Profiles can be created inline — with zero profiles (transient boot states) the
 *  mini-field is forced open and the dead end is explained instead of silently disabling Create. */
export function NewSpaceSheet() {
  const profiles = useApp((s) => s.profiles);
  const spaces = useApp((s) => s.spaces);
  const activeProfileId = useApp((s) => s.activeSpace()?.profileId ?? null);
  const createSpace = useApp((s) => s.createSpace);
  const createProfile = useApp((s) => s.createProfile);
  const closeSheet = useApp((s) => s.closeSheet);
  const run = useApp((s) => s.run);
  const [name, setName] = useState("");
  const [chosenProfileId, setChosenProfileId] = useState(activeProfileId ?? profiles[0]?.id ?? "");
  const [addingProfile, setAddingProfile] = useState(false);
  const [profileName, setProfileName] = useState("");
  // Fall back to the first profile when the chosen one is gone or unset (profiles may arrive after mount).
  const profileId = profiles.some((p) => p.id === chosenProfileId) ? chosenProfileId : profiles[0]?.id ?? "";
  const noProfiles = profiles.length === 0;
  const addProfile = () => {
    const n = profileName.trim(); if (!n) return;
    run(async () => {
      const p = await createProfile(n);
      setChosenProfileId(p.id); setProfileName(""); setAddingProfile(false);
    });
  };
  const submit = () => {
    const n = name.trim(); if (!n || !profileId) return;
    run(() => createSpace({ name: n, icon: "folder", profileId, color: pickSpaceColor(spaces.length) }));
    closeSheet();
  };
  return (
    <Sheet title="New space" onClose={closeSheet} width={360}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label className="field"><span>Name</span><input aria-label="Space name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Versed" /></label>
        <div className="field"><span>Profile</span>
          {noProfiles
            ? <span className="muted">No profiles yet — name one below and Create unlocks.</span>
            : <select aria-label="Profile" value={profileId} onChange={(e) => setChosenProfileId(e.target.value)}>
                {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>}
          {(addingProfile || noProfiles) ? (
            <div className="profile-add-row">
              <input aria-label="New profile name" placeholder="Profile name" value={profileName}
                onChange={(e) => setProfileName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addProfile(); } }} />
              <button type="button" className="btn" onClick={addProfile} disabled={!profileName.trim()}>Add</button>
            </div>
          ) : (
            <button type="button" className="profile-add-link" onClick={() => setAddingProfile(true)}>New profile…</button>
          )}
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={closeSheet}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!name.trim() || !profileId}>Create</button>
        </div>
      </form>
    </Sheet>
  );
}
