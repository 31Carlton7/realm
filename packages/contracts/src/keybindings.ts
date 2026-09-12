import { z } from "zod";

/**
 * User-rebindable keybindings — the shape of the file, the one spelling a chord has, the `when`
 * language, and the resolver that answers "what does this keystroke run right now".
 *
 * Nothing here touches disk or the DOM. `<REALM_HOME>/keybindings.json` is read and written by
 * `apps/server/src/keybindings/service.ts` alone, and `apps/desktop/src/renderer/src/keys/` is what
 * turns a real KeyboardEvent into one of these chord strings. Both lean on this module for the three
 * rules the feature *is*:
 *
 *  1. **A chord has exactly one spelling.** `⌘⇧K`, `cmd+shift+k` and `Shift+Mod+K` are one keystroke,
 *     so they must normalise to one string. Two spellings of the same chord that do not compare equal
 *     is the bug that makes rule 2 silently not hold: the user's override sits in the file, reads
 *     correctly to a human, and never fires — and nothing in the app can tell them why.
 *  2. **The last matching rule wins, across commands.** A later rule for a key defeats an earlier one
 *     whatever command either names. That is the entire mechanism by which a user overrides a shipped
 *     default, so it is exact rather than approximate — `matchKeybinding` walks the array backwards
 *     for no other reason.
 *  3. **A command id is an opaque string**, never checked against `KEY_COMMANDS`. Project scripts are
 *     addressable as `script.<id>.run` (`scriptCommandId` in ./scripts, which owns that namespace)
 *     and those ids do not exist until someone writes a script; a closed enum here would mean this
 *     module had to ship an update before a user could bind their own work, which is not a thing a
 *     keybinding layer gets to demand. `KEY_COMMANDS` is a catalog for a settings list to render,
 *     not a gate.
 */

/** The file's name under REALM_HOME. The server owns the path; this is the half both ends agree on. */
export const KEYBINDINGS_FILE = "keybindings.json";

/**
 * One rule, as the file carries it.
 *
 * - `key` — a chord in any spelling `parseKeyChord` accepts; it is normalised when matched, never when
 *   stored, so a hand-written `Cmd+Shift+K` stays as the person typed it.
 * - `command` — an opaque id (rule 3). **The empty string UNBINDS**: a rule `{ key, command: "" }`
 *   that wins the match means the keystroke runs nothing and Realm does not consume it. That is the
 *   only way to *remove* a binding — deleting the default's line instead would just let the default
 *   be re-seeded on the next boot (see `mergeDefaults`), which is the trap this spelling avoids.
 * - `when` — a boolean expression over context keys; absent means "always".
 */
export const KeybindingSchema = z.object({
  key: z.string(),
  command: z.string(),
  when: z.string().optional(),
});
export type Keybinding = z.infer<typeof KeybindingSchema>;

/**
 * What a read of the file answers with.
 *
 * `error` is non-null when the file on disk could not be used as written — a syntax error, a top
 * level that is not an array, a rule that is not a rule. It is a field rather than a thrown error
 * because a malformed keybindings file must not brick the app: the rules come back as the shipped
 * defaults and the sentence is carried up to be shown, which is strictly more useful than a boot
 * that fails with the shortcuts the user never touched.
 */
export const KeybindingsFileSchema = z.object({
  path: z.string(),
  rules: z.array(KeybindingSchema),
  error: z.string().nullable(),
});
export type KeybindingsFile = z.infer<typeof KeybindingsFileSchema>;

/**
 * A keystroke, decomposed. The four modifier flags are exact: a chord matches only when all four
 * agree, so ⌘⇧T is not ⌘T with something extra held.
 *
 * `KeyChord` rather than `Chord`, and `parseKeyChord` rather than `parseChord`, because this package
 * already has a different chord: `./keysym` parses one into the X11 keysyms a VNC session transmits.
 * Both are re-exported from one barrel, so the two notions need two names or callers get whichever
 * they did not mean.
 */
