import type { z } from "zod";
import type { BrowserAction } from "./browser-agent";

/**
 * A key an agent asks `browser_act` or `app_act` to press — `"Enter"`, `"Meta+a"`, `"Shift+Tab"`,
 * `"F5"`, a single `"a"` — turned into what Chrome's input domain needs to press it the way a keyboard
 * would: the key, its physical code, the Windows virtual key code, the modifier bits, the text it
 * types (none while ⌘ or ⌃ is held: a shortcut types nothing), and on macOS the editing command it
 * triggers.
 *
 * The commands are the part that is easy to miss. A synthetic ⌘A reaches the page as a keydown with
 * `metaKey` set and nothing else happens: on macOS, select-all is not the key, it is the menu's
 * `selectAll:` command, which a real keystroke reaches through the responder chain and a CDP event
 * never does. Chrome takes the command name beside the event (`commands`) for exactly this.
 *
 * Here rather than in Electron main because the server refuses a key it cannot press BEFORE the
 * permission card — asking the user to approve "press Hyper+Q" and then failing would be a card
 * approved for nothing.
 */

export const KEY_MODIFIERS = ["alt", "ctrl", "meta", "shift"] as const;
export type KeyModifier = (typeof KEY_MODIFIERS)[number];
const MODIFIER_BITS: Record<KeyModifier, number> = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
const MODIFIER_KEYS: Record<KeyModifier, { key: string; code: string; vk: number }> = {
  alt: { key: "Alt", code: "AltLeft", vk: 18 },
  ctrl: { key: "Control", code: "ControlLeft", vk: 17 },
  meta: { key: "Meta", code: "MetaLeft", vk: 91 },
  shift: { key: "Shift", code: "ShiftLeft", vk: 16 },
};
const MODIFIER_NAMES: Record<string, KeyModifier> = {
  meta: "meta", cmd: "meta", command: "meta", "⌘": "meta", super: "meta",
  ctrl: "ctrl", control: "ctrl", "⌃": "ctrl",
  alt: "alt", option: "alt", opt: "alt", "⌥": "alt",
  shift: "shift", "⇧": "shift",
};

/** Named keys — key, code, and Windows virtual key code (frameworks key off one of these three; sending
 *  all three is what makes a synthetic key indistinguishable). */
