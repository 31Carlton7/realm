import { chordsForCommand, displayKeyChord, scriptCommandId, type Keybinding, type Script } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useApp } from "../../state/store";
import { Menu } from "../Menu";
import { Sheet } from "../Sheet";
import { draftFrom, emptyDraft, reorderedIds, validateScriptDraft, type ScriptDraft } from "./scripts-form";

/**
 * A space's project scripts: the named shell commands it runs often, in the order the user put them.
 *
 * The feature shipped with a server, a store slice and a keybinding namespace and no way to create
 * one, so this panel is where it starts existing for a person. It is the surface that has to be
 * honest about the two halves that are not connected to each other: a script lives in this space's
 * settings, and the key that runs it lives in `~/Realm/keybindings.json`. Each row therefore shows
 * the chord that currently resolves to `script.<id>.run` — resolves, not "is written down for": a
 * rule a later rule has already defeated must not be advertised here, which is why the chord comes
 * from `chordsForCommand` rather than from a scan of the file for this command's name.
 *
 * A script nobody has bound shows nothing at all. The rejected alternative was a dimmed "no key" or a
 * "Set a key…" affordance, and both are the same mistake in different clothes: this panel cannot write
 * that file (rebinding is a keybindings-panel decision, and that panel is read-mostly), so a
 * control here would be a door onto a wall. What it offers instead is the one thing the user actually
 * cannot get anywhere else — the command id, copyable, because nobody types a ULID from memory.
 */
export function ScriptsPanel({ spaceId }: { spaceId: string }) {
  const scripts = useApp((s) => s.spaceScripts[spaceId]);
  const space = useApp((s) => s.spaces.find((x) => x.id === spaceId));
  const refreshScripts = useApp((s) => s.refreshScripts);
  const saveScript = useApp((s) => s.saveScript);
  const removeScript = useApp((s) => s.removeScript);
  const reorderScripts = useApp((s) => s.reorderScripts);
  const run = useApp((s) => s.run);
  /* The store's copy, not a read of the file. It is the same list the keyboard handler resolves
     against (App.tsx keeps it in step with `keybindings.changed`), which is the whole point: a
     shortcut printed from a second read is a shortcut that can disagree with the one that fires. */
  const rules = useApp((s) => s.keybindings);
  const [editing, setEditing] = useState<ScriptDraft | null>(null);
  const [removing, setRemoving] = useState<Script | null>(null);

  useEffect(() => { run(() => refreshScripts(spaceId)); }, [spaceId, refreshScripts, run]);

  /* Every write goes out over the wire and is followed by a re-read of this space's list.
     The re-read is not cosmetic. `spaceScripts` is what `ownsScriptCommand` consults SYNCHRONOUSLY
     when a keystroke arrives (keys/use-keybindings.ts), so a script created here and not folded back
     into the store is a script whose key reaches the browser instead of running it — for as long as
     nothing else happens to refresh the space. Nothing in the renderer subscribes to
     `scripts.changed` yet, so this panel refreshes for itself rather than assuming someone will. */
  const save = (draft: ScriptDraft, onDone: () => void) => {
    const checked = validateScriptDraft(draft);
    if (!checked.ok) return checked;
    run(async () => {
      await saveScript(spaceId, checked.input);
      onDone();
    });
    return checked;
  };
  const remove = (id: string) => run(async () => {
    await removeScript(spaceId, id);
    setRemoving(null);
  });
  /* The store action re-reads the list for us — and that refresh is load-bearing, not cosmetic:
     `spaceScripts` is what `ownsScriptCommand` consults synchronously when a keystroke arrives. */
  const reorder = (ids: string[]) => run(async () => { await reorderScripts(spaceId, ids); });

  return (
    <div className="form settings-panel">
      <div className="field">
        <span>Scripts in this space</span>
        {!scripts ? <p className="env-empty">Loading…</p> : scripts.length === 0 ? (
          <p className="env-empty">
            No scripts yet. A script is a command you run here often — <code>pnpm test</code>,
            {" "}<code>make dev</code> — kept with this space and started in a terminal beside your sessions.
          </p>
        ) : (
          <ul className="settings-list">
            {scripts.map((script, i) => (
              <ScriptRow key={script.id} script={script} spaceName={space?.name ?? "this space"}
                rules={rules} first={i === 0} last={i === scripts.length - 1}
                onEdit={() => setEditing(draftFrom(script))}
                onRemove={() => setRemoving(script)}
                onMove={(by) => { const ids = reorderedIds(scripts, i, by); if (ids) reorder(ids); }} />
            ))}
          </ul>
        )}
        <div className="form-actions" style={{ justifyContent: "flex-start" }}>
          <button type="button" className="btn" onClick={() => setEditing(emptyDraft())}>
            <Icon name="add" size={14} /> Add script
          </button>
        </div>
        {/* One sentence, and it carries the fact neither the row nor its controls can: the key is not
            here. Saying it once under the list beats a "no key" on every row that has none. */}
        <p className="settings-hint">
          Each one runs in a terminal in this space. To put a script on a key, copy its command id from
          the row's ⋯ menu into a rule in your <code>keybindings.json</code>; Settings shows where that
          file is.
        </p>
      </div>

      {/* A modal, on McpSection's reasoning: adding a script is a thing you start and finish, and a
          form that unfolds in place moves every row under it by a few hundred pixels. */}
      {editing && (
        <Sheet title={editing.id === null ? "New script" : "Edit script"} onClose={() => setEditing(null)} width={520}>
          <ScriptForm draft={editing} spaceName={space?.name ?? "this space"}
            onSubmit={(d) => save(d, () => setEditing(null))} onCancel={() => setEditing(null)} />
        </Sheet>
      )}
      {removing && (
        <RemoveScriptSheet script={removing} rules={rules}
          onCancel={() => setRemoving(null)} onConfirm={() => remove(removing.id)} />
      )}
    </div>
  );
}