export type KeyChord = { mod: boolean; ctrl: boolean; alt: boolean; shift: boolean; key: string };

/**
 * `mod` is Cmd, and `cmd`/`meta`/`⌘` all fold into it.
 *
 * Realm runs on macOS only, so folding is not a shortcut taken here — the two names denote the same
 * physical key, and keeping them apart would mean `cmd+k` and `mod+k` were two chords that never
 * compared equal, which is rule 1's failure mode exactly. `mod` is the canonical one because it is
 * the name that stays true if Realm is ever ported: the file would keep working, where a file full
 * of `cmd` would silently mean the wrong key.
 */
const MODIFIERS: Readonly<Record<string, "mod" | "ctrl" | "alt" | "shift">> = {
  mod: "mod", cmd: "mod", command: "mod", meta: "mod", super: "mod", win: "mod",
  ctrl: "ctrl", control: "ctrl",
  alt: "alt", opt: "alt", option: "alt",
  shift: "shift",
};

/** The glyphs a Mac prints, expanded before parsing so `⌘⇧F` — the thing a user copies out of a
 *  palette hint or a menu — is the same chord as `mod+shift+f` rather than an unparseable key. */
const MODIFIER_GLYPHS: Readonly<Record<string, string>> = { "⌘": "mod", "⌃": "ctrl", "⌥": "alt", "⇧": "shift" };

/**
 * The named keys, and every spelling accepted for each.
 *
 * Canonical forms are lowercase and unadorned (`escape`, `enter`, `up`) rather than the DOM's
 * `Escape`/`Enter`/`ArrowUp`: the file is something a person types, and `mod+arrowup` is not what
 * anyone writes. The DOM spellings are accepted as aliases so pasting from a browser console works.
 */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  esc: "escape", escape: "escape",
  enter: "enter", return: "enter",
  tab: "tab",
  space: "space", spacebar: "space",
  backspace: "backspace",
  delete: "delete", del: "delete",
  up: "up", arrowup: "up", down: "down", arrowdown: "down",
  left: "left", arrowleft: "left", right: "right", arrowright: "right",
  home: "home", end: "end",
  pageup: "pageup", pgup: "pageup", pagedown: "pagedown", pgdn: "pagedown",
  // `+` is the separator, so it needs a word as well as itself — `mod++` parses, but `mod+plus` is
  // the spelling that survives being read aloud.
  plus: "+",
};

/** `f1`…`f20`. Bounded rather than `f\d+` so `f99` is reported as unparseable instead of becoming a
 *  binding on a key no keyboard has. */
const FUNCTION_KEY = /^f([1-9]|1\d|20)$/;

/**
 * A chord string → its parts, or null when it is not a chord.
 *
 * Null rather than a best effort, in every case: a key that cannot be parsed can never fire, and the
 * caller that wants to tell the user so (the service, when reading their file) needs to know which
 * rule was the problem. Silently keeping an unparseable rule would leave someone staring at a
 * shortcut that is written down, spelled plausibly, and dead.
 *
 * Multi-stroke sequences (VS Code's `ctrl+k ctrl+c`) are deliberately NOT supported, and fail here
 * rather than binding their first stroke — a chord that fires halfway through what the user meant is
 * worse than one that says it does not exist.
 */
