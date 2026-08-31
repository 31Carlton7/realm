import { AGENT_META, SELECTABLE_AGENT_KINDS, skillSupportNote } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect } from "react";
import { useApp } from "../../state/store";

/**
 * The skills tab of the space-settings sheet (W5): Realm's library with THIS space's toggles.
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
  const setSkillEnabled = useApp((s) => s.setSkillEnabled);
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
          <ul className="settings-list">
            {skills.map((sk) => (
              <li key={sk.id} className="settings-row" data-invalid={!sk.valid || undefined}>
                <div className="settings-row-main">
                  <span className="settings-row-name">{sk.name}</span>
                  {sk.valid
                    ? <span className="settings-row-desc">{sk.description}</span>
                    : <span className="settings-row-problem"><Icon name="alert" size={12} /> {sk.reason}</span>}
                </div>
                {/* Invalid skills carry no toggle: they are never handed to an agent whatever the flag
                    says, and a switch that does nothing would claim otherwise. */}
                {sk.valid && (
                  <input type="checkbox" role="switch" className="switch" aria-label={`Skill ${sk.name} in this space`}
                    checked={sk.enabled} onChange={(e) => run(() => setSkillEnabled(spaceId, sk.id, e.target.checked))} />
                )}
              </li>
            ))}
          </ul>
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
