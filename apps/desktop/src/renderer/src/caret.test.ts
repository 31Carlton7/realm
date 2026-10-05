import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CARET_DEFAULT, type CaretPrefs } from "@realm/contracts";
import { caretField, installCaret, registerCaretSource, textPoint, type CaretLayer } from "./caret";
import type { CaretSupport } from "./caret-geometry";

/**
 * The layer, against jsdom. jsdom lays nothing out, so where the caret is drawn is checked against
 * geometry the test hands it — a Range over the n-th character of a field's text is 8px wide at
 * 100 + 8n — and against the real window in `caret-live.mjs`. What jsdom CAN answer exactly is the
 * part that matters most: when the field's own caret is switched off, and when it is not.
 */

let layer: CaretLayer | null = null;
let frames: FrameRequestCallback[] = [];
const flush = () => { for (let i = 0; i < 8 && frames.length; i++) { const run = frames; frames = []; for (const f of run) f(0); } };
const NONE: CaretSupport = { shape: false, animation: false };
const install = (over: Partial<CaretPrefs> = {}, support = NONE) => (layer = installCaret(document, { ...CARET_DEFAULT, ...over }, { support }));
const root = document.documentElement;

beforeEach(() => {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { frames.push(cb); return frames.length; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
});
afterEach(() => {
  layer?.uninstall();
  layer = null;
  frames = [];
  document.body.innerHTML = "";
  root.removeAttribute("data-quiet");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const field = (html: string): HTMLElement => {
  document.body.insertAdjacentHTML("beforeend", html);
  return document.body.lastElementChild as HTMLElement;
};
const hidden = (el: Element) => el.hasAttribute("data-rl-caret");

describe("caretField", () => {
  it("stands in for the caret of every field that has one and says where it is", () => {
    for (const type of ["text", "search", "url", "tel", "password"]) expect(caretField(field(`<input type="${type}">`)), type).not.toBeNull();
    expect(caretField(field("<input>"))).not.toBeNull();
    expect(caretField(field("<textarea></textarea>"))).not.toBeNull();
    expect(caretField(field('<div contenteditable="true"></div>'))).not.toBeNull();
  });

  it("leaves the platform's caret where the field has no position to read, and where nothing can be typed", () => {
    // THE every-input mutant: an email field has a caret but no selection API, and a caret drawn there
    // would sit at the start of whatever was typed.
    for (const type of ["email", "number", "checkbox", "range", "date"]) expect(caretField(field(`<input type="${type}">`)), type).toBeNull();
    expect(caretField(field("<input readonly>"))).toBeNull();
    expect(caretField(field("<textarea disabled></textarea>"))).toBeNull();
    expect(caretField(field("<button>Go</button>"))).toBeNull();
  });

  it("leaves the two editors that draw their own caret alone — unless one says where it is", () => {
    const helper = field('<div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>').firstElementChild!;
    expect(caretField(helper)).toBeNull();
    const editor = field('<div class="cm-editor"><div class="cm-content" contenteditable="true"></div></div>');
    const content = editor.firstElementChild!;
    expect(caretField(content)).toBeNull();
    const off = registerCaretSource(content, { host: editor, measure: () => null });
    expect(caretField(content)).toBe(content);
    off();
    expect(caretField(content)).toBeNull();
  });
});

describe("textPoint", () => {
  it("counts the characters of a draft across its runs, and none of an icon's", () => {
    // The prompter's mirror: chips are spans, and a chip's mark is an SVG whose text is not the draft's.
    const mirror = field('<div><span>ab</span><span><svg><text>zz</text></svg>c</span>de</div>');
    const at = (n: number) => { const p = textPoint(mirror, n); return p && p.node.data[p.offset]; };
    expect([0, 1, 2, 3, 4].map(at)).toEqual(["a", "b", "c", "d", "e"]);
    expect(textPoint(mirror, 5)).toBeNull();
    // A lone text node is its own root, which a walker never returns.
    const text = document.createTextNode("xy");
    expect(textPoint(text, 1)).toEqual({ node: text, offset: 1 });
  });
});

describe("the field's own caret is off exactly while the drawn one stands in for it", () => {
  it("goes transparent the moment the field takes the keyboard, and comes back when it leaves", () => {
    /* THE frame-late mutant: mark the field in the next frame, and every focus shows the platform's
       caret for one frame beside the drawn one. THE sticky mutant: never take the mark off, and the
       field it was on has no caret at all the next time the layer is not drawing one. */
    install();
    const input = field("<input>") as HTMLInputElement;
    input.focus();
    expect(hidden(input)).toBe(true);
    input.blur();
    flush();
    expect(hidden(input)).toBe(false);
  });

  it("never touches a field it cannot stand in for", () => {
    install();
    const email = field('<input type="email">') as HTMLInputElement;
    email.focus();
    flush();
    expect(hidden(email)).toBe(false);
  });

  it("hands the caret back to the platform while an input method composes, and takes it again after", () => {
    // The platform draws the composition — the marked text and the candidate window — at ITS caret.
    install();
    const ta = field("<textarea></textarea>") as HTMLTextAreaElement;
    ta.focus();
    ta.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    expect(hidden(ta)).toBe(false);
    ta.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(hidden(ta)).toBe(true);
  });

  it("leaves a thin blinking line to the platform, which draws exactly that, and takes it for any other", () => {
    install({ shape: "line-thin", animation: "blink" });
    const input = field("<input>") as HTMLInputElement;
    input.focus();
    expect(hidden(input)).toBe(false);
    layer!.configure({ ...CARET_DEFAULT, shape: "line-thin", animation: "solid" });
    expect(hidden(input)).toBe(true);
    layer!.configure({ ...CARET_DEFAULT, shape: "line-thin", animation: "blink" });
    expect(hidden(input)).toBe(false);
  });

  it("lets an engine with caret-shape and caret-animation draw what it can", () => {
    // jsdom's style object drops properties it does not know, so the write is what is checked.
    const set = vi.spyOn(root.style, "setProperty");
    install({ shape: "block", animation: "solid" }, { shape: true, animation: true });
    const input = field("<input>") as HTMLInputElement;
    input.focus();
    expect(hidden(input)).toBe(false);
    expect(set).toHaveBeenCalledWith("caret-shape", "block");
    expect(set).toHaveBeenCalledWith("caret-animation", "manual");
  });

  it("marks the editor's own element for a source, whose caret is always the drawn one", () => {
    // CodeMirror hides the platform's caret itself and draws its own; while the drawn one stands in,
    // CodeMirror's primary cursor is the one that steps aside, and that is the HOST's to hide.
    install({ shape: "line-thin", animation: "blink" });
    const editor = field('<div class="cm-editor"><div class="cm-content" contenteditable="true" tabindex="0"></div></div>');
    const content = editor.firstElementChild as HTMLElement;
    const off = registerCaretSource(content, { host: editor, measure: () => null });
    content.focus();
    expect(hidden(editor)).toBe(true);
    expect(hidden(content)).toBe(false);
    off();
  });

  it("takes every mark and every attribute back when it is uninstalled", () => {
    install();
    const input = field("<input>") as HTMLInputElement;
    input.focus();
    layer!.uninstall();
    layer = null;
    expect(hidden(input)).toBe(false);
    for (const a of ["data-caret", "data-caret-animation", "data-caret-colour"]) expect(root.hasAttribute(a), a).toBe(false);
    expect(document.querySelector(".caret-layer, .caret-mirror")).toBeNull();
  });
});

describe("reduced motion and low power", () => {
  const reduced = (on: boolean) => vi.stubGlobal("matchMedia", (q: string) => ({ matches: on && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));

  it("holds every caret still, and keeps the chosen animation for the terminal's rule to read", () => {
    /* THE overwrite mutant: write "solid" into the attribute the stylesheet reads, and a terminal whose
       blink is on — which blinks plainly when the caret is Solid — starts blinking under Reduce motion. */
    reduced(true);
    install({ animation: "pulse" });
    expect(root.hasAttribute("data-caret-still")).toBe(true);
    expect(root.getAttribute("data-caret-animation")).toBe("pulse");
  });

  it("draws even the thin line under reduced motion, because the platform's own would go on blinking", () => {
    reduced(true);
    install({ shape: "line-thin", animation: "blink" });
    const input = field("<input>") as HTMLInputElement;
    input.focus();
    expect(hidden(input)).toBe(true);
  });

  it("holds still under Low power, not merely while the window is in the background", () => {
    reduced(false);
    install();
    root.setAttribute("data-quiet", "unfocused");
    return Promise.resolve().then(() => {
      expect(root.hasAttribute("data-caret-still")).toBe(false);
      root.setAttribute("data-quiet", "always");
      return Promise.resolve();
    }).then(() => expect(root.hasAttribute("data-caret-still")).toBe(true));
  });
});

/** Geometry for jsdom: the n-th character of a field's text is 8px wide at x = 100 + 8n, on a line 18px
 *  tall at y = 20 — or, past `wrap`, on the next line down. */
function stubGeometry(at: { wrap?: number } = {}) {
  const wrap = at.wrap ?? Infinity;
  vi.spyOn(Range.prototype, "getClientRects").mockImplementation(function (this: Range) {
    const node = this.startContainer;
    // The global offset: every text node before this one in its field (or mirror), skipping icons.
    const owner = (node.parentElement?.closest("[data-caret-mirror], .caret-mirror, [contenteditable]") ?? node.parentElement)!;
    let n = this.startOffset;
    const walker = document.createTreeWalker(owner, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t && t !== node; t = walker.nextNode()) if (!t.parentElement?.closest("svg")) n += (t as Text).length;
    const char = (node as Text).data?.slice(this.startOffset, this.endOffset) ?? "";
    const line = n >= wrap ? 1 : 0;
    const x = 100 + 8 * (line ? n - wrap : n);
    const width = char === "\n" || char === "​" || this.collapsed ? 0 : 8;
    return Object.assign([new DOMRect(x, 20 + 20 * line, width, 18)], { item: () => null }) as unknown as DOMRectList;
  });
}
const boxed = (el: HTMLElement) => {
  Object.defineProperty(el, "getBoundingClientRect", { value: () => new DOMRect(90, 10, 600, 80) });
  vi.spyOn(document, "elementFromPoint" as never).mockImplementation((() => el) as never);
  return el;
};
/** Where the caret was drawn: its clip's place plus its own, and its size. */
const drawn = () => {
  const shown = document.querySelector(".caret-layer")!.hasAttribute("data-shown");
  const px = (t: string) => (t.match(/-?[\d.]+/g) ?? ["0", "0"]).map(Number);
  const [cx, cy] = px((document.querySelector(".caret-clip") as HTMLElement).style.transform);
  const caret = document.querySelector(".caret-layer .caret") as HTMLElement;
  const [x, y] = px(caret.style.transform);
  return { shown, left: cx! + x!, top: cy! + y!, width: parseFloat(caret.style.width), height: parseFloat(caret.style.height), glide: caret.hasAttribute("data-glide") };
};

describe("where it is drawn", () => {
  beforeEach(() => { document.elementFromPoint = document.elementFromPoint ?? (() => null); });

  it("stands on the prompter's own mirror: the character after the caret, wherever its runs split", () => {
    stubGeometry();
    install({ shape: "line" });
    const editor = field('<div><div data-caret-mirror><span>ab</span><span><svg><text>zz</text></svg>c</span>de</div><textarea></textarea></div>');
    const ta = boxed(editor.querySelector("textarea")!) as HTMLTextAreaElement;
    ta.value = "abcde";
    ta.focus();
    ta.setSelectionRange(3, 3);
    flush();
    // Before "d", the fourth character: 100 + 8·3, the two-pixel line centred on it.
    expect(drawn()).toMatchObject({ shown: true, left: 123, top: 20, width: 2, height: 18 });
  });

  it("measures a plain field in its own mirror, and never copies a password into it", () => {
    /* THE plaintext mutant: mirror the value as typed, and the one field whose characters are never
       shown has them sitting in a DOM node anyone can read. */
    stubGeometry();
    install({ shape: "block" });
    const input = boxed(field('<input type="password">')) as HTMLInputElement;
    input.value = "hunter2";
    input.focus();
    input.setSelectionRange(2, 2);
    flush();
    const mirror = document.querySelector(".caret-mirror")!;
    expect(mirror.textContent).not.toContain("hunter2");
    expect(mirror.textContent).toBe("•".repeat(7) + "​");
    expect(drawn()).toMatchObject({ shown: true, left: 116, width: 8 });
    // A block redraws the character it covers — here a bullet, the field's own glyph for it.
    expect(document.querySelector(".caret-glyph")!.textContent).toBe("•");
  });

  it("follows the gesture across a soft wrap: the next line for typing, this one for End", () => {
    stubGeometry({ wrap: 5 });
    install({ shape: "line-thin" , animation: "solid" });
    const ta = boxed(field("<textarea></textarea>")) as HTMLTextAreaElement;
    ta.value = "hello world";
    ta.focus();
    ta.setSelectionRange(5, 5);
    flush();
    expect(drawn()).toMatchObject({ left: 100, top: 40 });
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    flush();
    expect(drawn()).toMatchObject({ left: 140, top: 20 });
  });

  it("steps aside for a selection, a window that is not in front, and anything drawn over the field", () => {
    stubGeometry();
    install();
    const input = boxed(field("<input>")) as HTMLInputElement;
    input.value = "abc";
    input.focus();
    input.setSelectionRange(1, 1);
    flush();
    expect(drawn().shown).toBe(true);
    input.setSelectionRange(0, 2);
    document.dispatchEvent(new Event("selectionchange"));
    flush();
    expect(drawn().shown).toBe(false);
    input.setSelectionRange(1, 1);
    document.dispatchEvent(new Event("selectionchange"));
    flush();
    expect(drawn().shown).toBe(true);
    vi.spyOn(document, "elementFromPoint" as never).mockImplementation((() => document.body) as never);
    window.dispatchEvent(new Event("resize"));
    flush();
    expect(drawn().shown).toBe(false);
    vi.spyOn(document, "elementFromPoint" as never).mockImplementation((() => input) as never);
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    window.dispatchEvent(new Event("blur"));
    flush();
    expect(drawn().shown).toBe(false);
  });

  it("glides only when the caret moves through the text, and never under reduced motion", () => {
    /* THE everywhere-glide mutant: a scroll or a resize slides the caret behind the line it is on. */
    stubGeometry();
    install({ glide: true });
    const input = boxed(field("<input>")) as HTMLInputElement;
    input.value = "abcdef";
    input.focus();
    input.setSelectionRange(1, 1);
    flush();
    expect(drawn().glide).toBe(false); // the first placement is a placement
    input.setSelectionRange(2, 2);
    document.dispatchEvent(new Event("selectionchange"));
    flush();
    expect(drawn().glide).toBe(true);
    document.dispatchEvent(new Event("scroll"));
    flush();
    expect(drawn().glide).toBe(false);
  });

  it("still glides when something that does not move the field lands in the same frame", () => {
    /* Measured in the real window: a focus ring finishing on the prompter (an animationend on the field
       itself) arrived in the frame of the next arrow key, and THE any-placement mutant took the glide
       away for a field that had not moved a pixel. Only the field moving, or a scroll, may do that. */
    stubGeometry();
    install({ glide: true });
    const input = boxed(field("<input>")) as HTMLInputElement;
    input.value = "abcdef";
    input.focus();
    input.setSelectionRange(1, 1);
    flush();
    input.setSelectionRange(3, 3);
    document.dispatchEvent(new Event("selectionchange"));
    input.dispatchEvent(new Event("animationend", { bubbles: true }));
    flush();
    expect(drawn()).toMatchObject({ shown: true, glide: true, left: 123 });
  });

  it("does not glide under reduced motion, which a glide is", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
    stubGeometry();
    install({ glide: true });
    const input = boxed(field("<input>")) as HTMLInputElement;
    input.value = "abcdef";
    input.focus();
    input.setSelectionRange(1, 1);
    flush();
    input.setSelectionRange(2, 2);
    document.dispatchEvent(new Event("selectionchange"));
    flush();
    expect(drawn()).toMatchObject({ shown: true, glide: false });
  });

  it("stands in the Settings preview while nothing is being typed in, whatever shape was asked for", () => {
    // A specimen: the platform draws no caret in a field without the focus, so even its own thin line
    // is drawn here while the shapes are being chosen.
    stubGeometry();
    install({ shape: "line-thin", animation: "blink" });
    const preview = boxed(field("<textarea data-caret-preview>try</textarea>")) as HTMLTextAreaElement;
    preview.setSelectionRange(3, 3);
    const other = field("<button>x</button>") as HTMLButtonElement;
    other.focus();
    flush();
    expect(drawn()).toMatchObject({ shown: true, left: 124, width: 1 });
    expect(hidden(preview)).toBe(false);
  });
});
