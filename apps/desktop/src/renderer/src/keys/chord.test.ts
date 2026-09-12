import { describe, expect, it } from "vitest";
import { DEFAULT_KEYBINDINGS, normalizeKeyChord } from "@realm/contracts";
import { chordFromEvent, type KeyEventLike } from "./chord";

const press = (over: Partial<KeyEventLike> & { key: string }): KeyEventLike =>
  ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });

describe("chordFromEvent", () => {
  it("reads the physical key, so shift does not change which chord this is", () => {
    /* THE MUTANT: use `e.key`. On a US layout ⌘⇧\ arrives as "|", ⌘⇧[ as "{" and ⌘⇧1 as "!", so
       every shifted default in the file would simply never fire — and the user has no way to write
       "|" in a rule that also means "\". This is the bug the old layer worked around one binding at
       a time (`e.key === "\\" || e.key === "|"`). */
    expect(chordFromEvent(press({ code: "Backslash", key: "|", metaKey: true, shiftKey: true }))).toBe("mod+shift+\\");
    expect(chordFromEvent(press({ code: "Backslash", key: "\\", metaKey: true }))).toBe("mod+\\");
    expect(chordFromEvent(press({ code: "BracketLeft", key: "{", metaKey: true, shiftKey: true }))).toBe("mod+shift+[");
    expect(chordFromEvent(press({ code: "Digit1", key: "!", shiftKey: true }))).toBe("shift+1");
  });

  it("reads the physical key through option, which rewrites e.key on macOS", () => {
    // ⌥⌘K reports key "˚" — a chord matched on `key` would be unbindable and unwritable.
    expect(chordFromEvent(press({ code: "KeyK", key: "˚", metaKey: true, altKey: true }))).toBe("mod+alt+k");
  });

  it("maps ⌘ onto mod and leaves ⌃ as itself", () => {
    // Realm runs on macOS, where these are two different keys. ⌃K is emacs kill-line in every AppKit
    // text field, so it is NOT a second spelling of ⌘K here.
    expect(chordFromEvent(press({ code: "KeyK", key: "k", metaKey: true }))).toBe("mod+k");
    expect(chordFromEvent(press({ code: "KeyK", key: "k", ctrlKey: true }))).toBe("ctrl+k");
  });

  it("names the keys the shipped defaults use", () => {
    expect(chordFromEvent(press({ code: "Escape", key: "Escape" }))).toBe("escape");
    expect(chordFromEvent(press({ code: "Tab", key: "Tab", ctrlKey: true, shiftKey: true }))).toBe("ctrl+shift+tab");
    expect(chordFromEvent(press({ code: "Space", key: " ", metaKey: true, shiftKey: true }))).toBe("mod+shift+space");
    expect(chordFromEvent(press({ code: "Enter", key: "Enter", metaKey: true, shiftKey: true }))).toBe("mod+shift+enter");
    expect(chordFromEvent(press({ code: "ArrowUp", key: "ArrowUp", metaKey: true, altKey: true }))).toBe("mod+alt+up");
    expect(chordFromEvent(press({ code: "F12", key: "F12" }))).toBe("f12");
    // The keypad's Enter is Enter: a user who bound ⌘↩ and pressed that one must not find it missing.
    expect(chordFromEvent(press({ code: "NumpadEnter", key: "Enter", metaKey: true }))).toBe("mod+enter");
  });

  it("produces nothing for a bare modifier press", () => {
    // THE MUTANT: report a chord here. Every touch of ⇧ would run a resolver pass, and `shift` is a
    // key name no rule can legally hold anyway.
    for (const [code, key] of [["ShiftLeft", "Shift"], ["MetaRight", "Meta"], ["ControlLeft", "Control"], ["AltLeft", "Alt"], ["CapsLock", "CapsLock"]]) {
      expect(chordFromEvent(press({ code, key: key!, shiftKey: true })), code).toBeNull();
    }
  });

  it("falls back to e.key when the event carries no code", () => {
    // Synthesised events (including every one fired by a test that does not name a code).
    expect(chordFromEvent(press({ key: "Escape" }))).toBe("escape");
    expect(chordFromEvent(press({ key: " ", metaKey: true, shiftKey: true }))).toBe("mod+shift+space");
    expect(chordFromEvent(press({ key: "ArrowLeft", metaKey: true, altKey: true }))).toBe("mod+alt+left");
    expect(chordFromEvent(press({ key: "t", metaKey: true }))).toBe("mod+t");
    expect(chordFromEvent(press({ key: "Shift", shiftKey: true }))).toBeNull();
  });

  it("emits chords the file's own parser accepts, in its own spelling", () => {
    /* The round trip that makes the two ends one system: whatever this produces must normalise to
       itself, or a rule could be written that no keystroke ever equals. */
    for (const e of [
      press({ code: "KeyB", key: "b", metaKey: true }),
      press({ code: "Backslash", key: "|", metaKey: true, shiftKey: true }),
      press({ code: "Equal", key: "+", shiftKey: true, ctrlKey: true, altKey: true, metaKey: true }),
    ]) {
      const chord = chordFromEvent(e)!;
      expect(normalizeKeyChord(chord), chord).toBe(chord);
    }
  });

  it("can produce every chord the shipped table binds", () => {
    // THE MUTANT: drop a row from CODE_KEYS — `Space`, say. The default would still be in the file,
    // still read correctly, and the key would do nothing.
    const produced = new Set([
      chordFromEvent(press({ code: "KeyK", key: "k", metaKey: true })),
      chordFromEvent(press({ code: "KeyP", key: "p", metaKey: true })),
      chordFromEvent(press({ code: "KeyP", key: "P", metaKey: true, shiftKey: true })),
      chordFromEvent(press({ code: "Space", key: " ", metaKey: true, shiftKey: true })),
      chordFromEvent(press({ code: "KeyB", key: "b", metaKey: true })),
      chordFromEvent(press({ code: "Backslash", key: "\\", metaKey: true })),
      chordFromEvent(press({ code: "Backslash", key: "|", metaKey: true, shiftKey: true })),
      chordFromEvent(press({ code: "KeyW", key: "w", metaKey: true })),
      chordFromEvent(press({ code: "KeyF", key: "F", metaKey: true, shiftKey: true })),
      chordFromEvent(press({ code: "ArrowLeft", key: "ArrowLeft", metaKey: true, altKey: true })),
      chordFromEvent(press({ code: "ArrowRight", key: "ArrowRight", metaKey: true, altKey: true })),
      chordFromEvent(press({ code: "ArrowUp", key: "ArrowUp", metaKey: true, altKey: true })),
      chordFromEvent(press({ code: "ArrowDown", key: "ArrowDown", metaKey: true, altKey: true })),
      chordFromEvent(press({ code: "BracketLeft", key: "[", metaKey: true })),
      chordFromEvent(press({ code: "BracketRight", key: "]", metaKey: true })),
      chordFromEvent(press({ code: "BracketLeft", key: "{", metaKey: true, shiftKey: true })),
      chordFromEvent(press({ code: "BracketRight", key: "}", metaKey: true, shiftKey: true })),
      chordFromEvent(press({ code: "Tab", key: "Tab", ctrlKey: true })),
      chordFromEvent(press({ code: "Tab", key: "Tab", ctrlKey: true, shiftKey: true })),
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => chordFromEvent(press({ code: `Digit${n}`, key: String(n), metaKey: true }))),
      chordFromEvent(press({ code: "KeyT", key: "t", metaKey: true })),
      chordFromEvent(press({ code: "KeyN", key: "n", metaKey: true })),
      chordFromEvent(press({ code: "KeyU", key: "u", metaKey: true })),
      chordFromEvent(press({ code: "KeyJ", key: "j", metaKey: true })),
      chordFromEvent(press({ code: "Enter", key: "Enter", metaKey: true, shiftKey: true })),
      chordFromEvent(press({ code: "Escape", key: "Escape" })),
    ]);
    for (const rule of DEFAULT_KEYBINDINGS) expect(produced, rule.command).toContain(normalizeKeyChord(rule.key));
  });
});
