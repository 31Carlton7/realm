import {
  KEY_COMMANDS, displayKeyChord, matchKeybinding, normalizeKeyChord, parseScriptCommandId, parseWhen,
  whenHolds, type KeyContext, type Keybinding,
} from "@realm/contracts";

/**
 * What the keybindings page is allowed to say about a rule — and, above all, which rule holds a chord.
 *
 * Apart from the panel because precedence is the one thing on that page a reader has to be able to
 * trust. Rule 2 of the keybinding contract ("the last matching rule wins, across commands") is the
 * entire mechanism by which a user's override beats a shipped default, so a page that renders it
 * approximately teaches a shortcut that does nothing. Nothing here re-derives it: `matchKeybinding`
 * is asked, per rule, who actually holds that chord, and the answer is compared against the rule's own
 * index. Walking the array and keeping the last name per key would agree with it today and stop
 * agreeing the moment `when` clauses are involved, which is exactly when a user needs the page.
 */

/**
 * The frame every judgement here is made in: nothing special is happening.
 *
 * The same frame `chordsForCommand` uses for a menu hint, and for the same reason — a settings page
 * cannot show a binding "as it would be if you were typing in the composer" without inventing a state
 * the reader is not in. The consequence is deliberate: a rule whose `when` is false in this frame is
 * reported as CONDITIONAL, never as defeated and never as absent. It is not losing to anything; it is
 * waiting for its moment, and calling it defeated would be the page lying about the user's file.
 */
const IDLE: KeyContext = {};

export type RuleState =
  /** Press this chord with nothing else going on and this rule is what runs. */
  | "live"
  /** A LATER rule claims the same chord, so this one never fires. Rule 2, visible. */
  | "defeated"
  /** Its `when` is false in the idle frame — it fires in the state the clause names, and only there. */
  | "conditional"
  /** `key` is not a chord Realm can parse, so nothing can ever match it. */
  | "bad-key"
  /** `when` is not a clause Realm can parse. The contract treats an unparseable clause as false, so
   *  the rule is inert — reported on its own terms because "conditional" would imply a condition
   *  that could one day hold. */
  | "bad-when";

export type RuleView = {
  /** Its index in the file. Shown nowhere, but it is what names the winner in `defeatedBy`. */
  index: number;
  rule: Keybinding;
  /** The canonical spelling, or null when Realm cannot read the key. */
  chord: string | null;
  /** What to print: the glyphs for a readable chord, and the user's own text verbatim otherwise —
   *  showing them the string their file actually contains is the whole of what finds the typo. */
  display: string;
  state: RuleState;
  /** When `state` is "defeated": the rule that takes the chord instead. `command` may be `""`, which
   *  is the unbind — a key deliberately turned off, not a key given to something else. */
  defeatedBy: { index: number; command: string } | null;
};

export function describeRules(rules: readonly Keybinding[]): RuleView[] {
  return rules.map((rule, index) => {
    const base = { index, rule, defeatedBy: null };
    const chord = normalizeKeyChord(rule.key);
    // Checked before the clause: a key that cannot be parsed can never fire whatever the `when` says,
    // and the only thing that helps the reader is being told THIS line is the unreadable one.
    if (chord === null) return { ...base, chord: null, display: rule.key, state: "bad-key" as const };
    const display = displayKeyChord(rule.key);
    // `whenHolds` folds "does not parse" and "parses and is false" into one `false`, which is right
    // for the resolver and useless for a page that has to tell a typo from a condition. `parseWhen` is
    // the same parser asked the question directly — the alternative, probing `whenHolds` with a
    // context built from the clause's own identifiers, agrees on most clauses and gets
    // `!overlayOpen && sessionFocus` (a shipped default) wrong in both probes.
    if (rule.when !== undefined && rule.when.trim() !== "" && parseWhen(rule.when) === null) {
      return { ...base, chord, display, state: "bad-when" as const };
    }
    if (!whenHolds(rule.when, IDLE)) return { ...base, chord, display, state: "conditional" as const };
    const winner = matchKeybinding(rules, chord, IDLE);
    // `winner` cannot be null here — this rule matches its own chord and its clause holds — and by
    // rule 2 it cannot sit before `index`. Both invariants are left to fall out of the comparison
    // rather than asserted: an exact index hit is "live", and anything else is a defeat, so a future
    // change to either would surface as a visible conflict instead of a silent claim that all is well.
    return winner !== null && winner.index !== index
      ? { ...base, chord, display, state: "defeated" as const, defeatedBy: { index: winner.index, command: winner.command } }
      : { ...base, chord, display, state: "live" as const };
  });
}

