import { AGENT_META, SELECTABLE_AGENT_KINDS, skillSupportNote, type Skill, type SkillSource } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useMemo, useState } from "react";
import { useApp } from "../../state/store";
import { MoveScopeConfirm, ScopeGroups } from "../scoped/ScopeGroups";

/**
 * The skills tab of the space page (W5, sheet-era; a pane tab since Plan 12 W3): Realm's library with THIS space's toggles.
 *
 * Two disclosures here are load-bearing, not copy (the plan's W1 carry-forwards):
 *
 * 1. Enabling any skill runs this space's Claude sessions with `settingSources: []`, which isolates
 *    them from the user's own installed skills and settings files — said in one line beside the
 *    toggles, with the note that Realm re-injects `CLAUDE.md` to compensate (W3 built that).
 * 2. Codex skill roots are per-connection, not per-space: a skill enabled anywhere is visible to
 *    Codex sessions everywhere. Said on the Codex row, where it is true.
 *
 * Invalid skills are LISTED with their reason — silence about a broken `SKILL.md` is the failure mode
 * W1 designed against. They get no toggle because they are never staged regardless of the flag.
 */
export function SkillsPanel({ spaceId }: { spaceId: string }) {
  const skills = useApp((s) => s.spaceSkills[spaceId]);
  const sources = useApp((s) => s.spaceSkillSources[spaceId]);
  const root = useApp((s) => s.skillsRoot);
  const refreshSkills = useApp((s) => s.refreshSkills);
  const refreshSkillSources = useApp((s) => s.refreshSkillSources);
  const run = useApp((s) => s.run);
  const [query, setQuery] = useState("");
  const [onlyEnabled, setOnlyEnabled] = useState(false);
  useEffect(() => { run(() => refreshSkills(spaceId)); run(() => refreshSkillSources(spaceId)); },
    [spaceId, refreshSkills, refreshSkillSources, run]);

  const all = skills ?? [];
  // Filtering happens over the WHOLE list before it is split by origin, so a search never has to be
  // repeated per section and an empty section simply does not render.
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((sk) => {
      if (onlyEnabled && !sk.enabled) return false;
      if (!q) return true;
      return sk.id.toLowerCase().includes(q) || sk.name.toLowerCase().includes(q) || sk.description.toLowerCase().includes(q);
    });
  }, [all, query, onlyEnabled]);

  // Realm's own library keeps the scope grouping it has always had — scope is a Realm concept and only
  // library skills are Realm's to move. Everything discovered elsewhere groups by the directory it came
  // from, which is the question the user actually has about it.
  const library = shown.filter((sk) => sk.origin.kind === "library");
  const external = useMemo(() => {
    const groups = new Map<string, { label: string; skills: Skill[] }>();
    for (const sk of shown) {
      if (sk.origin.kind === "library") continue;
      const g = groups.get(sk.origin.key) ?? { label: sk.origin.label, skills: [] };
      g.skills.push(sk);
      groups.set(sk.origin.key, g);
    }
    return [...groups.values()];
  }, [shown]);

  const enabledCount = all.filter((sk) => sk.enabled && sk.valid).length;

  return (
    <div className="form settings-panel">
      {/* Disclosure #1, restated for discovery: isolation is still real, but it is no longer a loss of
          your own skills — they are in the list above it, and switching one on brings it along. */}
      <p className="settings-note">
        Enabling any skill isolates this space's Claude sessions from your own settings files — they run
        with the skills switched on here and nothing else, so anything you want out of your installed
        folders has to be switched on above. Your <code>CLAUDE.md</code> files are re-injected by Realm
        to compensate.
      </p>
      <div className="field">
        <span>Skills in this space</span>
        {!skills ? <p className="env-empty">Loading…</p> : all.length === 0 ? (
          <p className="env-empty">No skills yet. Drop a folder containing a SKILL.md into <code className="env-path">{root}</code>.</p>
        ) : (
          <>
            <div className="skills-filter">
              <Icon name="search" size={13} className="skills-filter-glyph" />
              <input type="text" className="skills-filter-input" placeholder={`Search ${all.length} skills…`}
                aria-label="Search skills" value={query} onChange={(e) => setQuery(e.target.value)} />
              <label className="skills-filter-toggle">
                <input type="checkbox" checked={onlyEnabled} onChange={(e) => setOnlyEnabled(e.target.checked)} />
                On only ({enabledCount})
              </label>
            </div>
            {shown.length === 0 ? (
              <p className="env-empty">Nothing matches.</p>
            ) : (
              <>
                {library.length > 0 && (
                  // W4: the shared scope grouping — "This space" / "From <profile>" / "Everywhere".
                  <ScopeGroups entries={library.map((sk) => ({ key: sk.id, scope: sk.scope, row: <SkillRow key={sk.id} spaceId={spaceId} skill={sk} /> }))} />
                )}
                {external.map((g) => (
                  <div key={g.label} className="skills-origin-group">
                    <div className="skills-origin-label">{g.label}</div>
                    <ul className="settings-list">
                      {g.skills.map((sk) => <SkillRow key={sk.id} spaceId={spaceId} skill={sk} />)}
                    </ul>
                  </div>
                ))}
              </>
            )}
          </>
        )}
        {skills && all.length > 0 && (
          <p className="settings-hint">
            Skills in Realm's own library are on by default; skills found in your installed folders are
            off until you switch them on. Library: <code className="env-path">{root}</code>
          </p>
        )}
      </div>
      <SourcesField spaceId={spaceId} sources={sources} />
      <div className="field">
        <span>What each agent does with this library</span>
        <ul className="settings-list">
          {SELECTABLE_AGENT_KINDS.map((kind) => (
            <li key={kind} className="settings-agent-row">
              <Icon name={AGENT_META[kind].icon} size={14} colored />
              <span className="settings-agent-note">
                {skillSupportNote(kind)}
                {/* Disclosure #2, stated where it is true: Codex extra roots are per-connection. */}
                {kind === "codex" && " Codex reads skill roots per connection, not per space: skills enabled in any space are visible to Codex sessions in every space."}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * Where the list came from: every directory this space's scan reads, with what each contributed.
 *
 * This is the panel's answer to "is Realm actually seeing my skills". A source that found nothing is
 * still listed with a zero — "I added that folder and nothing appeared" is the exact question, and
 * hiding the empty row answers it with silence. Only user-added folders get a Remove: Realm's library,
 * the agent directories and the installed plugins are facts about the machine, and a button claiming to
 * remove one would be claiming Realm could stop it existing.
 */
function SourcesField({ spaceId, sources }: { spaceId: string; sources: SkillSource[] | undefined }) {
  const pickAndAddSkillScanRoot = useApp((s) => s.pickAndAddSkillScanRoot);
  const removeSkillScanRoot = useApp((s) => s.removeSkillScanRoot);
  const run = useApp((s) => s.run);

  return (
    <div className="field">
      <span>Where Realm looks for skills</span>
      {!sources ? <p className="env-empty">Loading…</p> : (
        <ul className="settings-list">
          {sources.map((src) => (
            <li key={src.key} className="settings-row">
              <div className="settings-row-main">
                <span className="settings-row-name">{src.label}</span>
                <span className="settings-row-desc">
                  <code className="env-path">{src.path}</code> · {src.count} {src.count === 1 ? "skill" : "skills"}
                </span>
              </div>
              {src.removable && (
                <button type="button" className="btn-quiet" onClick={() => run(() => removeSkillScanRoot(spaceId, src.path))}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="btn-quiet" onClick={() => run(() => pickAndAddSkillScanRoot(spaceId))}>Add a folder…</button>
      <p className="settings-hint">
        Realm only ever reads these folders — nothing is copied, moved or written back into them.
      </p>
    </div>
  );
}

/**
 * One skill row, wherever its group sits. The toggle is ALWAYS this space's state: for an inherited
 * (profile-scoped) skill the server flips the per-space override, never the defining scope — the same
 * `skills.setEnabled` wire either way, which is why the row never branches on scope for it.
 *
 * Skills have no editor at any scope (a skill IS its directory on disk — the path names it), so unlike
 * MCP rows there is no in-place edit to withhold and no "Edit in profile" to offer. What scope adds
 * here is movement: "Move to profile…" on a space/pre-scoping row, "Move to this space…" on an
 * inherited one, both behind the shared confirm that states the reach semantics.
 */
function SkillRow({ spaceId, skill: sk }: { spaceId: string; skill: Skill }) {
  const profiles = useApp((s) => s.profiles);
  const space = useApp((s) => s.spaces.find((x) => x.id === spaceId));
  const setSkillEnabled = useApp((s) => s.setSkillEnabled);
  const promoteSkill = useApp((s) => s.promoteSkill);
  const demoteSkill = useApp((s) => s.demoteSkill);
  const run = useApp((s) => s.run);
  const [confirming, setConfirming] = useState(false);

  const inherited = sk.scope.kind === "profile";
  // Promote resolves the profile from the VANTAGE space server-side; the confirm names the same one.
  // For an inherited row the name comes from the row's own defining profile instead.
  const profileId = sk.scope.kind === "profile" ? sk.scope.profileId : space?.profileId;
  const profileName = profiles.find((p) => p.id === profileId)?.name ?? "profile";

  return (
    <li className="settings-row" data-invalid={!sk.valid || undefined}>
      <div className="settings-row-main">
        <span className="settings-row-name">{sk.name}</span>
        {sk.valid
          ? <span className="settings-row-desc">{sk.description}</span>
          : <span className="settings-row-problem"><Icon name="alert" size={12} /> {sk.reason}</span>}
      </div>
      {/* Movement only for valid rows: moving a broken skill between scopes would dignify a row that
          no agent will ever see. Invalid rows keep exactly what they had — the reason line. */}
      {sk.valid && !confirming && (
        <button type="button" className="btn-quiet scope-move" onClick={() => setConfirming(true)}>
          {inherited ? "Move to this space…" : "Move to profile…"}
        </button>
      )}
      {/* Invalid skills carry no toggle: they are never handed to an agent whatever the flag says, and
          a switch that does nothing would claim otherwise. */}
      {sk.valid && (
        <input type="checkbox" role="switch" className="switch" aria-label={`Skill ${sk.name} in this space`}
          title={inherited ? `Defined in ${profileName} — this switch is this space's override.` : undefined}
          checked={sk.enabled} onChange={(e) => run(() => setSkillEnabled(spaceId, sk.id, e.target.checked))} />
      )}
      {confirming && (
        <MoveScopeConfirm direction={inherited ? "demote" : "promote"} name={sk.name} profileName={profileName}
          onCancel={() => setConfirming(false)}
          onConfirm={() => { setConfirming(false); run(() => (inherited ? demoteSkill : promoteSkill)(spaceId, sk.id)); }} />
      )}
    </li>
  );
}
