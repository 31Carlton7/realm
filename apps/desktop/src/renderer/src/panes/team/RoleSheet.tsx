import { Icon, parseRealmiteSpec, realmiteFromSeed, randomSeed, type RealmiteSpec } from "@realm/ui";
import { useEffect, useMemo, useState } from "react";
import { CustomRoleSchema, teamShares, TEAM_DEFAULTS, type CustomRoleInput, type TeamRole, type TeamSpace } from "@realm/contracts";
import { RealmiteMaker } from "../../components/RealmiteMaker";
import { Sheet } from "../../components/Sheet";
import { useApp } from "../../state/store";
import { invalidIssues, plainError, roleFieldErrors, sharesNote, wakeSentence, type RoleFieldErrors } from "./team-format";

export const MODELS: { id: string; label: string }[] = [
  { id: "sonnet", label: "Sonnet" }, { id: "opus", label: "Opus" }, { id: "haiku", label: "Haiku" },
];
export const modelLabel = (m: string | null) => MODELS.find((x) => x.id === m)?.label ?? m ?? "The agent's default";

/** How far a role may go without asking, in the words its page uses. Never bypass: a role's run is
 *  unattended, and RunConstraints refuses it. */
export const MODES: { id: TeamRole["permissionMode"]; label: string }[] = [
  { id: "default", label: "Asks before it acts" }, { id: "acceptEdits", label: "May edit files" }, { id: "plan", label: "Only plans" },
];

// Each named as the role's card names it, so the option picked reads the same once it is the setting.
const CADENCES: { cron: string | null; label: string }[] = ["0 9 * * 1-5", "0 9 * * 1,4", "0 9 * * *", "0 8 * * 1", null]
  .map((cron) => ({ cron, label: wakeSentence(cron) }));

/**
 * A teammate's sheet: its name and Realmite (shuffle and customise), what it does, what it runs on,
 * how far it may go, when it wakes, its share of the team's week and its skills.
 *
 * Four uses, one sheet: editing a role; duplicating one (a new role, its fields copied and a Realmite
 * of its own); writing one from scratch, made at once on a team that exists; and writing one while
 * the team is being chosen, where Save hands the teammate back to the picker (`onDraft`) and nothing
 * is made until the team is. The shares line counts what the team would come to WITH this teammate,
 * the same sum the server holds the team to.
 */