export function parseKeyChord(text: string): KeyChord | null {
  // Whitespace is stripped rather than tolerated per segment, which is also what makes a two-stroke
  // sequence collapse into one unparseable key name instead of quietly parsing as the first stroke.
  // Each glyph becomes its word plus a separator; the run-collapse that follows is what lets `⌘+K`
  // (glyphs and words mixed, which is how a half-edited line looks) mean the same as `⌘K`. The
  // lookahead spares a trailing run, so `mod++` still binds the literal plus key.
  const flat = text.replace(/\s+/g, "").toLowerCase()
    .replace(/[⌘⌃⌥⇧]/g, (glyph) => `${MODIFIER_GLYPHS[glyph]}+`)
    .replace(/\+{2,}(?=.)/g, "+");
  const segments: string[] = [];
  let cur = "";
  for (const c of flat) {
    // `cur !== ""` is what lets `+` be a key: in `mod++` the second plus starts an empty segment and
    // is taken as the literal key rather than as a second separator.
    if (c === "+" && cur !== "") { segments.push(cur); cur = ""; continue; }
    cur += c;
  }
  segments.push(cur);
  const key = normalizeKeyName(segments.pop() ?? "");
  if (key === null) return null;
  const chord: KeyChord = { mod: false, ctrl: false, alt: false, shift: false, key };
  for (const segment of segments) {
    const modifier = MODIFIERS[segment];
    if (!modifier) return null;
    chord[modifier] = true;
  }
  return chord;
}

/** The key half of a chord, canonicalised — or null when it is not a key Realm can match on. */
function normalizeKeyName(segment: string): string | null {
  if (segment === "") return null;
  // A modifier on its own is not a chord. Refused here rather than left to the event side, because
  // `{ key: "shift" }` in a file would otherwise be a rule that waits for a keystroke that never
  // arrives: `chordFromEvent` never reports a bare modifier press either.
  if (MODIFIERS[segment]) return null;
  const alias = KEY_ALIASES[segment];
  if (alias) return alias;
  if (FUNCTION_KEY.test(segment)) return segment;
  // One code point, so an emoji or an accented letter is one key rather than two. Case is already
  // gone: shift is a modifier and never a letter's case, so `mod+K` and `mod+k` are one chord and
  // `mod+shift+k` is the different one.
  return [...segment].length === 1 ? segment : null;
}

/**
 * The canonical spelling: `mod+ctrl+alt+shift+<key>`.
 *
 * The order is fixed and, beyond that, arbitrary — what matters for rule 1 is only that there is one
 * of them. `mod` leads because nearly every binding Realm ships has it, which makes the shipped table
 * scan as a column of `mod+…`; the rest follow in the order a Mac keyboard prints them.
 */
export function formatKeyChord(chord: KeyChord): string {
  const parts: string[] = [];
  if (chord.mod) parts.push("mod");
  if (chord.ctrl) parts.push("ctrl");
  if (chord.alt) parts.push("alt");
  if (chord.shift) parts.push("shift");
  parts.push(chord.key);
  return parts.join("+");
}

/** Any accepted spelling → the canonical one, or null when it is not a chord. The one function every
 *  comparison goes through; comparing two `key` strings directly is the rule-1 bug. */
export function normalizeKeyChord(text: string): string | null {
  const chord = parseKeyChord(text);
  return chord === null ? null : formatKeyChord(chord);
}

/** Glyphs for the keys that have one. Everything else shows its own character, uppercased. */
const DISPLAY_KEYS: Readonly<Record<string, string>> = {
  escape: "esc", enter: "↩", tab: "⇥", space: "Space", backspace: "⌫", delete: "⌦",
  up: "↑", down: "↓", left: "←", right: "→", pageup: "⇞", pagedown: "⇟", home: "↖", end: "↘",
};

/**
 * A chord as Realm prints it — `mod+shift+f` → `⌘⇧F`, for a palette hint or a menu row.
 *
 * Glyphs in the same order `formatKeyChord` writes words, which is ⌘ first. That is deliberately NOT
 * macOS's menu order (⌃⌥⇧⌘, command nearest the key): it is the order the command palette's own
 * hints have always used — `⌘⇧F`, `⌘⇧↵`, `⌘⇧Space` — and agreeing with the app the user is looking
 * at beats agreeing with a menu bar Realm does not draw. It also means the string in the file and
 * the glyphs on screen list their modifiers the same way, so a person comparing the two is not
 * mentally re-sorting.
 *
 * An unparseable key comes back verbatim rather than as some fallback glyph: showing the user the
 * string their file actually contains is the whole of what lets them find the typo.
 */