export const NAMED_KEYS: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", vk: 9 },
  Escape: { key: "Escape", code: "Escape", vk: 27 },
  Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  Delete: { key: "Delete", code: "Delete", vk: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  Home: { key: "Home", code: "Home", vk: 36 },
  End: { key: "End", code: "End", vk: 35 },
  PageUp: { key: "PageUp", code: "PageUp", vk: 33 },
  PageDown: { key: "PageDown", code: "PageDown", vk: 34 },
  Space: { key: " ", code: "Space", vk: 32, text: " " },
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, { key: `F${i + 1}`, code: `F${i + 1}`, vk: 112 + i }])),
};
const KEY_ALIASES: Record<string, string> = { esc: "Escape", return: "Enter", del: "Delete", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", " ": "Space", spacebar: "Space" };
const NAMED_LOWER = new Map(Object.keys(NAMED_KEYS).map((k) => [k.toLowerCase(), k]));

/** The punctuation of a US keyboard: physical code, virtual key code, and what it types under ⇧. */
const PUNCTUATION: Record<string, { code: string; vk: number; shifted: string }> = {
  "-": { code: "Minus", vk: 189, shifted: "_" }, "=": { code: "Equal", vk: 187, shifted: "+" },
  "[": { code: "BracketLeft", vk: 219, shifted: "{" }, "]": { code: "BracketRight", vk: 221, shifted: "}" },
  "\\": { code: "Backslash", vk: 220, shifted: "|" }, ";": { code: "Semicolon", vk: 186, shifted: ":" },
  "'": { code: "Quote", vk: 222, shifted: "\"" }, ",": { code: "Comma", vk: 188, shifted: "<" },
  ".": { code: "Period", vk: 190, shifted: ">" }, "/": { code: "Slash", vk: 191, shifted: "?" },
  "`": { code: "Backquote", vk: 192, shifted: "~" },
};

/** macOS editing commands for the chords that are menu commands rather than keys. Keyed by the chord
 *  as `describeChord` spells it. */
const MAC_COMMANDS: Record<string, string> = {
  "Meta+a": "selectAll", "Meta+c": "copy", "Meta+x": "cut", "Meta+v": "paste", "Meta+z": "undo", "Shift+Meta+z": "redo",
  "Meta+ArrowLeft": "moveToBeginningOfLine", "Meta+ArrowRight": "moveToEndOfLine",
  "Meta+ArrowUp": "moveToBeginningOfDocument", "Meta+ArrowDown": "moveToEndOfDocument",
  "Shift+Meta+ArrowLeft": "moveToBeginningOfLineAndModifySelection", "Shift+Meta+ArrowRight": "moveToEndOfLineAndModifySelection",
  "Shift+Meta+ArrowUp": "moveToBeginningOfDocumentAndModifySelection", "Shift+Meta+ArrowDown": "moveToEndOfDocumentAndModifySelection",
  "Alt+ArrowLeft": "moveWordLeft", "Alt+ArrowRight": "moveWordRight",
  "Shift+Alt+ArrowLeft": "moveWordLeftAndModifySelection", "Shift+Alt+ArrowRight": "moveWordRightAndModifySelection",
  "Alt+Backspace": "deleteWordBackward", "Meta+Backspace": "deleteToBeginningOfLine",
};

export type KeyPress = {
  key: string; code: string; vk: number;
  /** What the press types, or absent for a key or shortcut that types nothing. */
  text?: string;
  modifiers: KeyModifier[];
  /** The CDP modifier bits: alt 1, ctrl 2, meta 4, shift 8. */
  bits: number;
  /** macOS editing commands the chord triggers (`selectAll` for ⌘A). */
  commands: string[];
  /** The chord as the result and the permission card say it: "Meta+a", "Shift+Tab". */
  label: string;
};

const ORDER: KeyModifier[] = ["ctrl", "shift", "alt", "meta"];
const MOD_LABEL: Record<KeyModifier, string> = { ctrl: "Control", shift: "Shift", alt: "Alt", meta: "Meta" };

/**
 * `key` — a named key, F1–F12, one character, or any of those after modifiers joined by `+`
 * (`"Meta+Shift+z"`, `"Cmd+A"`) — plus `modifiers` given beside it, as one chord; or why not.
 */
export function resolveKeyChord(key: string, modifiers: readonly KeyModifier[] = []): { ok: true; chord: KeyPress } | { ok: false; error: string } {
  const parts = key === "+" ? ["+"] : key.endsWith("++") ? [...key.slice(0, -2).split("+"), "+"] : key.split("+");
  const base = parts.pop() ?? "";
  const mods = new Set<KeyModifier>(modifiers);
  for (const p of parts) {
    const m = MODIFIER_NAMES[p.trim().toLowerCase()];
    if (!m) return { ok: false, error: `"${p}" in "${key}" is not a modifier — use Meta (⌘), Control, Alt (⌥) or Shift, joined with "+": "Meta+a", "Shift+Tab"` };
    mods.add(m);
  }
  const ordered = ORDER.filter((m) => mods.has(m));
  const bits = ordered.reduce((acc, m) => acc | MODIFIER_BITS[m], 0);
  const shortcut = mods.has("meta") || mods.has("ctrl");

  let k: { key: string; code: string; vk: number; text?: string };
  const named = NAMED_LOWER.get(base.toLowerCase()) ?? KEY_ALIASES[base.toLowerCase()] ?? KEY_ALIASES[base];
  if (base.length > 1 || named) {
    if (!named) return { ok: false, error: `unknown key "${base}" — press a named key (${Object.keys(NAMED_KEYS).filter((n) => !/^F\d/.test(n)).join(", ")}, F1–F12), or one character, with modifiers if any: "Meta+a", "Shift+Tab", "F5". To go back or forward a page, use browser_navigate.` };
    k = NAMED_KEYS[named]!;
  } else if (/^[a-z]$/i.test(base)) {
    const upper = base.toUpperCase();
    const lower = base.toLowerCase();
    // A letter is one physical key: the character it types is its case under ⇧, never the case it was
    // written in — "Meta+A" is ⌘A, not ⌘⇧A.
    k = { key: mods.has("shift") ? upper : lower, code: `Key${upper}`, vk: upper.charCodeAt(0), text: mods.has("shift") ? upper : lower };
  } else if (/^[0-9]$/.test(base)) {
    k = { key: base, code: `Digit${base}`, vk: base.charCodeAt(0), text: base };
  } else if (PUNCTUATION[base]) {
    const p = PUNCTUATION[base]!;
    const typed = mods.has("shift") ? p.shifted : base;
    k = { key: typed, code: p.code, vk: p.vk, text: typed };
  } else {
    return { ok: false, error: `cannot press "${base}" as a key — a character outside a US keyboard is typed, not pressed: use {kind:'type'} for it` };
  }

  const label = [...ordered.map((m) => MOD_LABEL[m]), named ?? (k.key.length === 1 ? k.key.toLowerCase() : k.key)].join("+");
  const text = shortcut ? undefined : k.text;
  const command = MAC_COMMANDS[label];
  return { ok: true, chord: { key: k.key, code: k.code, vk: k.vk, ...(text !== undefined ? { text } : {}), modifiers: ordered, bits, commands: command ? [command] : [], label } };
}

/** The keydown/keyup events that press `c`: each modifier down in turn, the key, then the modifiers up
 *  in reverse — what a keyboard sends, so a page reading the modifier keys' own events sees them too. */
export function chordKeyEvents(c: KeyPress): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let held = 0;
  for (const m of c.modifiers) {
    held |= MODIFIER_BITS[m];
    const mk = MODIFIER_KEYS[m];
    out.push({ type: "rawKeyDown", key: mk.key, code: mk.code, windowsVirtualKeyCode: mk.vk, nativeVirtualKeyCode: mk.vk, modifiers: held });
  }
  out.push({
    type: c.text !== undefined ? "keyDown" : "rawKeyDown", key: c.key, code: c.code, windowsVirtualKeyCode: c.vk, nativeVirtualKeyCode: c.vk, modifiers: c.bits,
    ...(c.text !== undefined ? { text: c.text, unmodifiedText: c.text } : {}),
    ...(c.commands.length ? { commands: c.commands } : {}),
  });
  out.push({ type: "keyUp", key: c.key, code: c.code, windowsVirtualKeyCode: c.vk, nativeVirtualKeyCode: c.vk, modifiers: c.bits });
  for (const m of [...c.modifiers].reverse()) {
    held &= ~MODIFIER_BITS[m];
    const mk = MODIFIER_KEYS[m];
    out.push({ type: "keyUp", key: mk.key, code: mk.code, windowsVirtualKeyCode: mk.vk, nativeVirtualKeyCode: mk.vk, modifiers: held });
  }
  return out;
}

/** A Zod refinement for any arguments carrying a `BrowserAction`: a key it cannot press is an invalid
 *  argument, refused like any other before the permission card. */
export function refineKeyAction(args: { action: BrowserAction }, ctx: z.RefinementCtx): void {
  const a = args.action;
  if (a.kind !== "key") return;
  const r = resolveKeyChord(a.key, a.modifiers);
  if (!r.ok) ctx.addIssue({ code: "custom", path: ["action", "key"], message: r.error });
}
