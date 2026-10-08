import { describe, expect, it } from "vitest";
import { chordKeyEvents, resolveKeyChord } from "./key-chord";

const press = (key: string, modifiers: ("alt" | "ctrl" | "meta" | "shift")[] = []) => {
  const r = resolveKeyChord(key, modifiers);
  if (!r.ok) throw new Error(r.error);
  return r.chord;
};
const refusal = (key: string) => { const r = resolveKeyChord(key); return r.ok ? null : r.error; };

describe("a key an agent asks to press", () => {
  it("presses the chords the call log refused: Meta+a, Meta+b, Shift+Tab, F5, a", () => {
    expect(press("Meta+a")).toMatchObject({ key: "a", code: "KeyA", vk: 65, bits: 4, commands: ["selectAll"], label: "Meta+a" });
    // A shortcut types nothing — or ⌘A would select all and then type an "a" over it.
    expect(press("Meta+a").text).toBeUndefined();
    expect(press("Meta+b")).toMatchObject({ code: "KeyB", bits: 4, commands: [] });
    expect(press("Shift+Tab")).toMatchObject({ key: "Tab", code: "Tab", vk: 9, bits: 8, label: "Shift+Tab" });
    expect(press("F5")).toMatchObject({ key: "F5", code: "F5", vk: 116, bits: 0 });
    expect(press("a")).toMatchObject({ key: "a", code: "KeyA", text: "a", bits: 0 });
  });

  it("reads modifiers written or given, in any spelling, and a letter's case as the key it is", () => {
    expect(press("Cmd+A").label).toBe("Meta+a");
    expect(press("a", ["meta"]).commands).toEqual(["selectAll"]);
    expect(press("command+shift+z")).toMatchObject({ bits: 12, commands: ["redo"], label: "Shift+Meta+z" });
    expect(press("Shift+a")).toMatchObject({ key: "A", text: "A" });
    expect(press("Shift+1")).toMatchObject({ code: "Digit1", text: "1" });
    expect(press("Shift+/")).toMatchObject({ key: "?", code: "Slash", text: "?" });
    expect(press("Ctrl+Enter")).toMatchObject({ key: "Enter", bits: 2 });
    expect(press("Ctrl+Enter").text).toBeUndefined();
    expect(press("esc").key).toBe("Escape");
    expect(press("Enter").text).toBe("\r");
  });

  it("refuses what it cannot press, and says what to do instead", () => {
    expect(refusal("Hyper+q")).toContain(`"Hyper" in "Hyper+q" is not a modifier`);
    expect(refusal("BrowserBack")).toContain("use browser_navigate");
    expect(refusal("é")).toContain("use {kind:'type'}");
  });

  it("goes down and up the way a keyboard does: modifiers first, the key, modifiers last", () => {
    const evs = chordKeyEvents(press("Shift+Meta+z"));
    expect(evs.map((e) => `${e.type} ${e.key} ${e.modifiers}`)).toEqual([
      "rawKeyDown Shift 8", "rawKeyDown Meta 12", "rawKeyDown Z 12", "keyUp Z 12", "keyUp Meta 8", "keyUp Shift 0",
    ]);
    expect(evs[2]).toMatchObject({ commands: ["redo"] });
    const typed = chordKeyEvents(press("a"));
    expect(typed[0]).toMatchObject({ type: "keyDown", text: "a" });
  });
});