export function displayKeyChord(text: string): string {
  const chord = parseKeyChord(text);
  if (chord === null) return text;
  const key = DISPLAY_KEYS[chord.key] ?? chord.key.toUpperCase();
  return `${chord.mod ? "⌘" : ""}${chord.ctrl ? "⌃" : ""}${chord.alt ? "⌥" : ""}${chord.shift ? "⇧" : ""}${key}`;
}

/**
 * A parsed `when` clause.
 *
 * The language is `!`, `&&`, `||` and parentheses over boolean context keys, and nothing else. VS
 * Code's `==` / `!=` / `=~` are not here because every key Realm publishes (`CONTEXT_KEYS`) is a
 * boolean: a comparison operator would be syntax with no values to compare, which is a promise the
 * context cannot keep.
 */
export type WhenExpr =
  | { kind: "key"; name: string }
  | { kind: "not"; expr: WhenExpr }
  | { kind: "and"; left: WhenExpr; right: WhenExpr }
  | { kind: "or"; left: WhenExpr; right: WhenExpr };

type WhenToken = { t: "!" | "&&" | "||" | "(" | ")" } | { t: "id"; name: string };

/** Null on any character the language does not have. A single `&` is a syntax error rather than a
 *  synonym for `&&`: guessing at it would make `a & b` mean something the writer did not write. */
function tokenizeWhen(text: string): WhenToken[] | null {
  const out: WhenToken[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === "(" || c === ")" || c === "!") { out.push({ t: c }); i++; continue; }
    if (c === "&" && text[i + 1] === "&") { out.push({ t: "&&" }); i += 2; continue; }
    if (c === "|" && text[i + 1] === "|") { out.push({ t: "||" }); i += 2; continue; }
    const ident = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(text.slice(i));
    if (!ident) return null;
    out.push({ t: "id", name: ident[0] });
    i += ident[0].length;
  }
  return out;
}

/**
 * Recursive descent, precedence `!` > `&&` > `||`, which is the precedence every language the user
 * has met uses and therefore the only one they will not have to look up.
 *
 * Null on a syntax error, including trailing junk: `a && b )` is refused rather than parsed as its
 * valid prefix, because a clause that means less than it says would silently widen where a binding
 * fires.
 */
export function parseWhen(text: string): WhenExpr | null {
  const tokens = tokenizeWhen(text);
  if (tokens === null || tokens.length === 0) return null;
  let i = 0;
  const peek = (): WhenToken | undefined => tokens[i];

  function unary(): WhenExpr | null {
    const token = peek();
    if (!token) return null;
    if (token.t === "!") { i++; const expr = unary(); return expr === null ? null : { kind: "not", expr }; }
    if (token.t === "(") {
      i++;
      const expr = disjunction();
      if (expr === null || peek()?.t !== ")") return null;
      i++;
      return expr;
    }
    if (token.t === "id") { i++; return { kind: "key", name: token.name }; }
    return null;
  }
  function conjunction(): WhenExpr | null {
    let left = unary();
    while (left !== null && peek()?.t === "&&") {
      i++;
      const right = unary();
      left = right === null ? null : { kind: "and", left, right };
    }
    return left;
  }
  function disjunction(): WhenExpr | null {
    let left = conjunction();
    while (left !== null && peek()?.t === "||") {
      i++;
      const right = conjunction();
      left = right === null ? null : { kind: "or", left, right };
    }
    return left;
  }

  const expr = disjunction();
  return expr !== null && i === tokens.length ? expr : null;
}

/** Which context keys are true right now. A key that is absent is false — the app publishes what is
 *  happening, and anything it did not mention is not happening. */
export type KeyContext = Readonly<Record<string, boolean>>;

export function evaluateWhen(expr: WhenExpr, context: KeyContext): boolean {
  switch (expr.kind) {
    case "key": return context[expr.name] === true;
    case "not": return !evaluateWhen(expr.expr, context);
    case "and": return evaluateWhen(expr.left, context) && evaluateWhen(expr.right, context);
    case "or": return evaluateWhen(expr.left, context) || evaluateWhen(expr.right, context);
  }
}