/**
 * One row of the page: a command, and every rule in the file that names it.
 *
 * Rules are carried rather than reduced to "the chord". A command whose only rule has been defeated
 * must not read as unbound — the user wrote that line, and "nothing here" is the answer that sends
 * them to the file to check whether they saved it. The defeated rule is shown, struck, with the
 * command that took the key.
 */
export type CommandEntry = {
  id: string;
  /** What to print. For a catalogued command it is Realm's own label; otherwise it is the raw id. */
  label: string;
  group: string;
  /** False when `label` IS the id out of the file, so the panel sets it as code rather than as prose. */
  known: boolean;
  bindings: RuleView[];
};

/** The catalogue's own groups, in the order `KEY_COMMANDS` declares them, then the three groups the
 *  catalogue cannot contain. A user's file is allowed to name ids Realm has never heard of (rule 3),
 *  and a page that listed only the catalogue would answer "where is the rule I wrote?" with silence. */
export const SCRIPTS_GROUP = "Project scripts";
export const FOREIGN_GROUP = "Not in this version of Realm";
export const UNBOUND_GROUP = "Keys you have turned off";

export function commandEntries(views: readonly RuleView[]): CommandEntry[] {
  const catalogued = KEY_COMMANDS.map((c): CommandEntry => ({
    id: c.id, label: c.label, group: c.group, known: true,
    bindings: views.filter((v) => v.rule.command === c.id),
  }));

  const known = new Set(KEY_COMMANDS.map((c) => c.id));
  // First appearance in the file decides the order, so a person scrolling this section is reading
  // their own file in the order they wrote it.
  const extra = new Map<string, CommandEntry>();
  for (const v of views) {
    const id = v.rule.command;
    if (known.has(id)) continue;
    const existing = extra.get(id);
    if (existing) { existing.bindings.push(v); continue; }
    extra.set(id, { ...describeForeign(id), bindings: [v] });
  }
  return [...catalogued, ...extra.values()];
}

function describeForeign(id: string): Omit<CommandEntry, "bindings"> {
  // The unbind is a command id in the file's grammar and a STATE in the reader's head: this key does
  // nothing on purpose. It gets prose, not a `<code></code>`.
  if (id === "") return { id, label: "This key does nothing in Realm", group: UNBOUND_GROUP, known: true };
  // A script's id is a ULID — unreadable by design, and not something this page can put a name to:
  // scripts belong to a space, and this page has no space. Its GROUP is what says which kind of
  // thing it is; the space's own Scripts panel is where that id gets a name beside it.
  const group = parseScriptCommandId(id) !== null ? SCRIPTS_GROUP : FOREIGN_GROUP;
  return { id, label: id, group, known: false };
}

/** Entries in group order, empty groups dropped. The group order is the catalogue's declaration order
 *  followed by the three extras, so the page's shape does not change as the file does. */
export function groupEntries(entries: readonly CommandEntry[]): { group: string; entries: CommandEntry[] }[] {
  const order = [...new Set([...KEY_COMMANDS.map((c) => c.group), SCRIPTS_GROUP, FOREIGN_GROUP, UNBOUND_GROUP])];
  return order
    .map((group) => ({ group, entries: entries.filter((e) => e.group === group) }))
    .filter((g) => g.entries.length > 0);
}

/**
 * Search over what is on screen AND over what is in the file.
 *
 * Both spellings of a chord match: "⌘K" is what the page prints and "mod+k" is what the file says,
 * and a person arrives from one or the other. Matching only the printed form would mean the file's
 * own vocabulary found nothing on the page that renders it.
 */
export function filterEntries(entries: readonly CommandEntry[], query: string): CommandEntry[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...entries];
  return entries.filter((e) =>
    e.label.toLowerCase().includes(q)
    || e.id.toLowerCase().includes(q)
    || e.group.toLowerCase().includes(q)
    || e.bindings.some((b) => b.display.toLowerCase().includes(q) || b.rule.key.toLowerCase().includes(q)));
}
