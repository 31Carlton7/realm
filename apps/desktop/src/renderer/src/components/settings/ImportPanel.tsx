import {
  AGENT_META, IMPORTED_SPACE_NAME,
  type ImportMemoryCandidate, type ImportResult, type ImportScan, type ImportSessionCandidate, type ImportSkillCandidate,
} from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useMemo, useState } from "react";
import { useApp } from "../../state/store";

/**
 * The Import tab (Settings) — bringing the agent CLIs' own history into Realm.
 *
 * The panel's whole job is to make `apply` an informed decision rather than a leap:
 *
 * - It scans on mount, because a scan writes nothing. Nothing is created until "Import" is pressed.
 * - Every row shows the space it would go to AND why (`match.evidence`), so a wrong guess is visible
 *   as wrong instead of merely surprising.
 * - Destinations are editable, per row and per group, and what the user settles on is what goes on
 *   the wire — the server does not re-match.
 * - The rows the default filter hides are COUNTED in a line that offers to show them. A preview that
 *   silently dropped two thirds of what it found would be the same lie as an import that did.
 *
 * Re-targeting matters more than it looks: `sessions.moveToSpace` refuses once a session has
 * persisted events, and an imported session has a whole transcript from the moment it exists. This
 * preview is therefore the ONLY chance to place one — which is why the destination select is here
 * and not only in the sidebar afterwards.
 */

/** A destination the user can pick: a real space, or a profile's catch-all (created on import). */
type Target = { spaceId: string | null; profileId: string | null };
const targetKey = (t: Target): string => `${t.spaceId ?? ""}|${t.profileId ?? ""}`;
/** The scan's proposal, as a destination. `fallbackProfileId` is the match's word for "no space fits,
 *  but this profile does" — the same thing `apply` reads as `profileId`, renamed here so the two
 *  never get confused at a call site. */
const matchTarget = (m: { spaceId: string | null; fallbackProfileId: string | null }): Target =>
  ({ spaceId: m.spaceId, profileId: m.fallbackProfileId });