/**
 * Whether a rule's `when` lets it fire.
 *
 * Absent or blank is `true` — a rule with no condition is unconditional. A clause that does not
 * PARSE is `false`, and that asymmetry is the point: the alternative (treat a broken clause as
 * unconditional) turns one typo into a binding that fires everywhere, including inside the composer,
 * which is the worst outcome available. Inert and reported is recoverable; global and silent is not.
 */
export function whenHolds(when: string | undefined, context: KeyContext): boolean {
  if (when === undefined || when.trim() === "") return true;
  const expr = parseWhen(when);
  return expr === null ? false : evaluateWhen(expr, context);
}

/** The winning rule and where it sat. `command` may be `""` — that is the unbind, and the caller has
 *  to be able to tell it apart from "no rule matched" to avoid swallowing a key it does not use. */
export type KeybindingMatch = { index: number; rule: Keybinding; command: string };

/**
 * The last rule whose key is this chord and whose `when` holds — rule 2, in three lines.
 *
 * Backwards, not forwards-then-keep-the-last, because the two differ the moment a rule is expensive
 * to evaluate and because reading it backwards is what makes the precedence obvious to the next
 * person. Both sides of the comparison are normalised, which is the whole of rule 1 in practice.
 */
export function matchKeybinding(rules: readonly Keybinding[], chord: string, context: KeyContext): KeybindingMatch | null {
  const want = normalizeKeyChord(chord);
  if (want === null) return null;
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]!;
    if (normalizeKeyChord(rule.key) !== want) continue;
    if (!whenHolds(rule.when, context)) continue;
    return { index: i, rule, command: rule.command };
  }
  return null;
}

/** The command this keystroke runs, or null when nothing matched or the winning rule unbinds it. */
export function commandForChord(rules: readonly Keybinding[], chord: string, context: KeyContext): string | null {
  const match = matchKeybinding(rules, chord, context);
  return match !== null && match.command !== "" ? match.command : null;
}

/**
 * The chords that currently run `command` — for a palette hint or a menu row, so those stop being
 * hardcoded glyphs the moment a user rebinds something.
 *
 * A chord is only listed if `command` is what it actually resolves to, which is why this runs the
 * full resolver per candidate rather than filtering rules by name: a rule naming this command that a
 * later rule has already defeated must NOT be advertised, or the hint teaches a shortcut that does
 * nothing. The default empty context is the right frame for a hint — nothing special is happening —
 * and it is why the shipped `when` clauses are written as negations of the unusual state.
 */
export function chordsForCommand(rules: readonly Keybinding[], command: string, context: KeyContext = {}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    const chord = normalizeKeyChord(rule.key);
    if (chord === null || seen.has(chord)) continue;
    seen.add(chord);
    if (commandForChord(rules, chord, context) === command) out.push(chord);
  }
  return out;
}

/**
 * Every context key Realm publishes, and what each one means.
 *
 * This table is the vocabulary a `when` clause may use. It is not enforced — an unknown key is
 * simply false, so a clause naming one can only ever make a binding fire LESS — but it is what a
 * settings UI offers, and what the shipped defaults are checked against so a typo in this file is a
 * test failure rather than a binding that quietly fires everywhere.
 */
