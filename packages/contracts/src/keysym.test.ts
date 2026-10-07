import { describe, expect, it } from "vitest";
import { KEYSYMS, PLATFORM_CHORDS, firstUntypeable, isTypeable, keysymForChar, parseChord } from "./keysym";

describe("keysyms", () => {
  /* The rule that looks like a coincidence and is the specification: for Latin-1 the keysym IS the
     code point. Getting this wrong by "looking it up" produces a table that is right for ASCII and
     silently wrong for every accented character. */
  it("is the code point itself, for everything Latin-1 can say", () => {
    expect(keysymForChar("a")).toBe(0x61);
    expect(keysymForChar("A")).toBe(0x41);
    expect(keysymForChar(" ")).toBe(0x20);
    expect(keysymForChar("~")).toBe(0x7e);
    expect(keysymForChar("£")).toBe(0xa3);
    expect(keysymForChar("é")).toBe(0xe9);
  });

  it("maps the two characters that mean a key rather than a glyph", () => {
    expect(keysymForChar("\n")).toBe(KEYSYMS.Enter);
    expect(keysymForChar("\t")).toBe(KEYSYMS.Tab);
  });

  /**
   * Null, not a guess, and this is the honest half of a real limitation. A keysym names a KEY, and
   * which character a key produces is decided by the layout loaded inside the guest — which Realm
   * cannot see. `0x01000000 + cp` is what the spec says for the rest, but a server that does not
   * implement it, or a guest on a layout that cannot produce the character, types something else
   * entirely. Silently. `vm_act` refuses instead, which is the Android `input text` trap the
   * capability research already wrote down.
   */
  it("refuses what it cannot say without guessing at the guest's layout", () => {
    expect(keysymForChar("→")).toBeNull();
    expect(keysymForChar("日")).toBeNull();
    expect(keysymForChar("🙂")).toBeNull();
    expect(isTypeable("hello, world")).toBe(true);
    expect(isTypeable("café")).toBe(true);
    expect(isTypeable("naïve → clever")).toBe(false);
    expect(firstUntypeable("naïve → clever")).toBe("→");
    expect(firstUntypeable("plain ascii")).toBeNull();
  });

  it("counts by code point, so an emoji is one refusal rather than two halves", () => {
    expect(firstUntypeable("ok 🙂")).toBe("🙂");
  });
});

describe("chords", () => {
  it("takes the same grammar computer use takes", () => {
    expect(parseChord("cmd+c")).toEqual({ modifiers: [KEYSYMS.Meta], key: 0x63 });
    expect(parseChord("shift+Tab")).toEqual({ modifiers: [KEYSYMS.Shift], key: KEYSYMS.Tab });
    expect(parseChord("ctrl+alt+Delete")).toEqual({ modifiers: [KEYSYMS.Control, KEYSYMS.Alt], key: KEYSYMS.Delete });
    expect(parseChord("Enter")).toEqual({ modifiers: [], key: KEYSYMS.Enter });
  });

  it("treats the Mac's names and X11's as the same modifier", () => {
    expect(parseChord("command+a")).toEqual(parseChord("cmd+a"));
    expect(parseChord("option+a")).toEqual(parseChord("alt+a"));
    expect(parseChord("control+a")).toEqual(parseChord("ctrl+a"));
  });

  it("refuses a chord it cannot make rather than pressing part of one", () => {
    // A half-understood chord is worse than none: `hyper+q` with the modifier dropped is a bare `q`
    // typed into whatever has focus.
    expect(parseChord("hyper+q")).toBeNull();
    expect(parseChord("cmd+not-a-key")).toBeNull();
    expect(parseChord("")).toBeNull();
    expect(parseChord("cmd+→")).toBeNull();
  });

  it("does not double a modifier a caller named twice", () => {
    expect(parseChord("cmd+cmd+a")!.modifiers).toEqual([KEYSYMS.Meta]);
  });

  /* Every chord in the Send key menu has to actually parse — a label with an unparseable chord
     behind it is a menu item that does nothing, which is the one failure a menu cannot explain. */
  it("parses every chord the platform eats", () => {
    for (const { label, chord } of PLATFORM_CHORDS) {
      expect(parseChord(chord), `${label} (${chord})`).not.toBeNull();
    }
    expect(PLATFORM_CHORDS.map((c) => c.chord)).toContain("cmd+q");
  });
});
