import { PERMISSION_MODES, TEAMMATE_CLOCK_PROMPT, TEAMMATE_COLORS, TEAMMATE_SHAPES, teammateIconFromSeed, type AgentKind, type Teammate, type TeammateIcon as IconSpec, type TeammatePermissionMode } from "@realm/contracts";
import { Icon, TEAMMATE_PALETTE, TEAMMATE_SHAPE_LABELS, TeammateIcon, teammateFill } from "@realm/ui";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { FALLBACK_AGENT, useApp } from "../../state/store";
import { Sheet } from "../../components/Sheet";
import { Spinner } from "../../components/Spinner";
import { useRadioKeys } from "../../components/space-fields";
import { useFileDrop } from "../../components/use-file-drop";
import { useRunCatalog } from "../schedules/ScheduleRunPicker";
import { WhenRows } from "../schedules/ScheduleWhen";
import { blankWhen, exprOf, firstRun, whenOf, whenPhrase, type When } from "../schedules/schedule-model";
import { ModelPicker } from "../session/ModelPicker";
import type { EffortControl } from "../session/model-catalog";
import { permissionMark } from "../session/Composer";
import { QUICK_STARTS, type QuickStart } from "./quick-starts";

/** What the sheet edits: everything a teammate is that the person chooses. */
type Fields = {
  name: string; brief: string; icon: IconSpec; agentKind: AgentKind; model: string | null; effort: string | null;
  permissionMode: TeammatePermissionMode; folder: string | null; lead: boolean; group: string;
};

/** Its clock: whether it checks in on its own, when, and what it is told then. */
type Clock = { on: boolean; when: When; prompt: string };

function clockOf(t: Teammate | undefined): Clock {
  const s = t?.schedule;
  return { on: !!s?.enabled, when: s ? { ...whenOf(s.cron), repeat: true } : blankWhen(), prompt: s?.prompt ?? TEAMMATE_CLOCK_PROMPT };
}

/** The three rungs the prompter's permission control offers. Plan and Ask are ways of working a
 *  session is switched into, not how freely a teammate may act. */
const MODES = PERMISSION_MODES.map((m) => m.id);

function fieldsOf(t: Teammate, spaceFolder: string | undefined): Fields {
  return {
    name: t.name, brief: t.brief, icon: t.icon, agentKind: t.agentKind, model: t.model, effort: t.effort,
    permissionMode: t.permissionMode, folder: t.folder === spaceFolder ? null : t.folder, lead: t.lead, group: t.group ?? "",
  };
}

/**
 * New teammate, and the same sheet to edit one: who it is, what it does, how it looks, what it runs
 * on and where. Every field but the name has a working default — the space's folder, the agent last
 * used and its default model, the permission new sessions start in, an icon rolled for it — so a name
 * and Return is the whole of making one. Creating lands in its chat, prompter focused; editing saves
 * in place.
 *
 * The icon is made the way Grok's bot maker makes one: the big preview, then the eight shapes drawn
 * in the colour chosen, then the twelve colours. Quick starts fill a name, a brief and an icon in
 * one click, and every word of the brief stays the person's to change.
 */