/** The chords that actually RESOLVE to this script right now — not every rule that names it. A rule a
 *  later one has already defeated must not be advertised here, or the row teaches a keystroke that
 *  does nothing; `chordsForCommand` runs the real resolver per candidate for exactly that reason. */
function chordsFor(rules: readonly Keybinding[], scriptId: string): string[] {
  return chordsForCommand(rules, scriptCommandId(scriptId));
}

/**
 * One script. Run is the row's control, because running it is what the list is for; everything else —
 * the two ordering moves, the editor, the command id, the removal — is the occasional action and goes
 * behind ⋯, which is the same split SkillsPanel's rows make and for the same reason.
 */
function ScriptRow({ script, spaceName, rules, first, last, onEdit, onRemove, onMove }: {
  script: Script; spaceName: string; rules: readonly Keybinding[];
  first: boolean; last: boolean;
  onEdit: () => void; onRemove: () => void; onMove: (by: -1 | 1) => void;
}) {
  const runScriptCommand = useApp((s) => s.runScriptCommand);
  const run = useApp((s) => s.run);
  const [menuOpen, setMenuOpen] = useState(false);
  const [refused, setRefused] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const chords = chordsFor(rules, script.id);
  const commandId = scriptCommandId(script.id);

  /* `runScriptCommand` runs in the ACTIVE space and answers false for anything else, so this panel
     opened on a space you are not currently in cannot run its scripts. The button stays live and
     reports what happened rather than being disabled on a guess: the two differ, and a control that
     carries a request has to show which one it got (design.md). Nothing is said in the ordinary
     case — a note that appears on every run is a note nobody reads by the third one. */
  const press = () => run(async () => { setRefused(!(await runScriptCommand(commandId))); });

  return (
    <li className="settings-row">
      <div className="settings-row-main">
        <span className="settings-row-name">{script.name}</span>
        {/* Mono, and deliberately: a column of chords down a list is an aligned comparison, which is
            the one place fixed advance widths help rather than hurt. */}
        {chords.map((chord) => (
          <kbd key={chord} className="settings-chip" title={`${displayKeyChord(chord)} runs this script`}>{displayKeyChord(chord)}</kbd>
        ))}
        <span className="settings-row-desc">
          <code className="env-path">{script.command}</code>
          {script.cwd !== null && <> in <code className="env-path">{script.cwd}</code></>}
        </span>
        {refused && (
          <span className="settings-row-problem" role="status">
            <Icon name="alert" size={12} /> Realm runs a script in the space you are in. Open {spaceName} first.
          </span>
        )}
      </div>
      <button type="button" className="btn-quiet" onClick={press} aria-label={`Run ${script.name}`}>
        <Icon name="play" size={12} /> Run
      </button>
      <button ref={menuBtn} type="button" className="icon-btn" aria-haspopup="menu" aria-expanded={menuOpen}
        aria-label={`More for ${script.name}`} onClick={() => setMenuOpen((v) => !v)}>
        <Icon name="more" size={14} />
      </button>
      {menuOpen && (
        <Menu anchorRef={menuBtn} align="right" label={`Actions for ${script.name}`} onClose={() => setMenuOpen(false)}
          items={[
            { label: "Edit…", icon: <Icon name="edit" size={14} />, onSelect: onEdit },
            { label: "Copy command id", icon: <Icon name="copy" size={14} />, title: commandId,
              onSelect: () => { void navigator.clipboard?.writeText?.(commandId); } },
            { kind: "separator" },
            { label: "Move up", icon: <Icon name="arrowUp" size={14} />, disabled: first, onSelect: () => onMove(-1) },
            { label: "Move down", icon: <Icon name="arrowDown" size={14} />, disabled: last, onSelect: () => onMove(1) },
            { kind: "separator" },
            { label: "Remove…", icon: <Icon name="trash" size={14} />, danger: true, onSelect: onRemove },
          ]} />
      )}
    </li>
  );
}

