import { describe, expect, it } from "vitest";
import {
  annotationChipLabel, CHIP_LABEL_MAX, chipLabel, ElementChipSchema, elementChipLabel, elementChipToken, elementContext,
  chipRuns, keepLiveChips, MAX_ELEMENT_CHIPS, PICK_HTML_MAX, scanChips, scanElementChips, type BrowserPickedElement,
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

  it("a mention INSIDE an element chip is not a mention — the runs would overlap and print twice", () => {
    // A hand-typed or pasted token can hold anything; only the picker's own labels are sanitised.
    expect(scanChips('look at @[button "hi @mac"] please', ["mac"]).map((c) => c.kind)).toEqual(["element"]);
  });

  it("an element token is invisible to the mention scan, so the two can never overlap", () => {
    // `[` is not an id character, so the mention candidate after `@` is empty — this is the property
    // that lets both grammars share the `@` sigil without a precedence rule.
    expect(scanChips("@[button]", ["button"]).map((c) => c.kind)).toEqual(["element"]);
  });

});

describe("chipLabel", () => {
  it("removes the characters that would end the token early", () => {
    expect(chipLabel("a ] b [ c")).toBe("a b c");
    expect(chipLabel("two\nlines")).toBe("two lines");
  });

  it("removes the `@` a page could put in an element's name to smuggle a skill mention into a draft", () => {
    expect(chipLabel("hi @mac")).toBe("hi mac");
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

  it("disambiguates a name so long the label was already clipped — the case that used to never return", () => {
    const long = picked({ name: "x".repeat(110) });
    const first = elementChipLabel(long);
    expect(first).toHaveLength(CHIP_LABEL_MAX);
    const second = elementChipLabel(long, [first]);
    expect(second).not.toBe(first);
    expect(second.length).toBeLessThanOrEqual(CHIP_LABEL_MAX);
    // …and it keeps going for as many chips as one message may carry.
    const labels: string[] = [];
    for (let i = 0; i < MAX_ELEMENT_CHIPS; i++) labels.push(elementChipLabel(long, labels));
    expect(new Set(labels).size).toBe(MAX_ELEMENT_CHIPS);
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

  it("fences the page's account of itself, and states only the origin outside", () => {
    const out = elementContext([{ label: 'button "Sign in"', element: picked() }]);
    const fence = out.match(/untrusted-[0-9a-f]{16}/)![0];
    const inside = out.slice(out.indexOf(`<<<${fence}`), out.indexOf(`${fence}>>>`));
    expect(inside).toContain('html: <button id="submit">Sign in</button>');
    expect(inside).toContain("selector: #submit");
    // The path is page-authored (`history.pushState` moves it), so the full url goes UNDER the fence;
    // only the origin, which script cannot move the webContents off, is stated outside it.
    expect(inside).toContain("url: https://example.com/login");
    expect(out).toContain('  @[button "Sign in"] — https://example.com');
    expect(out.slice(0, out.indexOf("Everything between"))).not.toContain("/login");
  });

  it("describes a DEVICE element by what it has, and never by a selector it does not", () => {
    const el = picked({
      selector: "", html: "", tag: "canvas", role: "button", name: "General", text: "",
      url: "http://127.0.0.1:3200/", title: "Simulator - iPhone 17 Pro",
      device: { id: "com.apple.settings.general", path: "0.1.1", enabled: true,
        frame: { x: 16, y: 293.3333333333333, width: 370, height: 44 }, screen: { width: 402, height: 874 } },
    });
    const out = elementContext([{ label: 'button "General"', element: el }]);
    expect(out).toContain("id: com.apple.settings.general");
    expect(out).toContain("path: 0.1.1");
    // Rounded: a prompt is read by a person and a model, and neither is helped by 293.3333333333333.
    expect(out).toContain("frame: x=16 y=293.3 w=370 h=44 in a 402×874 point screen");
    // THE MUTANT: keep printing the DOM lines for a device element. `selector: (none found)` reads as
    // "we looked and there was none", which is a different claim from "this is not in the document".
    expect(out).not.toContain("selector:");
    expect(out).not.toContain("tag:");
  });

  it("warns, in Realm's own voice, that a device element cannot be acted on through the browser", () => {
    const el = picked({ device: { id: "a", path: "0", enabled: true, frame: { x: 0, y: 0, width: 1, height: 1 }, screen: { width: 10, height: 10 } } });
    const out = elementContext([{ label: "x", element: el }]);
    // OUTSIDE the fence: it is a fact about Realm's tools, not something the page or device said.
    // THE MUTANT: drop it, and an agent tries browser_act on a chip whose ref is the video surface —
    // clicking the middle of the screen and reporting success.
    expect(out.slice(0, out.indexOf("Everything between"))).toContain("browser_act cannot address it");
    // And an ordinary web pick is left exactly as it was: no note, no new bytes.
    expect(elementContext([{ label: "x", element: picked() }])).not.toContain("browser_act cannot address it");
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

});

describe("ElementChipSchema", () => {

  it("refuses markup longer than the picker clips to — such a chip did not come from the picker", () => {
    expect(ElementChipSchema.safeParse({ label: "x", element: picked({ html: "y".repeat(PICK_HTML_MAX + 1) }) }).success).toBe(false);
  });

  it("refuses a label longer than a chip can show, so the composer and the wire agree on one", () => {
    expect(ElementChipSchema.safeParse({ label: "x".repeat(CHIP_LABEL_MAX + 1), element: picked() }).success).toBe(false);
  });
});

describe("chipRuns", () => {
  const rejoin = (text: string, ids: string[]) => chipRuns(text, ids).map((r) => r.text).join("");

  it("partitions the text — every rendering of chips still shows exactly what was typed", () => {
    for (const text of [
      "", "@mac", "@mac go", "go @mac", "a @mac b @[button] c", "@[button]", "@", "@[", "@[]",
      "carlton@mac", "@nonesuch", "line\n@mac\nline", "@mac@mac", "@[a @mac b]", "x @[@mac] y",
    ]) expect(rejoin(text, ["mac"])).toBe(text);
  });

  it("marks the chips and leaves everything else plain", () => {
    expect(chipRuns('use @mac on @[button "Go"] now', ["mac"]).map((r) => [r.chip?.kind ?? "text", r.text])).toEqual([
      ["text", "use "], ["mention", "@mac"], ["text", " on "], ["element", '@[button "Go"]'], ["text", " now"],
    ]);
  });

});

/**
 * Plan 26 W7d — an ANNOTATION: several elements pinned on one page and sent as one chip. One token
 * stands for every sidecar entry under its label; `pin` is the number the user saw on the page.
 */
describe("annotation chips", () => {
  const pins = (label = "3 annotations", shot?: string) => [1, 2, 3].map((n) => ({
    label, element: picked({ ref: 40 + n, name: `Item ${n}`, selector: `#item-${n}` }), pin: n, ...(shot ? { shot } : {}),
  }));

  it("count the pins as a person would, and never collide with a chip already in the draft", () => {
    expect(annotationChipLabel(1)).toBe("1 annotation");
    expect(annotationChipLabel(3)).toBe("3 annotations");
    expect(annotationChipLabel(3, ["3 annotations"])).toBe("3 annotations 2");
  });

  it("one token keeps every pin it stands for, and deleting it forgets them all", () => {
    const chips = pins();
    expect(keepLiveChips(`look at ${elementChipToken("3 annotations")} please`, chips)).toEqual(chips);
    expect(keepLiveChips("look at these please", chips)).toEqual([]);
  });

  it("the agent is told each pin by its number, and the token is listed once, not once per pin", () => {
    const out = elementContext(pins("3 annotations", "127.0.0.1-8971-2026-10-01T19-30-05-annotations.png"));
    const fence = out.match(/untrusted-[0-9a-f]{16}/)![0];
    const outside = out.slice(0, out.indexOf(`<<<${fence}`));
    const inside = out.slice(out.indexOf(`<<<${fence}`), out.indexOf(`${fence}>>>`));
    // THE mutant: one index line per entry. Three lines of the same token read as three chips.
    expect(outside.split("\n").filter((l) => l.includes("@[3 annotations]"))).toEqual(["  @[3 annotations] — https://example.com, 3 pins"]);
    for (const n of [1, 2, 3]) expect(inside).toContain(`@[3 annotations] pin ${n}\nurl: https://example.com/login\nselector: #item-${n}`);
    // Realm's own voice, outside the fence: what the numbers are, and which attachment shows them.
    expect(outside).toContain("numbered in the order they pinned them; the attached 127.0.0.1-8971-2026-10-01T19-30-05-annotations.png shows each number");
  });

  it("an ordinary pick goes out exactly as it did before annotations existed", () => {
    const out = elementContext([{ label: 'button "Sign in"', element: picked() }]);
    expect(out).not.toContain("annotation");
    expect(out).not.toContain(" pin ");
    expect(out).toContain('  @[button "Sign in"] — https://example.com\n');
  });

  it("the wire carries a pin and its screenshot, and still takes a chip from before either existed", () => {
    expect(ElementChipSchema.parse({ label: "3 annotations", element: picked(), pin: 2, shot: "a.png" })).toMatchObject({ pin: 2, shot: "a.png" });
    expect(ElementChipSchema.safeParse({ label: "x", element: picked() }).success).toBe(true);
    expect(ElementChipSchema.safeParse({ label: "x", element: picked(), pin: 0 }).success).toBe(false);
    expect(ElementChipSchema.safeParse({ label: "x", element: picked(), pin: MAX_ELEMENT_CHIPS + 1 }).success).toBe(false);
  });
});