export function ImportPanel() {
  const run = useApp((s) => s.run);
  const importScan = useApp((s) => s.importScan);
  const importApply = useApp((s) => s.importApply);
  const spaces = useApp((s) => s.spaces);
  const profiles = useApp((s) => s.profiles);

  const [scan, setScan] = useState<ImportScan | null>(null);
  const [scanning, setScanning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  /** Per-key overrides of the scan's proposed destination, and of the default selection. Keyed by the
   *  candidate key, which is stable across re-scans — so a re-scan keeps the user's edits. */
  const [targets, setTargets] = useState<Record<string, Target>>({});
  const [deselected, setDeselected] = useState<Record<string, true>>({});

  const rescan = useMemo(() => async () => {
    setScanning(true);
    try { setScan(await importScan()); } finally { setScanning(false); }
  }, [importScan]);
  useEffect(() => { run(rescan); }, [run, rescan]);

  /** The rows the default filter hides: Realm's own transcripts (already rows in this database),
   *  scratch directories, and anything a previous import already brought in — sessions AND skills, so
   *  the count below accounts for everything the filter took out. Counted, never silent. */
  const hiddenSession = (s: { scratch: boolean; fromRealm: boolean; imported: boolean; duplicate: boolean }) =>
    s.scratch || s.fromRealm || s.imported || s.duplicate;
  const hidden = (scan?.sessions ?? []).filter(hiddenSession).length
    + (scan?.skills ?? []).filter((s) => s.imported).length;
  const sessions = (scan?.sessions ?? []).filter((s) => showHidden || !hiddenSession(s));
  // Memory folders are never filtered: there are a handful of them, an already-imported one is worth
  // seeing (re-importing refreshes its copies), and hiding it would leave the section looking empty.
  const memories = scan?.memories ?? [];
  const skills = (scan?.skills ?? []).filter((s) => showHidden || !s.imported);

  const targetOf = (key: string, fallback: Target): Target => targets[key] ?? fallback;
  const selected = (c: { key: string; imported: boolean }): boolean => !deselected[c.key] && !c.imported;
  const toggle = (key: string, on: boolean) =>
    setDeselected((d) => { const next = { ...d }; if (on) delete next[key]; else next[key] = true; return next; });

  const chosenSessions = sessions.filter(selected);
  const chosenMemories = memories.filter(selected);
  const chosenSkills = skills.filter(selected);
  const nothingChosen = chosenSessions.length + chosenMemories.length + chosenSkills.length === 0;

  const apply = async () => {
    setApplying(true);
    try {
      const r = await importApply({
        sessions: chosenSessions.map((c) => ({ key: c.key, ...targetOf(c.key, matchTarget(c.match)) })),
        memories: chosenMemories.map((c) => ({ key: c.key, ...targetOf(c.key, matchTarget(c.match)) })),
        skills: chosenSkills.map((c) => c.key),
      });
      setResult(r);
      // Re-scan so every imported row now reads `imported: true` rather than offering itself again.
      await rescan();
    } finally { setApplying(false); }
  };

  const targetLabel = (t: Target): string => {
    const space = t.spaceId ? spaces.find((s) => s.id === t.spaceId) : null;
    if (space) return space.name;
    const profile = t.profileId ? profiles.find((p) => p.id === t.profileId) : null;
    return profile ? `${profile.name} › ${IMPORTED_SPACE_NAME}` : "No destination";
  };

  return (
    <div className="form settings-panel import-panel">
      <p className="settings-note">
        Realm reads <code>~/.claude</code>, <code>~/.codex</code> and <code>~/.cursor</code> and never writes to them.
        Nothing is created until you press Import — scanning only looks.
      </p>

      <div className="field">
        <div className="engines-head">
          <span>Sources</span>
          <button type="button" className="btn" disabled={scanning || applying} onClick={() => run(rescan)}>
            {scanning ? "Scanning…" : "Re-scan"}
          </button>
        </div>
        {!scan ? <p className="env-empty">Scanning the agent CLIs…</p> : (
          <ul className="page-list import-sources">
            {scan.sources.map((s) => (
              <li key={s.source} className="import-source-row">
                <Icon name={s.available ? "checkCircle" : "errorCircle"} size={14} />
                <strong>{s.source}</strong>
                <code className="env-path">{s.root}</code>
                <span className="muted">
                  {!s.available ? "not installed" : `${s.sessions} session${s.sessions === 1 ? "" : "s"}`}
                  {s.unreadable > 0 && ` · ${s.unreadable} unreadable`}
                </span>
                {s.note && <span className="settings-hint import-source-note">{s.note}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {scan && (
        <>
          {hidden > 0 && (
            <p className="settings-hint">
              {hidden} row{hidden === 1 ? " is" : "s are"} hidden: Realm's own sessions, scratch directories, older
              copies of a resumed conversation, and anything already imported.{" "}
              <button type="button" className="btn-quiet" onClick={() => setShowHidden((v) => !v)}>
                {showHidden ? "Hide them again" : "Show them anyway"}
              </button>
            </p>
          )}

          <SessionSection
            sessions={sessions} targetOf={targetOf} setTargets={setTargets} targetLabel={targetLabel}
            selected={selected} toggle={toggle} spaces={spaces} profiles={profiles}
          />

          <MemorySection
            memories={memories} targetOf={targetOf} setTargets={setTargets} targetLabel={targetLabel}
            selected={selected} toggle={toggle} spaces={spaces} profiles={profiles}
          />

          <SkillSection skills={skills} selected={selected} toggle={toggle} />

          <div className="field import-actions">
            <button type="button" className="btn primary" disabled={applying || scanning || nothingChosen} onClick={() => run(apply)}>
              {applying ? "Importing…" : nothingChosen ? "Nothing selected" : `Import ${summary(chosenSessions.length, chosenMemories.length, chosenSkills.length)}`}
            </button>
          </div>

          {result && <ResultSummary result={result} targetLabel={targetLabel} />}
        </>
      )}
    </div>
  );
}

function summary(sessions: number, memories: number, skills: number): string {
  const parts: string[] = [];
  if (sessions) parts.push(`${sessions} session${sessions === 1 ? "" : "s"}`);
  if (memories) parts.push(`${memories} memory folder${memories === 1 ? "" : "s"}`);
  if (skills) parts.push(`${skills} skill${skills === 1 ? "" : "s"}`);
  return parts.join(", ");
}

type SectionProps<T> = {
  targetOf: (key: string, fallback: Target) => Target;
  setTargets: React.Dispatch<React.SetStateAction<Record<string, Target>>>;
  targetLabel: (t: Target) => string;
  selected: (c: { key: string; imported: boolean }) => boolean;
  toggle: (key: string, on: boolean) => void;
  spaces: { id: string; name: string; profileId: string }[];
  profiles: { id: string; name: string }[];
  items?: T[];
};

/**
 * Sessions, GROUPED BY DESTINATION rather than listed flat.
 *
 * With 290 candidates and one over-broad catch-all, a flat list is unreviewable and a per-row
 * destination select is 290 decisions. Grouping turns the common correction — "all 161 of these
 * belong in a space of their own" — into one action on the group header.
 */
function SessionSection({ sessions, targetOf, setTargets, targetLabel, selected, toggle, spaces, profiles }:
  SectionProps<never> & { sessions: ImportSessionCandidate[] }) {
  const groups = useMemo(() => {
    const map = new Map<string, { target: Target; rows: ImportSessionCandidate[] }>();
    for (const s of sessions) {
      const t = targetOf(s.key, matchTarget(s.match));
      const k = targetKey(t);
      const g = map.get(k) ?? { target: t, rows: [] };
      g.rows.push(s);
      map.set(k, g);
    }
    return [...map.values()].sort((a, b) => b.rows.length - a.rows.length);
  }, [sessions, targetOf]);

  if (sessions.length === 0) return <div className="field"><span>Sessions</span><p className="env-empty">No transcripts to import.</p></div>;

  return (
    <div className="field">
      <span>Sessions ({sessions.length})</span>
      {groups.map((g) => (
        <details key={targetKey(g.target)} className="import-group" open={groups.length <= 2}>
          <summary>
            <strong>{targetLabel(g.target)}</strong>
            <span className="muted">{g.rows.length} session{g.rows.length === 1 ? "" : "s"}</span>
            <TargetSelect
              value={g.target} spaces={spaces} profiles={profiles}
              // Re-targeting a GROUP moves every row currently in it — the bulk correction this
              // grouping exists for.
              onChange={(t) => setTargets((prev) => {
                const next = { ...prev };
                for (const r of g.rows) next[r.key] = t;
                return next;
              })}
            />
          </summary>
          <ul className="page-list import-rows">
            {g.rows.map((s) => (
              <li key={s.key} className="import-row" data-off={!selected(s) || undefined}>
                <label className="import-row-check">
                  <input type="checkbox" checked={selected(s)} disabled={s.imported} onChange={(e) => toggle(s.key, e.target.checked)} />
                </label>
                <Icon name={AGENT_META[s.agentKind].icon} size={14} colored />
                <span className="import-row-title" title={s.path}>{s.title}</span>
                <span className="muted import-row-meta">
                  {new Date(s.updatedAt).toISOString().slice(0, 10)} · {s.messages} msg
                  {/* The one fact that changes what an imported session IS. */}
                  {s.cwdExists ? " · resumable" : " · archive (folder is gone)"}
                  {s.imported && " · already imported"}
                  {s.fromRealm && " · Realm's own"}
                  {s.scratch && " · scratch"}
                  {s.duplicate && " · older copy of this conversation"}
                </span>
                <span className="muted import-row-why" title={s.match.evidence ?? ""}>{s.match.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}

function MemorySection({ memories, targetOf, setTargets, targetLabel, selected, toggle, spaces, profiles }:
  SectionProps<never> & { memories: ImportMemoryCandidate[] }) {
  if (memories.length === 0) return null;
  return (
    <div className="field">
      <span>Memory ({memories.length} folder{memories.length === 1 ? "" : "s"})</span>
      {/* The design decision, stated where the user is deciding: the facts are COPIED as files and
          the index goes into the space's memory doc, because the largest of these folders is many
          times the doc cap and inlining would silently drop most of it. */}
      <p className="settings-hint">
        Fact files are copied under Realm's home and the index goes into each space's memory document —
        nothing is truncated to fit.
      </p>
      <ul className="page-list import-rows">
        {memories.map((m) => (
          <li key={m.key} className="import-row" data-off={!selected(m) || undefined}>
            <label className="import-row-check">
              <input type="checkbox" checked={selected(m)} onChange={(e) => toggle(m.key, e.target.checked)} />
            </label>
            <span className="import-row-title" title={m.path}>{m.cwd || m.path}</span>
            <span className="muted import-row-meta">
              {m.files} file{m.files === 1 ? "" : "s"} · {Math.round(m.bytes / 1024)} kB
              {m.imported && " · already imported"}
            </span>
            <TargetSelect value={targetOf(m.key, matchTarget(m.match))} spaces={spaces} profiles={profiles}
              onChange={(t) => setTargets((prev) => ({ ...prev, [m.key]: t }))} />
            <span className="muted import-row-why" title={m.match.evidence ?? ""}>{m.match.reason}</span>
          </li>
        ))}
      </ul>
      <p className="settings-hint">Destinations: {memories.map((m) => targetLabel(targetOf(m.key, matchTarget(m.match)))).filter((v, i, a) => a.indexOf(v) === i).join(", ")}</p>
    </div>
  );
}

function SkillSection({ skills, selected, toggle }: {
  skills: ImportSkillCandidate[];
  selected: (c: { key: string; imported: boolean }) => boolean;
  toggle: (key: string, on: boolean) => void;
}) {
  if (skills.length === 0) return null;
  return (
    <div className="field">
      <span>Skills ({skills.length})</span>
      {/* Both halves of what importing a skill means, said once: it is a copy (so the CLI's folder is
          untouched and later edits do not travel), and it lands unscoped (so every space sees it). */}
      <p className="settings-hint">
        Copied into <code>~/Realm/skills</code> and visible in every space. The agents' own folders are left as they are,
        and a library entry you have already edited is never overwritten.
      </p>
      <ul className="page-list import-rows">
        {skills.map((s) => (
          <li key={s.key} className="import-row" data-off={!selected(s) || undefined}>
            <label className="import-row-check">
              <input type="checkbox" checked={selected(s)} disabled={s.imported} onChange={(e) => toggle(s.key, e.target.checked)} />
            </label>
            <span className="import-row-title" title={s.path}>{s.key}</span>
            <span className="muted import-row-meta">{s.origins.join(", ")}{s.imported && " · already in the library"}</span>
            <span className="muted import-row-desc">{s.description}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Every space, grouped under its profile, plus one "<profile> › Imported" entry per profile — the
 *  catch-all, offered explicitly so choosing it is a decision rather than something that happens to
 *  rows nobody looked at. */
function TargetSelect({ value, spaces, profiles, onChange }: {
  value: Target;
  spaces: { id: string; name: string; profileId: string }[];
  profiles: { id: string; name: string }[];
  onChange: (t: Target) => void;
}) {
  return (
    <select
      className="import-target"
      value={value.spaceId ? `s:${value.spaceId}` : value.profileId ? `p:${value.profileId}` : ""}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v.startsWith("s:") ? { spaceId: v.slice(2), profileId: null }
          : v.startsWith("p:") ? { spaceId: null, profileId: v.slice(2) }
            : { spaceId: null, profileId: null });
      }}
    >
      <option value="">No destination — skip</option>
      {profiles.map((p) => (
        <optgroup key={p.id} label={p.name}>
          {spaces.filter((s) => s.profileId === p.id).map((s) => <option key={s.id} value={`s:${s.id}`}>{s.name}</option>)}
          <option value={`p:${p.id}`}>{IMPORTED_SPACE_NAME} (new)</option>
        </optgroup>
      ))}
    </select>
  );
}

/** What actually happened, per kind — including the skips, with their reasons. An import that
 *  reported only its successes would leave the user to discover the rest by noticing an absence. */
function ResultSummary({ result, targetLabel }: { result: ImportResult; targetLabel: (t: Target) => string }) {
  const counts = (rows: ImportResult["sessions"]) => ({
    imported: rows.filter((r) => r.state === "imported").length,
    skipped: rows.filter((r) => r.state === "skipped").length,
    failed: rows.filter((r) => r.state === "failed").length,
  });
  const s = counts(result.sessions), m = counts(result.memories), k = counts(result.skills);
  const problems = [...result.sessions, ...result.memories, ...result.skills].filter((r) => r.state === "failed");
  return (
    <div className="field import-result">
      <span>Last import</span>
      <ul className="settings-list">
        <li>{s.imported} sessions imported{s.skipped > 0 && `, ${s.skipped} skipped`}{s.failed > 0 && `, ${s.failed} failed`}</li>
        <li>{m.imported} memory folders imported{m.skipped > 0 && `, ${m.skipped} skipped`}{m.failed > 0 && `, ${m.failed} failed`}</li>
        <li>{k.imported} skills imported{k.skipped > 0 && `, ${k.skipped} skipped`}{k.failed > 0 && `, ${k.failed} failed`}</li>
        {result.spacesCreated.map((sp) => (
          <li key={sp.id}>Created the space {targetLabel({ spaceId: sp.id, profileId: null })}</li>
        ))}
      </ul>
      {problems.length > 0 && (
        <ul className="settings-list import-problems">
          {problems.slice(0, 10).map((p) => <li key={p.key}><code className="env-path">{p.key}</code> — {p.detail}</li>)}
        </ul>
      )}
    </div>
  );
}