export type ContextKey = { key: string; doc: string };
export const CONTEXT_KEYS: readonly ContextKey[] = [
  { key: "overlayOpen", doc: "The palette, the spaces overview or a modal sheet is up, and owns the keyboard." },
  { key: "paletteOpen", doc: "The command palette is open." },
  { key: "spacesOpen", doc: "The all-spaces overview is open." },
  { key: "sheetOpen", doc: "A modal sheet is open." },
  // `inputFocus` and `terminalFocus` are mutually exclusive by construction, and that is deliberate:
  // a focused terminal is not an "input" for guard purposes, or a terminal pane would dead-key every
  // global chord in the app. See `keyContext` in the renderer's keys/ adapter.
  { key: "inputFocus", doc: "A text field, textarea or rich-text editor has focus." },
  { key: "terminalFocus", doc: "A terminal pane has focus." },
  { key: "paneFocus", doc: "The focused pane holds an item." },
  { key: "sessionFocus", doc: "The focused pane holds an agent session." },
  { key: "sessionRunning", doc: "The focused session's agent is mid-turn." },
];

/**
 * Every command a keystroke can be bound to — the catalog, not a gate (rule 3).
 *
 * `KEY_COMMANDS` rather than `COMMANDS` because this package already has a different notion of a
 * command: `./commands` holds the user-written `/slash` templates, and one generic name across the
 * barrel export would leave callers importing whichever one they did not mean.
 *
 * Derived from what the app actually does today: the window-level bindings in
 * `renderer/src/hotkeys.ts` and the one-shot rows in `renderer/src/components/CommandPalette.tsx`.
 * Every id here has a runner in `renderer/src/keys/commands.ts`; a catalog entry with nothing behind
 * it would be a shortcut a user could set and then watch do nothing, which is the honesty rule
 * applied to a settings list.
 */
export type KeyCommand = { id: string; label: string; group: "Panes" | "Spaces" | "Sessions" | "App" };

/** ⌘1…⌘9 pick the nth space of the ACTIVE PROFILE, so there are nine ids rather than one command
 *  with an argument — a rule is `{key, command, when}` and has nowhere to carry the number. */
const SPACE_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

export const KEY_COMMANDS: readonly KeyCommand[] = [
  { id: "pane.splitRight", label: "Split right", group: "Panes" },
  { id: "pane.splitDown", label: "Split down", group: "Panes" },
  { id: "pane.close", label: "Close pane", group: "Panes" },
  { id: "pane.toggleFocus", label: "Focus pane full-screen", group: "Panes" },
  { id: "pane.focusLeft", label: "Focus the pane to the left", group: "Panes" },
  { id: "pane.focusRight", label: "Focus the pane to the right", group: "Panes" },
  { id: "pane.focusUp", label: "Focus the pane above", group: "Panes" },
  { id: "pane.focusDown", label: "Focus the pane below", group: "Panes" },
  { id: "pane.navBack", label: "Back in this pane", group: "Panes" },
  { id: "pane.navForward", label: "Forward in this pane", group: "Panes" },
  { id: "pane.rename", label: "Rename the focused pane", group: "Panes" },
  { id: "paneGroup.next", label: "Next pane group", group: "Panes" },
  { id: "paneGroup.previous", label: "Previous pane group", group: "Panes" },
  { id: "paneGroup.new", label: "New pane group", group: "Panes" },

  { id: "space.next", label: "Next space", group: "Spaces" },
  { id: "space.previous", label: "Previous space", group: "Spaces" },
  ...SPACE_SLOTS.map((n): KeyCommand => ({ id: `space.select.${n}`, label: `Switch to space ${n}`, group: "Spaces" })),
  { id: "space.open", label: "Open this space", group: "Spaces" },
  { id: "spaces.toggle", label: "All spaces", group: "Spaces" },

  { id: "session.new", label: "New session", group: "Sessions" },
  { id: "session.newInWorktree", label: "New session in a worktree", group: "Sessions" },
  { id: "session.attachFiles", label: "Add files to this session", group: "Sessions" },
  { id: "session.dispatchDraft", label: "Dispatch the draft", group: "Sessions" },
  { id: "session.interrupt", label: "Interrupt the running session", group: "Sessions" },
  { id: "terminal.toggle", label: "Show/hide this session's terminal", group: "Sessions" },

  { id: "terminal.new", label: "New terminal", group: "App" },
  { id: "browser.new", label: "New browser", group: "App" },
  { id: "machine.connect", label: "Connect a machine", group: "App" },
  { id: "documents.open", label: "Documents", group: "App" },
  /* `diff.open`, not `diff.toggle`: the action opens-or-focuses the diff pane and has no gesture
     that closes it, so a `toggle` id would name a round trip the app does not have. */
  { id: "diff.open", label: "Show changes", group: "App" },
  { id: "palette.toggle", label: "Command palette", group: "App" },
  { id: "palette.files", label: "Open a file", group: "App" },
  { id: "palette.grep", label: "Find in files", group: "App" },
  { id: "sidebar.toggle", label: "Show/hide the sidebar", group: "App" },
  { id: "activity.open", label: "MCP Activity", group: "App" },
];

