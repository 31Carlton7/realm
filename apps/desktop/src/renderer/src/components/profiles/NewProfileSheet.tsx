import { SPACE_COLORS, pickSpaceColor } from "@realm/contracts";
import { Icon, type IconName } from "@realm/ui";
import { useState } from "react";
import { useApp } from "../../state/store";
import { Sheet } from "../Sheet";

/** The glyphs a new profile is offered — the identities people keep apart. The profile page's General
 *  tab has the full picker (emoji, generated, uploaded) once the profile exists to own those. */
export const PROFILE_ICONS: readonly IconName[] = ["user", "briefcase", "cap", "home", "code", "heart", "star", "book"];

/**
 * New profile (Plan 27 Phase 2): a name, an icon and a colour. A profile is an identity — its own
 * spaces, browser cookies, saved sign-ins and passkeys, connections and memory — so the sheet says that
 * much once, under the name, because it is what someone deciding whether they want a second profile or
 * just another space needs to know. Everything else about it is edited on its page later.
 */
export function NewProfileSheet() {
  const profiles = useApp((s) => s.profiles);
  const createProfile = useApp((s) => s.createProfile);
  const selectProfile = useApp((s) => s.selectProfile);
  const closeSheet = useApp((s) => s.closeSheet);
  const run = useApp((s) => s.run);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<IconName>("user");
  // The next colour the list has not used yet, so two new profiles do not start out identical.
  const [color, setColor] = useState<string>(pickSpaceColor(profiles.length));
  const submit = () => {
    const n = name.trim();
    if (!n) return;
    closeSheet();
    run(async () => {
      const p = await createProfile({ name: n, icon, color });
      await selectProfile(p.id);
    });
  };
  return (
    <Sheet title="New profile" onClose={closeSheet} width={400}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label className="field"><span>Name</span>
          <input aria-label="Profile name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Work" />
        </label>
        <p className="settings-hint">
          A profile keeps its own spaces, browser sign-ins, saved sign-ins and passkeys. Nothing of one
          profile reaches another unless you share it.
        </p>
        <div className="field"><span>Icon</span>
          <div className="swatches" role="radiogroup" aria-label="Icon">
            {PROFILE_ICONS.map((g) => (
              <button key={g} type="button" role="radio" aria-checked={icon === g} aria-label={`Icon ${g}`} className="swatch profile-icon-choice"
                data-selected={icon === g || undefined} onClick={() => setIcon(g)}>
                <Icon name={g} size={16} />
              </button>
            ))}
          </div>
        </div>
        <div className="field"><span>Colour</span>
          <div className="swatches" role="radiogroup" aria-label="Colour">
            {SPACE_COLORS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={`Colour ${c}`} className="swatch"
                data-selected={color === c || undefined} style={{ background: c }} onClick={() => setColor(c)} />
            ))}
          </div>
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={closeSheet}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!name.trim()}>Create profile</button>
        </div>
      </form>
    </Sheet>
  );
}