export function RoleSheet({ spaceId, team, role, copyOf, draft, onDraft, otherShares, cap, onClose, onMade }: {
  spaceId: string;
  team?: TeamSpace | undefined;
  /** Edit this role. */
  role?: TeamRole | undefined;
  /** A new role, starting from this one's fields. */
  copyOf?: TeamRole | undefined;
  /** A teammate written earlier in the picker, to change. */
  draft?: CustomRoleInput | undefined;
  /** Picker mode: hand the teammate back instead of making it. */
  onDraft?: ((r: CustomRoleInput) => void) | undefined;
  /** Picker mode: the shares of everything else chosen, and the week they are held to. */
  otherShares?: number | undefined;
  cap?: number | undefined;
  onClose: () => void;
  onMade?: ((role: TeamRole) => void) | undefined;
}) {
  const createRole = useApp((s) => s.createRole);
  const updateRole = useApp((s) => s.updateRole);
  const skillsOf = useApp((s) => s.spaceSkills[spaceId]);
  const refreshSkills = useApp((s) => s.refreshSkills);
  const run = useApp((s) => s.run);
  useEffect(() => { if (!skillsOf) run(() => refreshSkills(spaceId)); }, [skillsOf, spaceId, refreshSkills, run]);
  const from = role ?? copyOf;
  const takenNames = new Set((team?.roles ?? []).map((r) => r.name.toLowerCase()));
  const copyName = (n: string) => { let i = 2; while (takenNames.has(`${n} ${i}`.toLowerCase())) i++; return `${n} ${i}`; };
  const [name, setName] = useState(draft?.name ?? (copyOf ? copyName(copyOf.name) : role?.name ?? ""));
  const [brief, setBrief] = useState(draft?.brief ?? from?.brief ?? "");
  const [spec, setSpec] = useState<RealmiteSpec>(() =>
    draft ? parseRealmiteSpec(draft.realmite, draft.name) : role ? parseRealmiteSpec(role.realmite, role.id) : realmiteFromSeed(randomSeed()));
  const [model, setModel] = useState(draft?.model ?? from?.model ?? "sonnet");
  const [mode, setMode] = useState<TeamRole["permissionMode"]>(draft?.permissionMode ?? from?.permissionMode ?? "default");
  const [cron, setCron] = useState<string | null>(draft ? draft.cron ?? null : from ? from.cron : null);
  const [budget, setBudget] = useState(() => {
    const v = draft ? draft.weekBudgetUsd : from?.weekBudgetUsd;
    return v != null ? String(v) : "10";
  });
  const [skills, setSkills] = useState<string[]>(draft?.skills ?? from?.skills ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<RoleFieldErrors>({});
  const cadences = useMemo(() => (cron && !CADENCES.some((c) => c.cron === cron) ? [...CADENCES, { cron, label: wakeSentence(cron) }] : CADENCES), [cron]);
  const offered = (skillsOf ?? []).filter((s) => s.enabled && s.valid && !skills.includes(s.id));
  const weekBudgetUsd = budget.trim() === "" ? null : Number(budget);
  const week = cap ?? team?.weekBudgetUsd ?? TEAM_DEFAULTS.teamWeekBudgetUsd;
  // What the team's shares come to with this teammate as written: the others as they stand, this one replaced or added.
  const shares = onDraft
    ? (otherShares ?? 0) + (weekBudgetUsd ?? 0)
    : role ? teamShares(team?.roles ?? [], { replace: { id: role.id, weekBudgetUsd } }) : teamShares(team?.roles ?? [], { add: [weekBudgetUsd] });
  const note = sharesNote(Number.isFinite(shares) ? shares : 0, week);
  // Checked here against the schema the server holds it to, and said under the field it is about —
  // never the validator's JSON, and never a button greyed with no reason given.
  const submit = () => {
    const fields: CustomRoleInput = {
      name: name.trim(), brief, realmite: spec as unknown as Record<string, unknown>, model, permissionMode: mode, cron, weekBudgetUsd, skills,
      ...(copyOf?.template ? { template: copyOf.template } : {}),
    };
    const checked = CustomRoleSchema.safeParse(fields);
    if (!checked.success) { setFieldErrors(roleFieldErrors(checked.error.issues)); return; }
    setFieldErrors({});
    if (onDraft) { onDraft(fields); return; }
    setBusy(true); setError(null);
    run(async () => {
      try {
        if (role) {
          await updateRole({ id: role.id, ...fields });
          onClose();
        } else {
          const made = await createRole({ spaceId, ...fields });
          onClose();
          onMade?.(made);
        }
      } catch (e) {
        const issues = invalidIssues(e);
        if (issues && Object.keys(roleFieldErrors(issues)).length > 0) setFieldErrors(roleFieldErrors(issues));
        else setError(plainError(e));
      } finally { setBusy(false); }
    });
  };
  // Kept out of the field's NAME (aria-hidden inside its label) and given to it as its description.
  const said = (field: string) => fieldErrors[field]
    ? <span className="tp-field-error" id={`tp-err-${field}`} aria-hidden="true">{fieldErrors[field]}</span> : null;
  const invalid = (field: string) => (fieldErrors[field] ? { "aria-invalid": true, "aria-describedby": `tp-err-${field}` } : {});
  const title = role ? `Edit ${role.name}` : copyOf ? `Duplicate ${copyOf.name}` : "Custom teammate";
  const verb = role ? "Save" : onDraft ? (draft ? "Save" : "Add to the team") : copyOf ? "Make the copy" : "Add to the team";
  return (
    <Sheet title={title} onClose={onClose} width={720}
      footer={<>
        {error && <span className="tp-sheet-error" role="alert">{error}</span>}
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={busy} onClick={submit}>{verb}</button>
      </>}>
      <form className="form tp-role-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Podcast Booker" maxLength={60} autoFocus={!role} {...invalid("name")} />{said("name")}</label>
        <div className="field"><span>Realmite</span><RealmiteMaker spec={spec} onChange={setSpec} name={name.trim() || undefined} />{said("realmite")}</div>
        <label className="field"><span>What they do</span>
          <textarea rows={6} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="What this teammate does, for whom, and what it must never do. It delivers to Review; it never sends or posts." {...invalid("brief")} />
          {said("brief")}
        </label>
        <div className="tp-form-row">
          <label className="field"><span>Model</span>
            <select value={model ?? ""} onChange={(e) => setModel(e.target.value)}>
              {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              {from?.model && !MODELS.some((m) => m.id === from.model) && <option value={from.model}>{from.model}</option>}
            </select>
            {said("model")}
          </label>
          <label className="field"><span>Mode</span>
            <select value={mode} onChange={(e) => setMode(e.target.value as TeamRole["permissionMode"])} title="A teammate's runs are unattended, so it never has full access">
              {MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
            {said("permissionMode")}
          </label>
          <label className="field"><span>Wakes</span>
            <select value={cron ?? ""} onChange={(e) => setCron(e.target.value || null)}>
              {cadences.map((c) => <option key={c.cron ?? "none"} value={c.cron ?? ""}>{c.label}</option>)}
            </select>
            {said("cron")}
          </label>
        </div>
        <div className="tp-form-row tp-form-row-2">
          <label className="field"><span>A week, at most ($)</span>
            <input inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^\d.]/g, ""))} aria-describedby={fieldErrors.weekBudgetUsd ? "tp-err-weekBudgetUsd" : "tp-budget-note"} aria-invalid={!!fieldErrors.weekBudgetUsd || undefined} />
            {said("weekBudgetUsd")}
          </label>
          <div className="field"><span>Skills</span>
            <div className="tp-skills">
              {skills.map((id) => (
                <span key={id} className="tp-chip tp-skill">
                  {id}
                  <button type="button" className="tp-skill-x" aria-label={`Remove the ${id} skill`} title={`Remove the ${id} skill`} onClick={() => setSkills((xs) => xs.filter((x) => x !== id))}><Icon name="close" size={12} /></button>
                </span>
              ))}
              <select className="tp-skill-add" value="" aria-label="Add a skill" disabled={offered.length === 0}
                onChange={(e) => { const v = e.target.value; if (v) setSkills((xs) => [...xs, v]); }}>
                <option value="">{offered.length === 0 ? (skillsOf ? "No more skills in this space" : "Loading skills…") : "Add a skill…"}</option>
                {offered.map((s) => <option key={s.id} value={s.id} title={s.description}>{s.name}</option>)}
              </select>
            </div>
            {said("skills")}
          </div>
        </div>
        <p className="tp-shares-line" id="tp-budget-note" data-over={note.over || undefined}>
          <span className="t-num">{note.text}</span>
          <span className="tp-meter tp-meter-wide" data-high={note.over || undefined} aria-hidden="true"><i style={{ width: `${note.pct}%` }} /></span>
        </p>
        <p className="tp-make-note">Each run stops at {`$${TEAM_DEFAULTS.runCapUsd}`} or {TEAM_DEFAULTS.runCapMs / 60_000} minutes. What it makes comes to Review; nothing leaves Realm without your yes.</p>
      </form>
    </Sheet>
  );
}