export function TeammateSheet({ spaceId, id }: { spaceId: string; id?: string }) {
  const space = useApp((s) => s.spaces.find((sp) => sp.id === spaceId));
  const editing = useApp((s) => (id ? s.teammates[spaceId]?.find((t) => t.id === id) : undefined));
  const spaceTeammates = useApp((s) => s.teammates[spaceId]);
  const groups = useMemo(() => [...new Set((spaceTeammates ?? []).map((t) => t.group).filter((g): g is string => !!g))], [spaceTeammates]);
  const lastAgent = useApp((s) => s.lastAgentKind ?? FALLBACK_AGENT);
  const lastModel = useApp((s) => s.lastModels[s.lastAgentKind ?? FALLBACK_AGENT] ?? null);
  const defaultMode = useApp((s) => s.settingsPrefs?.defaultPermissionMode);
  // While the space has a Team access, a new teammate is made on it whatever the sheet sends.
  const spaceMode = useApp((s) => (id ? null : s.teamAccess[spaceId]?.mode ?? null));
  const loadTeamAccess = useApp((s) => s.loadTeamAccess);
  const refreshSettingsPrefs = useApp((s) => s.refreshSettingsPrefs);
  const createTeammate = useApp((s) => s.createTeammate);
  const updateTeammate = useApp((s) => s.updateTeammate);
  const openTeammate = useApp((s) => s.openTeammate);
  const closeSheet = useApp((s) => s.closeSheet);
  const run = useApp((s) => s.run);
  const [f, setF] = useState<Fields>(() => editing ? fieldsOf(editing, space?.folderPath) : {
    name: "", brief: "", icon: teammateIconFromSeed(crypto.randomUUID()), agentKind: lastAgent, model: lastModel, effort: null,
    permissionMode: "default", folder: null, lead: false, group: "",
  });
  const [modeTouched, setModeTouched] = useState(!!editing);
  const [clock, setClock] = useState<Clock>(() => clockOf(editing));
  const nextCheckIn = clock.on ? firstRun(clock.when) : null;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const ids = useId();
  const put = (patch: Partial<Fields>) => setF((v) => ({ ...v, ...patch }));
  useEffect(() => { nameRef.current?.focus(); }, []);
  useEffect(() => { run(() => refreshSettingsPrefs()); }, [run, refreshSettingsPrefs]);
  useEffect(() => { if (!id) run(() => loadTeamAccess(spaceId)); }, [run, loadTeamAccess, spaceId, id]);
  // The space's Team access, else the permission new sessions start in, once it is known, unless the
  // person has chosen already.
  const startMode = spaceMode ?? defaultMode;
  const shownMode: TeammatePermissionMode = modeTouched || !startMode ? f.permissionMode
    : (MODES as readonly string[]).includes(startMode) ? startMode as TeammatePermissionMode : "default";

  const quickStart = (q: QuickStart) => setF((v) => ({
    ...v, brief: q.brief, icon: q.icon, lead: !!q.lead,
    // A name the person typed stays; one a quick start filled is replaced by the next.
    name: v.name.trim() === "" || QUICK_STARTS.some((o) => o.name === v.name) ? q.name : v.name,
  }));

  const ready = f.name.trim() !== "" && (!clock.on || nextCheckIn !== null);
  const submit = () => {
    if (!ready || busy) return;
    setBusy(true); setFailure(null);
    const body = {
      name: f.name.trim(), brief: f.brief, icon: f.icon, agentKind: f.agentKind, model: f.model, effort: f.effort,
      permissionMode: shownMode, folder: f.folder, lead: f.lead, group: f.group.trim() || null,
      // Off keeps a clock it had, paused, so turning it back on finds its cadence where it was.
      ...(clock.on ? { schedule: { cron: exprOf(clock.when)!, prompt: clock.prompt.trim() || TEAMMATE_CLOCK_PROMPT, enabled: true } }
        : editing?.schedule ? { schedule: { enabled: false } } : {}),
    };
    (editing ? updateTeammate({ id: editing.id, ...body }) : createTeammate({ spaceId, ...body }))
      .then(async (t) => { closeSheet(); if (!editing) await openTeammate(t.id); })
      .catch((e: unknown) => {
        setFailure(`${editing ? "Not saved" : "Not created"}: ${e instanceof Error ? e.message : String(e)}`);
        setBusy(false);
      });
  };

  return (
    <Sheet title={editing ? `Edit ${editing.name}` : "New teammate"} onClose={closeSheet} width={500}>
      <form className="form tm-sheet" aria-busy={busy || undefined} onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <fieldset className="new-space-fields" disabled={busy}>
          <div className="tm-identity">
            <TeammateIcon icon={f.icon} size={64} lead={f.lead} className="tm-preview" />
            <div className="tm-identity-main">
              <label className="space-identity-label" htmlFor={`${ids}-name`}>Name</label>
              <input id={`${ids}-name`} ref={nameRef} className="space-name" value={f.name} placeholder="e.g. CTO"
                spellCheck={false} autoComplete="off" maxLength={60} onChange={(e) => put({ name: e.target.value })} />
              <ShapeChoices icon={f.icon} onIcon={(icon) => put({ icon })} />
              <ColorChoices icon={f.icon} onIcon={(icon) => put({ icon })} />
            </div>
          </div>
          <div className="tm-brief">
            <div className="tm-brief-head">
              <label className="space-identity-label" htmlFor={`${ids}-brief`}>What it does</label>
              {!editing && (
                <span className="tm-starts" role="group" aria-label="Quick starts">
                  {QUICK_STARTS.map((q) => (
                    <button key={q.id} type="button" className="tm-start" title={`Start from ${q.name}`} onClick={() => quickStart(q)}>{q.name}</button>
                  ))}
                </span>
              )}
            </div>
            <textarea id={`${ids}-brief`} className="new-space-memory tm-brief-text" rows={5} value={f.brief}
              placeholder="What it owns, how it works, and what it brings back."
              onChange={(e) => put({ brief: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } }} />
          </div>
          <div className="settings-group">
            <div className="settings-row new-space-row">
              <span className="settings-row-name">Model</span>
              <TeammateModel f={f} onChange={put} />
            </div>
            <FolderRow folder={f.folder} spaceFolder={space?.folderPath ?? ""} onFolder={(folder) => put({ folder })} />
            <div className="settings-row new-space-row">
              <span className="settings-row-name" id={`${ids}-mode`}>Permissions</span>
              <fieldset className="seg tm-modes" aria-labelledby={`${ids}-mode`}>
                {MODES.map((m) => {
                  const mark = permissionMark(m);
                  return (
                    <label key={m} className="seg-opt" data-selected={shownMode === m || undefined}>
                      <input type="radio" name={`${ids}-mode`} value={m} checked={shownMode === m}
                        onChange={() => { setModeTouched(true); put({ permissionMode: m }); }} />
                      <Icon name={mark.icon} size={14} />{mark.label}
                    </label>
                  );
                })}
              </fieldset>
            </div>
            <div className="settings-row new-space-row">
              <label className="settings-row-name" htmlFor={`${ids}-group`}>Group</label>
              <input id={`${ids}-group`} className="tm-group" list={`${ids}-groups`} value={f.group} placeholder="None" maxLength={60}
                spellCheck={false} autoComplete="off" onChange={(e) => put({ group: e.target.value })} />
              <datalist id={`${ids}-groups`}>{groups.map((g) => <option key={g} value={g} />)}</datalist>
            </div>
            <label className="settings-row new-space-row">
              <span className="new-space-row-main">
                <span className="settings-row-name">Make this the Lead</span>
                <span className="settings-row-desc">First in the list. Routes your asks to the right teammate.</span>
              </span>
              <input type="checkbox" role="switch" className="switch tm-lead" checked={f.lead} onChange={(e) => put({ lead: e.target.checked })} />
            </label>
          </div>
          <ul className="settings-list tm-clock">
            <li className="settings-row">
              <span className="settings-row-main">
                <span className="settings-row-name">Check in on a schedule</span>
                <span className="settings-row-desc">Its chat gets the message below at these times, and it reports there.</span>
              </span>
              <input type="checkbox" role="switch" className="switch" aria-label="Check in on a schedule" checked={clock.on}
                onChange={(e) => setClock((c) => ({ ...c, on: e.target.checked }))} />
            </li>
            {clock.on && <WhenRows d={clock.when} patch={(p) => setClock((c) => ({ ...c, when: { ...c.when, ...p } }))} />}
            {clock.on && (
              <li className="settings-row tm-clock-prompt">
                <textarea className="new-space-memory" aria-label="What it is told" rows={2} value={clock.prompt} placeholder={TEAMMATE_CLOCK_PROMPT}
                  onChange={(e) => { const prompt = e.target.value; setClock((c) => ({ ...c, prompt })); }} />
              </li>
            )}
          </ul>
          {clock.on && (
            <p className="sched-modal-when" data-invalid={nextCheckIn === null || undefined}>
              {nextCheckIn !== null ? `Next check-in ${whenPhrase(nextCheckIn)}.` : "That expression will never run — check the five fields (minute, hour, day, month, weekday)."}
            </p>
          )}
        </fieldset>
        <div className="new-space-foot">
          {failure
            ? <p className="new-space-summary" role="alert" data-tone="danger">{failure}</p>
            : <p className="new-space-summary">{editing ? "" : "Opens a chat with it."}</p>}
          <button type="submit" className="btn primary" disabled={!ready || busy} aria-busy={busy || undefined}>
            {busy ? <><Spinner size={14} /> {editing ? "Saving…" : "Creating…"}</> : editing ? "Save" : "Create"}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

function ShapeChoices({ icon, onIcon }: { icon: IconSpec; onIcon: (icon: IconSpec) => void }) {
  const at = TEAMMATE_SHAPES.indexOf(icon.shape);
  const { buttons, onKeyDown } = useRadioKeys(TEAMMATE_SHAPES, at, (shape) => onIcon({ ...icon, shape }));
  return (
    <div className="tm-shapes" role="radiogroup" aria-label="Shape" onKeyDown={onKeyDown}>
      {TEAMMATE_SHAPES.map((shape, i) => (
        <button key={shape} ref={(el) => { buttons.current[i] = el; }} type="button" role="radio" aria-checked={shape === icon.shape}
          aria-label={TEAMMATE_SHAPE_LABELS[shape]} title={TEAMMATE_SHAPE_LABELS[shape]} tabIndex={i === at ? 0 : -1}
          className="tm-shape" data-selected={shape === icon.shape || undefined} onClick={() => onIcon({ ...icon, shape })}>
          <TeammateIcon icon={{ shape, color: icon.color }} size={24} />
        </button>
      ))}
    </div>
  );
}

function ColorChoices({ icon, onIcon }: { icon: IconSpec; onIcon: (icon: IconSpec) => void }) {
  const at = TEAMMATE_COLORS.indexOf(icon.color);
  const { buttons, onKeyDown } = useRadioKeys(TEAMMATE_COLORS, at, (color) => onIcon({ ...icon, color }));
  return (
    <div className="swatches tm-colors" role="radiogroup" aria-label="Colour" onKeyDown={onKeyDown}>
      {TEAMMATE_COLORS.map((color, i) => (
        <button key={color} ref={(el) => { buttons.current[i] = el; }} type="button" role="radio" aria-checked={color === icon.color}
          aria-label={TEAMMATE_PALETTE[color].label} title={TEAMMATE_PALETTE[color].label} tabIndex={i === at ? 0 : -1}
          className="swatch" data-selected={color === icon.color || undefined} style={{ background: teammateFill(color) }}
          onClick={() => onIcon({ ...icon, color })} />
      ))}
    </div>
  );
}

/** The prompter's own model chip and picker over the sheet's fields: the same rows with their
 *  harnesses (Claude and Codex), and the model's own levels with its default. */
function TeammateModel({ f, onChange }: { f: Fields; onChange: (patch: Partial<Fields>) => void }) {
  const catalog = useRunCatalog(f.agentKind, f.model);
  const run = useApp((s) => s.run);
  const probeAgents = useApp((s) => s.probeAgents);
  const refreshModelCatalog = useApp((s) => s.refreshModelCatalog);
  const toggleModelFavorite = useApp((s) => s.toggleModelFavorite);
  const eggs = useApp((s) => s.easterEggs);
  useEffect(() => { run(() => probeAgents()); run(() => refreshModelCatalog()); }, [run, probeAgents, refreshModelCatalog]);
  const effort: EffortControl | undefined = catalog.levels.levels.length === 0 ? undefined
    : { ...catalog.levels, value: f.effort, onChange: (id) => onChange({ effort: id }) };
  return (
    <ModelPicker kind={f.agentKind} model={f.model} agentProbe={catalog.agentProbe} effort={effort} rows={catalog.rows} info={catalog.info}
      onToggleFavorite={(key) => run(() => toggleModelFavorite(key))}
      onPick={(agentKind, model) => onChange({ agentKind, model })} eggs={eggs} />
  );
}

/** Where it works: the space's folder unless the person chose another, chosen through the dialog or
 *  dropped from the Finder. */
function FolderRow({ folder, spaceFolder, onFolder }: { folder: string | null; spaceFolder: string; onFolder: (folder: string | null) => void }) {
  const pickFolder = useApp((s) => s.pickFolder);
  const pathForFile = useApp((s) => s.pathForFile);
  const run = useApp((s) => s.run);
  const drop = useFileDrop((files) => {
    const path = files.map((file) => pathForFile(file)).find(Boolean);
    if (path) onFolder(path);
  }, true);
  const shown = folder ?? spaceFolder;
  return (
    <div className="settings-row new-space-row space-folder" data-dropping={drop.dropping || undefined} {...drop.handlers}>
      <span className="settings-row-name">Folder</span>
      <div className="space-folder-control" data-chosen="">
        <Icon name="folder" size={14} />
        <span className="space-folder-path" title={shown}>{shown}</span>
        {folder !== null && (
          <button type="button" className="icon-btn" aria-label="Use the space's folder" title="Use the space's folder" onClick={() => onFolder(null)}>
            <Icon name="close" size={12} />
          </button>
        )}
        <button type="button" className="btn" onClick={() => run(async () => { const p = await pickFolder(); if (p) onFolder(p); })}>Choose…</button>
      </div>
    </div>
  );
}
