import { describe, expect, it } from "vitest";
import {
  CHIP_LABEL_MAX, chipLabel, ElementChipSchema, elementChipLabel, elementChipToken, elementContext,
  keepLiveChips, PICK_HTML_MAX, scanChips, scanElementChips, type BrowserPickedElement,
} from "./index";

const picked = (over: Partial<BrowserPickedElement> = {}): BrowserPickedElement => ({
  ref: 1, url: "https://example.com/login", title: "Sign in",
  rect: { x: 0, y: 0, w: 10, h: 10 },
  selector: "#submit", tag: "button", role: "button", name: "Sign in",
  text: "Sign in", html: '<button id="submit">Sign in</button>', ...over,
});

describe("scanElementChips", () => {
  it("bounds the whole token, sigil and brackets included", () => {
    expect(scanElementChips('go @[button "Sign in"] now')).toEqual([
      { kind: "element", label: 'button "Sign in"', start: 3, end: 22 },
    ]);
  });

  it("never lets an unclosed token swallow the next one", () => {
    expect(scanElementChips("@[a and @[b]")).toEqual([{ kind: "element", label: "b", start: 8, end: 12 }]);
  });

  it("does not span a line — a chip the caret could sit inside is not one run", () => {
    expect(scanElementChips("@[a\nb]")).toEqual([]);
  });

  it("finds every chip in text order", () => {
    expect(scanElementChips("@[a] and @[b]").map((c) => c.label)).toEqual(["a", "b"]);
  });
});

describe("scanChips", () => {
  it("returns mentions and elements together, in text order", () => {
    expect(scanChips("@mac then @[button] then @web", ["mac", "web"]).map((c) => `${c.kind}:${c.label}`))
      .toEqual(["mention:mac", "element:button", "mention:web"]);
  });

  it("an element token is invisible to the mention scan, so the two can never overlap", () => {
    // `[` is not an id character, so the mention candidate after `@` is empty — this is the property
    // that lets both grammars share the `@` sigil without a precedence rule.
    expect(scanChips("@[button]", ["button"]).map((c) => c.kind)).toEqual(["element"]);
  });

  it("still refuses a mention the library does not know", () => {
    expect(scanChips("@nonesuch", ["mac"])).toEqual([]);
  });
});

describe("chipLabel", () => {
  it("removes the characters that would end the token early", () => {
    expect(chipLabel("a ] b [ c")).toBe("a b c");
    expect(chipLabel("two\nlines")).toBe("two lines");
  });

  it("clips to a length a one-line draft can still show whole", () => {
    const long = chipLabel("x".repeat(200));
    expect(long).toHaveLength(CHIP_LABEL_MAX);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("elementChipLabel", () => {
  it("names the element by what it MEANS — its AX role and accessible name", () => {
    expect(elementChipLabel(picked())).toBe('button "Sign in"');
  });

  it("falls back to the selector's last segment for the nameless containers most of a page is", () => {
    expect(elementChipLabel(picked({ role: "", name: "", text: "", tag: "div", selector: "main > div#hero" }))).toBe("div#hero");
  });

  it("disambiguates against labels already in the draft, so two identical buttons stay two chips", () => {
    const first = elementChipLabel(picked());
    expect(elementChipLabel(picked(), [first])).toBe('button "Sign in" 2');
    expect(elementChipLabel(picked(), [first, 'button "Sign in" 2'])).toBe('button "Sign in" 3');
  });
});

describe("elementContext", () => {
  it("is EMPTY with no chips — a message that never touched a browser pane goes out byte for byte", () => {
    expect(elementContext([])).toBe("");
  });

  it("fences the page's account of itself and leaves the url outside it", () => {
    const out = elementContext([{ label: 'button "Sign in"', element: picked() }]);
    const fence = out.match(/untrusted-[0-9a-f]{16}/)![0];
    const inside = out.slice(out.indexOf(`<<<${fence}`), out.indexOf(`${fence}>>>`));
    expect(inside).toContain('html: <button id="submit">Sign in</button>');
    expect(inside).toContain("selector: #submit");
    expect(inside).not.toContain("https://example.com/login");
    expect(out).toContain('  @[button "Sign in"] — https://example.com/login');
  });

  it("gives each chip a fresh fence token, so page markup cannot close one it has seen before", () => {
    const a = elementContext([{ label: "x", element: picked() }]).match(/untrusted-[0-9a-f]{16}/)![0];
    const b = elementContext([{ label: "x", element: picked() }]).match(/untrusted-[0-9a-f]{16}/)![0];
    expect(a).not.toBe(b);
  });
});

describe("keepLiveChips", () => {
  it("forgets an element whose chip the user deleted, and keeps the one still there", () => {
    const kept = { label: "a", element: picked() };
    const gone = { label: "b", element: picked() };
    expect(keepLiveChips(`hello ${elementChipToken("a")}`, [kept, gone])).toEqual([kept]);
  });

  it("keeps nothing once the draft is cleared", () => {
    expect(keepLiveChips("", [{ label: "a", element: picked() }])).toEqual([]);
  });
});

describe("ElementChipSchema", () => {
  it("accepts what the picker produces", () => {
    expect(ElementChipSchema.safeParse({ label: 'button "Sign in"', element: picked() }).success).toBe(true);
  });

  it("refuses markup longer than the picker clips to — such a chip did not come from the picker", () => {
    expect(ElementChipSchema.safeParse({ label: "x", element: picked({ html: "y".repeat(PICK_HTML_MAX + 1) }) }).success).toBe(false);
  });

  it("refuses a label longer than a chip can show, so the composer and the wire agree on one", () => {
    expect(ElementChipSchema.safeParse({ label: "x".repeat(CHIP_LABEL_MAX + 1), element: picked() }).success).toBe(false);
  });
});
