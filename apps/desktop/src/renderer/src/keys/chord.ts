import { formatKeyChord, parseKeyChord } from "@realm/contracts";

/**
 * A keyboard event → the canonical chord string the resolver matches on.
 *
 * Pure, and in its own file so it is testable without a DOM: everything it needs off an event is the
 * five fields below, which a React `KeyboardEvent` and a native one both have.
 *
 * **It reads `code`, not `key`, and that is the whole point of the file.** `KeyboardEvent.key` is
 * what the keystroke PRODUCED — it changes under shift and under option. On a US layout ⌘⇧\ arrives
 * with `key === "|"`, ⌘⇧[ with `"{"`, ⌘⇧1 with `"!"`, and ⌥⌘K with `"˚"`. The old hardcoded layer
 * worked around this by matching both spellings per binding (`e.key === "\\" || e.key === "|"`),
 * which is a workaround that has to be remembered once per binding forever — and a user's
 * `keybindings.json` has no way to write it at all. `code` is the physical key, unchanged by every
 * modifier, so `mod+shift+\` in the file is the chord the hand actually makes.
 *
 * The cost, stated because it is real: `code` names the key's US-layout POSITION, so on a French
 * layout `mod+\` is wherever the US backslash sits rather than wherever the glyph is printed. That
 * is VS Code's own default (`keyboard.dispatch: code`) and it is the deterministic half of the
 * trade — the alternative makes the same file mean different chords on two machines.
 *
 * `key` is still the fallback, for events that carry no `code`: a synthesised one, and anything the
 * platform reports without a physical key behind it.
 */
export type KeyEventLike = {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

/** Physical keys whose canonical name is not derivable from the code's shape. The punctuation is the
 *  US-layout legend, which is what `code` names. */
const CODE_KEYS: Readonly<Record<string, string>> = {
  Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
  Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/",
  Escape: "escape", Tab: "tab", Space: "space", Backspace: "backspace", Delete: "delete",
  // The numeric keypad's Enter is Enter — no app on this platform distinguishes them, and a user who
  // bound ⌘↩ and then pressed the one on the keypad would just find their shortcut missing.
  Enter: "enter", NumpadEnter: "enter",
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown",
};

/** The canonical key name for a physical code, or null when this adapter has no name for it — which
 *  includes every modifier key, so holding ⇧ alone produces no chord. */
function keyFromCode(code: string): string | null {
  const named = CODE_KEYS[code];
  if (named) return named;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1]!.toLowerCase();
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1]!;
  const fn = /^F(\d{1,2})$/.exec(code);
  if (fn) return `f${Number(fn[1])}`;
  return null;
}

/**
 * The chord this keystroke is, or null when it is not one.
 *
 * Null for a bare modifier press: ⇧ on its own is not a keystroke anyone can bind, and reporting one
 * would fire a `when`-guarded lookup on every modifier the user touches.
 */
export function chordFromEvent(e: KeyEventLike): string | null {
  const key = keyNameFor(e);
  if (key === null) return null;
  return formatKeyChord({ mod: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, key });
}

function keyNameFor(e: KeyEventLike): string | null {
  const physical = e.code ? keyFromCode(e.code) : null;
  if (physical !== null) return physical;
  // Space's `key` is a single space, which the chord parser strips as whitespace — so it is named
  // here rather than lost.
  if (e.key === " ") return "space";
  /* The fallback goes through the file's own parser, so the names an event reports (`ArrowUp`,
     `Escape`) and the names a user writes (`up`, `escape`) canonicalise through one table instead of
     two that can drift. It also rejects the modifier names for free: `parseKeyChord("Shift")` is null,
     because a modifier alone is not a chord. */
  return parseKeyChord(e.key)?.key ?? null;
}
