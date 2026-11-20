import { parseKeyChord } from "./keybindings";

/**
 * The quick chat panel: a small window that holds the Quick Chat and opens over any app.
 *
 * Its key is a chord in the keymap's own spelling (`ctrl+alt+space`), kept as a setting rather than
 * as a rule in keybindings.json: that file's rules run while a Realm window has the keyboard, and
 * this one is registered with the system so it runs while another app does.
 */
export const QUICK_CHAT_SHORTCUT_KEY = "quickChat.shortcut";
/** ⌃⌥Space. ⌥Space is ChatGPT's, ⌘Space Spotlight's, ⌃Space the input source switch, ⌥⌘Space Finder's. */
export const QUICK_CHAT_SHORTCUT_DEFAULT = "ctrl+alt+space";
/** Whether the panel is left out of screen shares and recordings. On unless it was switched off. */
export const QUICK_CHAT_HIDE_FROM_SHARING_KEY = "quickChat.hideFromScreenSharing";

/** The stored shortcut: a chord, `null` for "no shortcut" (stored as an empty string), or the default
 *  when nothing readable is stored. */
export function quickChatShortcutFrom(stored: unknown): string | null {
  if (stored === "") return null;
  return typeof stored === "string" && acceleratorForChord(stored) !== null ? stored : QUICK_CHAT_SHORTCUT_DEFAULT;
}

/** What the main process has done with the shortcut. `registered` is false when the system refused
 *  it, which is what another app holding the same chord looks like. */
export type QuickChatShortcutState = { chord: string | null; registered: boolean };

const ACCELERATOR_KEYS: Readonly<Record<string, string>> = {
  space: "Space", enter: "Return", tab: "Tab", escape: "Escape", backspace: "Backspace", delete: "Delete",
  up: "Up", down: "Down", left: "Left", right: "Right", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
  "+": "Plus",
};

/** A chord's key as an accelerator names it, or null for one Electron has no name for. */
function acceleratorKey(key: string): string | null {
  const named = ACCELERATOR_KEYS[key];
  if (named) return named;
  if (/^f\d+$/.test(key)) return key.toUpperCase();
  return /^[\x21-\x7e]$/.test(key) ? key.toUpperCase() : null;
}

/**
 * A chord as Electron's `globalShortcut` spells it (`ctrl+alt+space` → `Control+Alt+Space`), or null
 * when it cannot be one. A system-wide key needs a modifier other than Shift: a bare key, or Shift
 * and a key, would be taken away from every app's typing.
 */
export function acceleratorForChord(text: string, platform = "darwin"): string | null {
  const chord = parseKeyChord(text);
  if (chord === null || !(chord.mod || chord.ctrl || chord.alt)) return null;
  const key = acceleratorKey(chord.key);
  if (key === null) return null;
  const mac = platform === "darwin";
  return [
    chord.mod && (mac ? "Command" : "Control"),
    chord.ctrl && (mac ? "Control" : "Super"),
    chord.alt && "Alt",
    chord.shift && "Shift",
    key,
  ].filter(Boolean).join("+");
}