/**
 * The guard the old hardcoded layer applied to almost everything, now said out loud.
 *
 * `!overlayOpen` is "an overlay owns the keyboard"; `!inputFocus` is "you are typing". Written as
 * negations of the unusual state so that the empty context — nothing special is happening — reads
 * true, which is what makes `chordsForCommand` usable for menu hints without inventing a fake state.
 */
const WHEN_IDLE = "!overlayOpen && !inputFocus";

/**
 * What Realm ships, seeded into the user's file on first run.
 *
 * Every chord here is the one that key already ran before this layer existed (`hotkeys.ts`,
 * `usePaletteHotkey`, `useSpacesHotkey`), so making shortcuts rebindable rebinds nothing by accident.
 * The clauses are the same guard those handlers applied, spelled as conditions instead of as flags:
 *
 *  - `WHEN_IDLE` is the old default — no overlay, not typing.
 *  - `!overlayOpen && sessionFocus` is the old `inInputs: true`: ⌘U and ⌘J and ⌘⇧↩ have to fire FROM
 *    the composer, which is an editable target, and none of them types anything there.
 *  - `palette.toggle` and `spaces.toggle` are guarded on `!sheetOpen` alone, because each must fire
 *    while its own overlay is up (that is what makes them toggles) and must not while a modal sheet
 *    has the keyboard.
 */
export const DEFAULT_KEYBINDINGS: readonly Keybinding[] = [
  { key: "mod+k", command: "palette.toggle", when: "!sheetOpen" },
  /* The palette's two narrowings. Guarded on `!sheetOpen` like the palette itself, and deliberately
     NOT on `!inputFocus`: ⌘P has to work while the palette's own search box has the keyboard, which
     is how someone switches from "find in files" to "open a file" without reaching for the mouse.

     ⌘⇧P, and NOT the ⌘⇧F other editors use for find-in-files, because ⌘⇧F is already
     `pane.toggleFocus` below. Two defaults on one chord is not a tie — the later rule wins — so
     shipping it there would have quietly killed one of them, and taking it from `pane.toggleFocus`
     would be a regression for everyone who already uses it. ⌘P/⌘⇧P is the pair that costs nobody
     anything. ⌘F is left unbound for the same family of reason: inside the code editor it is that
     editor's own find, and a global rule would take it from the pane that needs it most. */
  { key: "mod+p", command: "palette.files", when: "!sheetOpen" },
  { key: "mod+shift+p", command: "palette.grep", when: "!sheetOpen" },
  { key: "mod+shift+space", command: "spaces.toggle", when: "!sheetOpen" },
  { key: "mod+b", command: "sidebar.toggle", when: WHEN_IDLE },

  { key: "mod+\\", command: "pane.splitRight", when: WHEN_IDLE },
  { key: "mod+shift+\\", command: "pane.splitDown", when: WHEN_IDLE },
  { key: "mod+w", command: "pane.close", when: WHEN_IDLE },
  { key: "mod+shift+f", command: "pane.toggleFocus", when: WHEN_IDLE },
  { key: "mod+alt+left", command: "pane.focusLeft", when: WHEN_IDLE },
  { key: "mod+alt+right", command: "pane.focusRight", when: WHEN_IDLE },
  { key: "mod+alt+up", command: "pane.focusUp", when: WHEN_IDLE },
  { key: "mod+alt+down", command: "pane.focusDown", when: WHEN_IDLE },
  { key: "mod+[", command: "pane.navBack", when: WHEN_IDLE },
  { key: "mod+]", command: "pane.navForward", when: WHEN_IDLE },
  { key: "mod+shift+[", command: "paneGroup.previous", when: WHEN_IDLE },
  { key: "mod+shift+]", command: "paneGroup.next", when: WHEN_IDLE },

  { key: "ctrl+tab", command: "space.next", when: WHEN_IDLE },
  { key: "ctrl+shift+tab", command: "space.previous", when: WHEN_IDLE },
  ...SPACE_SLOTS.map((n): Keybinding => ({ key: `mod+${n}`, command: `space.select.${n}`, when: WHEN_IDLE })),

  { key: "mod+t", command: "terminal.new", when: WHEN_IDLE },
  { key: "mod+n", command: "session.new", when: WHEN_IDLE },
  { key: "mod+u", command: "session.attachFiles", when: "!overlayOpen && sessionFocus" },
  { key: "mod+j", command: "terminal.toggle", when: "!overlayOpen && sessionFocus" },
  { key: "mod+shift+enter", command: "session.dispatchDraft", when: "!overlayOpen && sessionFocus" },
  { key: "escape", command: "session.interrupt", when: "!overlayOpen && sessionRunning" },
];

