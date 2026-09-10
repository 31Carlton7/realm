/**
 * X11 keysyms, which is what RFB speaks (Plan 25 W4).
 *
 * Shared rather than server-side, because both ends need the same numbers: the driver sends
 * `KeyEvent` for an agent, and the pane's Send key ▸ menu (Plan 25 W7) hands the same keysyms to
 * noVNC's `sendKey` for the chords macOS eats before the page ever sees them.
 *
 * The rule for printable characters is the protocol's own and is worth writing down, because it
 * looks like a coincidence: for Latin-1, **the keysym IS the code point** — `a` is 0x61, `£` is
 * 0xA3. Everything above that is `0x01000000 + code point`. So there is no table for text at all,
 * only for the keys that have no character.
 */

/** Keys with no character of their own. Named the way `computer-use.ts`'s chord grammar names them,
 *  so one vocabulary covers driving a Mac and driving a machine. */
export const KEYSYMS: Readonly<Record<string, number>> = {
  Enter: 0xff0d, Return: 0xff0d, Tab: 0xff09, Escape: 0xff1b, Backspace: 0xff08, Delete: 0xffff,
  Space: 0x0020, Insert: 0xff63,
  ArrowLeft: 0xff51, ArrowUp: 0xff52, ArrowRight: 0xff53, ArrowDown: 0xff54,
  Home: 0xff50, End: 0xff57, PageUp: 0xff55, PageDown: 0xff56,
  F1: 0xffbe, F2: 0xffbf, F3: 0xffc0, F4: 0xffc1, F5: 0xffc2, F6: 0xffc3,
  F7: 0xffc4, F8: 0xffc5, F9: 0xffc6, F10: 0xffc7, F11: 0xffc8, F12: 0xffc9,
  // Modifiers, as keys in their own right — a chord holds them down around the key it modifies.
  Shift: 0xffe1, Control: 0xffe3, Alt: 0xffe9, Meta: 0xffeb, Super: 0xffeb,
};

/** The modifier keysyms a chord holds, in the order it holds them. */
export const MODIFIER_KEYSYMS: Readonly<Record<string, number>> = {
  shift: KEYSYMS.Shift!, ctrl: KEYSYMS.Control!, control: KEYSYMS.Control!,
  alt: KEYSYMS.Alt!, option: KEYSYMS.Alt!, meta: KEYSYMS.Meta!, cmd: KEYSYMS.Meta!, command: KEYSYMS.Meta!, super: KEYSYMS.Super!,
};

/**
 * One character → its keysym, or null where the protocol has no way to say it.
 *
 * Null rather than a guess, and this is the honest half of a real limitation: a keysym names a KEY,
 * and which character a key produces is decided by the layout loaded inside the guest — which Realm
 * cannot see. Latin-1 is safe because those keysyms are code points by definition. Beyond it,
 * `0x01000000 + cp` is what the spec says and what modern servers implement, but a server that does
 * not, or a guest on a layout that cannot produce the character, silently types something else.
 * `vm_act`'s `type` refuses rather than risking that — see `agent-tools.ts`.
 */
export function keysymForChar(ch: string): number | null {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return null;
  if (cp === 0x0a || cp === 0x0d) return KEYSYMS.Enter!;
  if (cp === 0x09) return KEYSYMS.Tab!;
  if (cp >= 0x20 && cp <= 0xff) return cp;
  return null;
}

/** Is every character in this string one the protocol can say without guessing? */
export function isTypeable(text: string): boolean {
  for (const ch of text) if (keysymForChar(ch) === null) return false;
  return true;
}

/** The first character that is not, for a refusal that can name it. */
export function firstUntypeable(text: string): string | null {
  for (const ch of text) if (keysymForChar(ch) === null) return ch;
  return null;
}

/**
 * A chord like `cmd+shift+t` → the modifiers to hold and the key to press, or null.
 *
 * The same grammar `parseKeySpec` uses for computer use, on purpose: a person or a model that has
 * learned one should not have to learn a second to drive a machine instead of an app.
 */
export function parseChord(spec: string): { modifiers: number[]; key: number } | null {
  const parts = spec.split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const last = parts.pop()!;
  const modifiers: number[] = [];
  for (const p of parts) {
    const m = MODIFIER_KEYSYMS[p.toLowerCase()];
    if (m === undefined) return null;
    if (!modifiers.includes(m)) modifiers.push(m);
  }
  // A named key first, then a single character. Named wins, so "Space" is the key rather than five
  // letters — the ambiguity only exists for names that are also words, and a caller who wanted the
  // letters can send them as text.
  const named = KEYSYMS[last] ?? KEYSYMS[last.charAt(0).toUpperCase() + last.slice(1)];
  if (named !== undefined) return { modifiers, key: named };
  if ([...last].length !== 1) return null;
  const key = keysymForChar(last);
  return key === null ? null : { modifiers, key };
}

/** The chords the Mac eats before a page ever sees them, for the pane's Send key ▸ menu (W7).
 *  Every one of these is a menu accelerator or a window-server shortcut, so the only way a guest
 *  ever receives one is for Realm to send it deliberately. */
export const PLATFORM_CHORDS: readonly { label: string; chord: string }[] = [
  { label: "⌘Q — Quit", chord: "cmd+q" },
  { label: "⌘W — Close window", chord: "cmd+w" },
  { label: "⌘Tab — Switch app", chord: "cmd+Tab" },
  { label: "⌘Space — Spotlight", chord: "cmd+Space" },
  { label: "⌘H — Hide", chord: "cmd+h" },
  { label: "⌃⌥⌦ — Ctrl+Alt+Delete", chord: "ctrl+alt+Delete" },
];
