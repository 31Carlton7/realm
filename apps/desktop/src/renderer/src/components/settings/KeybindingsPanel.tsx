import { KEY_COMMANDS, type KeybindingsFile } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { rpc } from "../../rpc/client";
import { useApp } from "../../state/store";
import {
  commandEntries, describeRules, filterEntries, groupEntries, type CommandEntry, type RuleView,
} from "./keybindings-model";

/**
 * Every shortcut Realm answers to, and what the user's file currently says about each.
 *
 * Read-mostly, and that is the honest shape for it rather than a stage of one. The keymap is a file —
 * ordered, commented, diffable, kept in a dotfiles repo — and order IS precedence, so an editor that
 * could add a rule would immediately owe the user a way to say WHERE it goes, which is the whole of
 * the feature and not a control. What a page can do without taking that on is tell the truth about
 * the file: what runs, what a later rule has already taken away, what Realm could not read, and where
 * the file is so the user can open it. The one write here is the one write that needs no position —
 * Reset, which discards every rule rather than placing one.
 *
 * `error` is the state this page exists for. A keymap that will not parse does not brick the app
 * (the server answers with Realm's defaults and leaves the file alone), which is correct and is also
 * how a typo becomes invisible: every shortcut still works, so nothing is obviously wrong, and the
 * user's own rules are quietly not running. It is said at the top, before the list it invalidates.
 */
export function KeybindingsPanel() {
  const { file, adopt } = useKeybindingsFile();
  const run = useApp((s) => s.run);
  const [query, setQuery] = useState("");
  const [confirmingReset, setConfirmingReset] = useState(false);

  const views = useMemo(() => (file ? describeRules(file.rules) : []), [file]);
  const entries = useMemo(() => commandEntries(views), [views]);
  const groups = useMemo(() => groupEntries(filterEntries(entries, query)), [entries, query]);

  const reset = () => run(async () => {
    adopt(await rpc().call("keybindings.reset", {}));
    setConfirmingReset(false);
  });

  if (!file) {
    return <div className="form settings-panel"><p className="env-empty">Loading…</p></div>;
  }

  return (
    <div className="form settings-panel">
      {file.error !== null && (
        <>
          {/* Above the list, not beside it: everything below is Realm's defaults, so a reader who
              starts at the list is reading an answer to a question they did not ask. */}
          <p className="settings-note" role="alert">
            <Icon name="alert" size={12} /> Realm could not use <code>{file.path}</code> as written, so
            the shortcuts below are the ones Realm ships. Your file has not been changed — fix it and
            this page will follow.
          </p>
          <p className="settings-hint" data-tone="danger">{file.error}</p>
        </>
      )}

      <div className="field">
        <span>Shortcuts</span>
        <input className="search-field" type="search" placeholder={`Search ${KEY_COMMANDS.length} commands…`}
          aria-label="Search shortcuts" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {/* Each group is a field of its own, so its heading is the panel's own label type rather than a
          second scale invented for this page — and an empty group simply does not render. */}
      {groups.length === 0 ? <p className="env-empty">Nothing matches.</p> : groups.map((g) => (
        <div className="field" key={g.group}>
          <span>{g.group}</span>
          <ul className="settings-list">
            {g.entries.map((e) => <CommandRow key={e.id || "unbound"} entry={e} />)}
          </ul>
        </div>
      ))}

      <div className="field">
        <span>The file</span>
        <code className="env-path">{file.path}</code>
        <div className="form-actions" style={{ justifyContent: "flex-start" }}>
          <button type="button" className="btn btn-quiet" onClick={() => void window.realm?.files?.reveal?.(file.path)}>
            <Icon name="folder" size={14} /> Reveal in Finder
          </button>
          {/* Two steps, because there is no undo and the thing discarded is every line the user ever
              wrote in that file — including the ones this page is refusing to parse, which are the
              ones they are most likely to be part-way through fixing. */}
          {confirmingReset ? (
            <>
              <button type="button" className="btn destructive" onClick={reset}>Discard my rules</button>
              <button type="button" className="btn" onClick={() => setConfirmingReset(false)}>Cancel</button>
            </>
          ) : (
            <button type="button" className="btn btn-quiet danger" onClick={() => setConfirmingReset(true)}>
              Reset to defaults
            </button>
          )}
        </div>
        {confirmingReset && (
          <p className="settings-note" role="alert">
            This rewrites <code>{file.path}</code> with Realm's shipped rules. Everything you have
            changed there goes, and there is no undo.
          </p>
        )}
        <p className="settings-hint">
          Rules are read in order and the last one that matches wins, which is how a rule of yours
          beats one of Realm's. Editing the file is what changes that order; this page only reads it.
        </p>
      </div>
    </div>
  );
}

