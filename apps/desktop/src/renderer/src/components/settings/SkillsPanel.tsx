import { AGENT_META, SELECTABLE_AGENT_KINDS, skillSupportNote, type Skill } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useState } from "react";
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
  const root = useApp((s) => s.skillsRoot);
  const refreshSkills = useApp((s) => s.refreshSkills);
  const run = useApp((s) => s.run);
  useEffect(() => { run(() => refreshSkills(spaceId)); }, [spaceId, refreshSkills, run]);

  return (
    <div className="form settings-panel">
      {/* Disclosure #1 — beside the toggles, always visible, whether or not anything is enabled yet. */}
      <p className="settings-note">
        Enabling any skill here isolates this space's Claude sessions from your own installed skills —
        they run with Realm's library only. Your <code>CLAUDE.md</code> files are re-injected by Realm to compensate.
      </p>
      <div className="field">
        <span>Skills in this space</span>
        {!skills ? <p className="env-empty">Loading…</p> : skills.length === 0 ? (
          <p className="env-empty">No skills yet. Drop a folder containing a SKILL.md into <code className="env-path">{root}</code>.</p>
        ) : (
          // W4: the shared scope grouping — "This space" / "From <profile>" / "Everywhere" — over the
          // same rows this list always held.
          <ScopeGroups entries={skills.map((sk) => ({ key: sk.id, scope: sk.scope, row: <SkillRow key={sk.id} spaceId={spaceId} skill={sk} /> }))} />
        )}
        {skills && skills.length > 0 && (
          <p className="settings-hint">New skills are on by default. Library: <code className="env-path">{root}</code></p>
        )}
      </div>
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
