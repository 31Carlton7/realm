import { describe, expect, it } from "vitest";
import { CARET_ANIMATIONS, CARET_COPY, CARET_DEFAULT, CARET_SHAPES, parseCaretPrefs } from "./caret";
import { terminalCaretShape } from "./terminals";

describe("parseCaretPrefs", () => {
  it("is the default for a home that has never said anything", () => {
    expect(parseCaretPrefs(null)).toEqual(CARET_DEFAULT);
    expect(parseCaretPrefs(undefined)).toEqual(CARET_DEFAULT);
    expect(CARET_DEFAULT).toEqual({ shape: "line", animation: "blink", glide: false, colour: "accent" });
  });

  it("keeps every field it knows and defaults only the one it does not", () => {
    /* THE all-or-nothing mutant: throw the whole preference away when one word is unfamiliar. A newer
       build that adds a shape would then reset the animation, the glide and the colour of everyone
       who opens an older one — three settings lost for one this build cannot draw. */
    expect(parseCaretPrefs({ shape: "triangle", animation: "pulse", glide: true, colour: "text" }))
      .toEqual({ shape: "line", animation: "pulse", glide: true, colour: "text" });
    expect(parseCaretPrefs({ shape: "block-outline", animation: "strobe", glide: "yes", colour: "red" }))
      .toEqual({ shape: "block-outline", animation: "blink", glide: false, colour: "accent" });
    expect(parseCaretPrefs("block")).toEqual(CARET_DEFAULT);
  });

  it("carries the code editor's old blink switch into the animation, only where nothing newer was stored", () => {
    /* The editor's switch was the one caret anybody could stop, and someone who stopped it asked for
       a caret that holds still. THE ignored-history mutant starts them blinking again on upgrade;
       THE sticky-history mutant lets the old key overrule a choice made since. */
    expect(parseCaretPrefs(null, { editorBlink: false }).animation).toBe("solid");
    expect(parseCaretPrefs(null, { editorBlink: true }).animation).toBe("blink");
    expect(parseCaretPrefs(null, { editorBlink: null }).animation).toBe("blink");
    expect(parseCaretPrefs({ animation: "smooth" }, { editorBlink: false }).animation).toBe("smooth");
    // A stored preference is the answer even where it says nothing about the animation.
    expect(parseCaretPrefs({ shape: "pill" }, { editorBlink: false }).animation).toBe("blink");
  });
});

describe("terminalCaretShape", () => {
  it("reads xterm's old words as the shapes they were, and anything else as a block", () => {
    // THE renamed-word mutant: a terminal set to a bar comes back a block, because `bar` stopped
    // being a word the key holds.
    expect(terminalCaretShape("bar")).toBe("line");
    expect(terminalCaretShape("underline")).toBe("underline");
    expect(terminalCaretShape("block")).toBe("block");
    expect(terminalCaretShape("pill")).toBe("pill");
    expect(terminalCaretShape("beam-me-up")).toBe("block");
    expect(terminalCaretShape(null)).toBe("block");
  });
});

describe("the copy", () => {
  it("names every shape and every animation it offers, VS Code's six and five included", () => {
    expect(Object.keys(CARET_COPY.shape.options)).toEqual([...CARET_SHAPES]);
    expect(Object.keys(CARET_COPY.animation.options)).toEqual([...CARET_ANIMATIONS]);
    for (const vscode of ["line", "line-thin", "block", "block-outline", "underline", "underline-thin"]) expect(CARET_SHAPES).toContain(vscode);
    for (const vscode of ["blink", "smooth", "phase", "expand", "solid"]) expect(CARET_ANIMATIONS).toContain(vscode);
  });
});