/**
 * Chords Realm swallows whether or not a rule fires.
 *
 * ⌘W alone, and for a reason no `when` clause can express: with no application menu of Realm's own,
 * Electron installs its default one, whose File → Close Window carries this accelerator. Realm ships
 * a menu without that item (`apps/desktop/src/main/index.ts`), so this is belt and braces — but the
 * asymmetry of the two failures decides it. A swallowed keystroke is a dead key, noticed and
 * recovered from in a second; a ⌘W that reaches Electron closes the window out from under a running
 * agent. When the guard refuses the action, the key is still eaten.
 */
export const ALWAYS_SWALLOWED_CHORDS: readonly string[] = ["mod+w"];

/**
 * Whether a shipped default is claimed by something already in the user's file.
 *
 * The merge rule, and the reason it is by COMMAND **or** by KEY rather than by both: a user who
 * moved `palette.toggle` to ⌘P has claimed the command, and a user who put something else on ⌘K has
 * claimed the key. Either one means re-seeding the default would put a binding back that fights a
 * choice they made. Requiring both would do exactly that in each of those cases, which is the whole
 * failure this rule exists to prevent.
 *
 * Deleting a default's line outright is NOT a claim, and must not be: the file is also what a fresh
 * install writes, so "absent" cannot mean "removed on purpose". Unbinding — `{ key, command: "" }` —
 * claims the key and is the spelling that makes a removal stick.
 */
export function defaultIsClaimed(existing: readonly Keybinding[], shipped: Keybinding): boolean {
  const key = normalizeKeyChord(shipped.key);
  return existing.some((rule) => rule.command === shipped.command || (key !== null && normalizeKeyChord(rule.key) === key));
}

/**
 * The user's rules plus any shipped default nothing in them claims, appended.
 *
 * Appended rather than prepended, and the ordering is load-bearing under rule 2: a rule at the end
 * wins, so a new default placed there could defeat something the user wrote — except that a default
 * whose key is claimed is never added at all, so there is nothing of theirs for it to defeat.
 * Appending also leaves every existing rule at its index, which keeps the precedence the user has
 * already tuned exactly where they left it.
 */
export function mergeDefaults(existing: readonly Keybinding[], defaults: readonly Keybinding[] = DEFAULT_KEYBINDINGS): Keybinding[] {
  const merged = [...existing];
  for (const shipped of defaults) {
    if (!defaultIsClaimed(merged, shipped)) merged.push(shipped);
  }
  return merged;
}