/**
 * Removing a script whose key is bound.
 *
 * The rule in `keybindings.json` names `script.<id>.run`, and that id can never be issued again — so
 * removal leaves a line in the user's file pointing at nothing. Realm does not delete that line, and
 * the choice is not squeamishness: the keymap is a file people hand-edit and keep in a dotfiles repo,
 * and a rule naming a script id is indistinguishable from a rule naming ANOTHER space's script, which
 * is a case the keyboard layer deliberately supports. An app that silently rewrote the file would
 * have to be right about which of the two it was looking at, from a page that only knows one space.
 *
 * So it is said instead, here, at the moment it becomes true — with the chord named, because "a
 * keybinding" is not something a person can go and find and "⌘⇧T" is. What happens next is stated
 * exactly: Realm stops claiming that keystroke (`use-keybindings.ts` refuses to swallow a script
 * command this space does not own), so the key goes back to doing whatever it did before.
 */
function RemoveScriptSheet({ script, rules, onCancel, onConfirm }: {
  script: Script; rules: readonly Keybinding[]; onCancel: () => void; onConfirm: () => void;
}) {
  const chords = chordsFor(rules, script.id);
  return (
    <Sheet title="Remove this script?" onClose={onCancel} width={460}>
      <div className="form">
        <div className="field">
          <span>{script.name}</span>
          <code className="env-path">{script.command}</code>
        </div>
        {chords.length > 0 ? (
          <p className="settings-note" role="alert">
            <Icon name="alert" size={12} />{" "}
            {chords.map(displayKeyChord).join(" and ")} {chords.length === 1 ? "is" : "are"} bound to this
            script in <code>keybindings.json</code>. Realm will not edit that file, so the rule stays —
            it will name a script that no longer exists, and the key goes back to doing nothing in Realm.
          </p>
        ) : (
          <p className="settings-hint">No key is bound to this script.</p>
        )}
        <div className="sheet-actions">
          <button type="button" className="btn" onClick={onCancel}>Keep it</button>
          <button type="button" className="btn destructive" onClick={onConfirm}>Remove</button>
        </div>
      </div>
    </Sheet>
  );
}

/**
 * The editor. Three fields and one refusal line.
 *
 * The refusal comes from `ScriptInputSchema` (see scripts-form.ts) on submit rather than from a
 * disabled Save: a name at 81 characters and a name at 80 look the same, and a button that has gone
 * dead says a rule was broken without saying which.
 */
function ScriptForm({ draft, spaceName, onSubmit, onCancel }: {
  draft: ScriptDraft; spaceName: string;
  /** Returns the validation, so the form can print a refusal the panel already computed. */
  onSubmit: (draft: ScriptDraft) => ReturnType<typeof validateScriptDraft>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(draft.name);
  const [command, setCommand] = useState(draft.command);
  const [cwd, setCwd] = useState(draft.cwd);
  const [problem, setProblem] = useState<{ field: string; message: string } | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const result = onSubmit({ id: draft.id, name, command, cwd });
    setProblem(result.ok ? null : { field: result.field, message: result.message });
  };

  return (
    <form className="form" onSubmit={submit}>
      {/* `aria-invalid` on the field the schema actually named, so the refusal reaches a reader who
          is on the input rather than only one who is looking at the sentence under the form. */}
      <label className="field"><span>Name</span>
        <input aria-label="Script name" value={name} aria-invalid={problem?.field === "name" || undefined}
          onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <label className="field"><span>Command</span>
        <input aria-label="Script command" value={command} spellCheck={false}
          aria-invalid={problem?.field === "command" || undefined}
          onChange={(e) => setCommand(e.target.value)} />
      </label>
      {/* Said here rather than in a note under the list: it is a fact about THIS field, and it is the
          one thing about a script that a person guesses wrong (the other reading — relative to
          wherever the server happens to be running — points at a directory nobody chose). */}
      <label className="field"><span>Folder</span>
        <input aria-label="Script folder" value={cwd} spellCheck={false} placeholder={`${spaceName}'s own folder`}
          onChange={(e) => setCwd(e.target.value)} />
      </label>
      <p className="settings-hint">
        A relative folder resolves against this space's folder. Leave it blank to run there.
      </p>
      {/* An existing script's command id, in full, where there is room for it and exactly one script
          to be confused about. It is the string a keybinding rule has to name, it is a ULID, and the
          row's "Copy command id" is a clipboard action a keyboard reader cannot read back. */}
      {draft.id !== null && (
        <div className="field"><span>Command id</span>
          <code className="env-path">{scriptCommandId(draft.id)}</code>
        </div>
      )}
      {problem && <p className="settings-hint" data-tone="danger" role="alert">{problem.message}</p>}
      <div className="form-actions">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn primary">{draft.id === null ? "Add script" : "Save"}</button>
      </div>
    </form>
  );
}