/**
 * One command and its rules.
 *
 * A command with no rule says "Not bound" — a fact, and one the catalogue is here to report. A command
 * whose rule has been DEFEATED must not say that: the user wrote the line, it is in the file, and
 * "not bound" sends them to check whether they saved it. It shows the chord struck through with the
 * command that took it, which is the difference between "you did nothing" and "something else won".
 */
function CommandRow({ entry }: { entry: CommandEntry }) {
  return (
    <li className="settings-row">
      <div className="settings-row-main">
        <span className="settings-row-name">
          {entry.known ? entry.label : <code className="env-path">{entry.label}</code>}
        </span>
        {entry.bindings.length === 0
          ? <span className="settings-row-desc">Not bound.</span>
          : entry.bindings.map((b) => <BindingNote key={b.index} view={b} />)}
      </div>
    </li>
  );
}

/** What one rule is doing, in a chord and at most one sentence. A rule that is simply working says
 *  nothing beyond its chord — thirty rows each explaining that they are fine is how a page of
 *  shortcuts becomes a page of prose. The clause is on the chord's `title` either way. */
function BindingNote({ view }: { view: RuleView }) {
  /* `<s>`, not a line-through of this page's own: the element means "no longer accurate", which is
     exactly what a defeated rule is, and it needs no stylesheet to say so. The strike is never the
     whole message either way — it is not announced, so the sentence beside it carries the fact. */
  const chord = (
    <kbd className="settings-chip" title={view.rule.when ? `when ${view.rule.when}` : undefined}>
      {view.state === "defeated" ? <s>{view.display}</s> : view.display}
    </kbd>
  );
  if (view.state === "live") return chord;
  return (
    <span className="settings-row-desc">
      {chord}{" "}
      {view.state === "defeated" && <>Taken by {defeatedByLabel(view)} further down the file.</>}
      {view.state === "conditional" && <>Only while <code>{view.rule.when}</code>.</>}
      {view.state === "bad-key" && <>Realm cannot read this key, so nothing runs it.</>}
      {view.state === "bad-when" && <>Realm cannot read <code>{view.rule.when}</code>, so this rule never fires.</>}
    </span>
  );
}

/** The winner, named the way the user would recognise it: Realm's label for a catalogued command, the
 *  raw id for anything else, and prose for the unbind — which is not another command taking the key
 *  but the key being switched off, and reads as nonsense reported as a command id. */
function defeatedByLabel(view: RuleView): string {
  const id = view.defeatedBy?.command ?? "";
  if (id === "") return "a rule that turns this key off";
  return KEY_COMMANDS.find((c) => c.id === id)?.label ?? id;
}

/**
 * `~/Realm/keybindings.json` as this page has it — the whole answer, not just its rules.
 *
 * The store already holds `keybindings`, and anything that PRINTS a shortcut reads it from there.
 * This page is the one surface that cannot: it needs `path` and `error` as well, and it needs all
 * three to have come from ONE read. The store's copy falls back to Realm's shipped defaults until the
 * server answers, which is exactly right for a keyboard handler and exactly wrong here — a page whose
 * subject is the user's file must not draw defaults and call them theirs.
 *
 * `undefined` until the read answers, and a failed read stays `undefined` for the same reason.
 */
function useKeybindingsFile(): {
  file: KeybindingsFile | undefined;
  /** Take the file a write answered with. Not an optimisation over waiting for `keybindings.changed`:
   *  it is what makes Reset one step instead of two, so the page redraws from the thing it just did. */
  adopt: (next: KeybindingsFile) => void;
} {
  const [file, setFile] = useState<KeybindingsFile | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    let off = () => {};
    try {
      const client = rpc();
      const load = () => { void client.call("keybindings.get", {}).then((f) => { if (alive) setFile(f); }).catch(() => {}); };
      load();
      // An edit made in a text editor, or by Reset, or by anything else holding this file.
      off = client.on("keybindings.changed", load);
    } catch {
      // No socket in this host — a renderer mounted before the bridge. The panel shows its loading
      // state, the same degradation every optional bridge call site makes, rather than taking the
      // page down with it.
    }
    return () => { alive = false; off(); };
  }, []);
  return { file, adopt: useCallback((next: KeybindingsFile) => setFile(next), []) };
}
