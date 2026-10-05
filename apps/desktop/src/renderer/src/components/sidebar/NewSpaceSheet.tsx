import { AGENT_META, pickSpaceColor } from "@realm/contracts";
import { useEffect, useId, useRef, useState } from "react";
import { FALLBACK_AGENT, folderName, useApp } from "../../state/store";
import { Sheet } from "../Sheet";
import { DEFAULT_SPACE_ICON, SpaceFolderField, SpaceIdentityField } from "../space-fields";

/** The profile list's last row: not a profile but the way to make one, as a Mac popup's "New…" is. */
const NEW_PROFILE = "new-profile";

/**
 * New space: what a space is made of, chosen before it exists, and a Create that opens it on a
 * session.
 *
 * The identity leads — the name, with the icon tile beside it and the swatches under it, the same
 * fields first run asks with (`space-fields.tsx`) — because the name is the one thing anybody has to
 * give. Under it, one card of the rest, each with a working default: the folder (or where the space
 * works without one), the profile it belongs to (a new one made in place), and the memory every
 * session there reads first. The line by Create says what it does — the space opens on a new
 * session, on the agent last used — and that is where the window lands, prompter focused, never the
 * space's settings (`openNewSpace`).
 *
 * Fast on purpose: the name has the keyboard when the sheet opens and Enter creates, so a name and
 * Return is the whole of it. With zero profiles (transient boot states) the profile field is forced
 * open and the dead end is explained, instead of a Create that is silently disabled.
 */
export function NewSpaceSheet() {
  const profiles = useApp((s) => s.profiles);
  const spaces = useApp((s) => s.spaces);
  const activeProfileId = useApp((s) => s.activeProfileId);
  const agentKind = useApp((s) => s.lastAgentKind ?? FALLBACK_AGENT);
  const createSpace = useApp((s) => s.createSpace);
  const createProfile = useApp((s) => s.createProfile);
  const closeSheet = useApp((s) => s.closeSheet);
  const run = useApp((s) => s.run);
  const nameRef = useRef<HTMLInputElement>(null);
  const profileSelect = useId();
  const [name, setName] = useState("");
  const [icon, setIcon] = useState(DEFAULT_SPACE_ICON);
  // The next colour along, so a new space does not start out wearing its neighbour's.
  const [color, setColor] = useState(() => pickSpaceColor(spaces.length));
  const [folder, setFolder] = useState<string | null>(null);
  // Null while the row is folded: most spaces start without memory, and the row is a line until asked.
  const [memory, setMemory] = useState<string | null>(null);
  const [chosenProfileId, setChosenProfileId] = useState(activeProfileId ?? profiles[0]?.id ?? "");
  const [addingProfile, setAddingProfile] = useState(false);
  const [profileName, setProfileName] = useState("");
  // Fall back to the first profile when the chosen one is gone or unset (profiles may arrive after mount).
  const profileId = profiles.some((p) => p.id === chosenProfileId) ? chosenProfileId : profiles[0]?.id ?? "";
  const noProfiles = profiles.length === 0;
  // After the sheet's own focus, which goes to its first control — the icon tile.
  useEffect(() => { nameRef.current?.focus(); }, []);

  const chooseProfile = (id: string) => {
    // An uploaded or generated icon is filed under the profile it was made in, and drawn from that
    // library; carried into another profile's space it would come out as the folder glyph.
    if (id !== profileId && icon.startsWith("asset:")) setIcon(DEFAULT_SPACE_ICON);
    setChosenProfileId(id);
  };
  const addProfile = () => {
    const n = profileName.trim(); if (!n) return;
    run(async () => {
      const p = await createProfile(n);
      chooseProfile(p.id); setProfileName(""); setAddingProfile(false);
    });
  };

  // A folder names the space when nothing is typed, as on first run.
  const suggested = folder ? folderName(folder) : "";
  const spaceName = name.trim() || suggested;
  const ready = spaceName !== "" && profileId !== "";
  const submit = () => {
    if (!ready) return;
    closeSheet();
    run(() => createSpace({ name: spaceName, icon, color, profileId, folder, memory: memory ?? undefined }));
  };

  return (
    <Sheet title="New space" onClose={closeSheet} width={460}>
      <form className="form new-space" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <SpaceIdentityField nameRef={nameRef} name={name} onName={setName} placeholder={suggested || "e.g. Versed"}
          icon={icon} onIcon={setIcon} color={color} onColor={setColor} profileId={profileId} />
        <div className="settings-group">
          <SpaceFolderField className="settings-row new-space-row" folder={folder} onFolder={setFolder} profileId={profileId} name={spaceName} />
          <div className="settings-row new-space-row">
            <label className="settings-row-name" htmlFor={profileSelect}>Profile</label>
            {noProfiles
              ? <span className="new-space-note">No profiles yet — name one below and Create unlocks.</span>
              : (
                <select id={profileSelect} aria-label="Profile" value={profileId}
                  onChange={(e) => { if (e.target.value === NEW_PROFILE) setAddingProfile(true); else chooseProfile(e.target.value); }}>
                  {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  <hr />
                  <option value={NEW_PROFILE}>New profile…</option>
                </select>
              )}
            {(addingProfile || noProfiles) && (
              <div className="profile-add-row">
                {/* Enter adds the profile rather than submitting the sheet, which would make the
                    space in the profile the name was about to replace. */}
                <input aria-label="New profile name" placeholder="Profile name" value={profileName} autoFocus={!noProfiles}
                  onChange={(e) => setProfileName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addProfile(); } }} />
                <button type="button" className="btn" onClick={addProfile} disabled={!profileName.trim()}>Add</button>
              </div>
            )}
          </div>
          <div className="settings-row new-space-row">
            <div className="new-space-row-main">
              <span className="settings-row-name">Memory</span>
              <span className="settings-row-desc">Every session in this space reads it before it starts.</span>
            </div>
            {memory === null
              ? <button type="button" className="btn new-space-memory-add" onClick={() => setMemory("")}>Write…</button>
              : (
                <textarea className="new-space-memory" aria-label="Memory" rows={3} autoFocus value={memory}
                  placeholder="A convention, a warning, a preference — “Use pnpm. Never push to main.”"
                  onChange={(e) => setMemory(e.target.value)}
                  // ⌘↩ creates, as it sends in the prompter; Return alone is a new line in a paragraph.
                  onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } }} />
              )}
          </div>
        </div>
        <div className="new-space-foot">
          <p className="new-space-summary">Opens on a new {AGENT_META[agentKind].label} session.</p>
          <button type="button" className="btn" onClick={closeSheet}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!ready}>Create</button>
        </div>
      </form>
    </Sheet>
  );
}
