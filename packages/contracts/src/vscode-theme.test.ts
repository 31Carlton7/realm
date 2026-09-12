import { describe, expect, it } from "vitest";
import { hexToOklch } from "./colour";
import { nearestHue, readColour, readMode, scopeColour, tokenRules, vscodeToSeed } from "./vscode-theme";

/** A theme that states only what a test is about — which is also what real themes are like. */
const theme = (colors: Record<string, unknown> = {}, tokenColors: unknown = []) => ({ colors, tokenColors });
const token = (scope: unknown, foreground: string) => ({ scope, settings: { foreground } });

describe("readColour", () => {
  it("takes the three hex forms a theme may write", () => {
    expect(readColour("#abc")).toBe("#aabbcc");
    expect(readColour("#aabbcc")).toBe("#aabbcc");
    expect(readColour("aabbcc")).toBe("#aabbcc");
  });

  it("composites alpha onto the ground rather than carrying it", () => {
    /* A seed is opaque, and the ramp derives every surface and ink from it — an alpha riding along
       would multiply silently through all of them. Half-white over black is the grey the eye saw. */
    expect(readColour("#ffffff80", "#000000")).toBe("#808080");
    expect(readColour("#ffffffff", "#000000")).toBe("#ffffff");
  });

  it("keeps a translucent colour whole when there is no ground to composite onto", () => {
    expect(readColour("#ffffff80")).toBe("#ffffff");
  });

  it("answers null for everything that is not a colour, so a chain can fall through it", () => {
    // THE MUTANT: return a default here. Every fallback chain in the file is built on null meaning
    // "the theme did not say" — a substitute would stop the chain at its first missing key.
    for (const x of [undefined, null, false, "", "red", "#12", "#1234567", {}, 0]) {
      expect(readColour(x), String(x)).toBeNull();
    }
  });
});

describe("tokenRules", () => {
  it("reads the three shapes real themes ship `scope` in", () => {
    expect(tokenRules([token("comment", "#111111")])[0]!.scopes).toEqual(["comment"]);
    expect(tokenRules([token(["a", "b"], "#111111")])[0]!.scopes).toEqual(["a", "b"]);
    // Comma-separated in one string — VS Code accepts it and themes use it.
    expect(tokenRules([token("a, b ,c", "#111111")])[0]!.scopes).toEqual(["a", "b", "c"]);
  });

  it("skips entries with no scope rather than inventing one", () => {
    expect(tokenRules([{ settings: { foreground: "#111111" } }, "nonsense", null])).toEqual([]);
  });
});

describe("scopeColour", () => {
  it("matches a selector that is a PREFIX of the scope — that is what a scope is", () => {
    // A theme that colours `entity.name` has answered for `entity.name.function.js`.
    const rules = tokenRules([token("entity.name", "#aa0000")]);
    expect(scopeColour(rules, "entity.name.function")).toBe("#aa0000");
    // …but `entity.names` is a different scope, not a deeper one.
    expect(scopeColour(tokenRules([token("entity.names", "#aa0000")]), "entity.name")).toBeNull();
  });

  it("lets the more SPECIFIC selector win, whatever order the file lists them in", () => {
    const rules = tokenRules([token("entity.name.function", "#00aa00"), token("entity", "#aa0000")]);
    // THE MUTANT: take the first or last match. A theme that states a broad rule after a narrow one
    // — and many do — would lose every specific colour it wrote.
    expect(scopeColour(rules, "entity.name.function")).toBe("#00aa00");
  });

  it("lets the LATER of two equally specific rules win, as VS Code does", () => {
    const rules = tokenRules([token("keyword", "#aa0000"), token("keyword", "#00aa00")]);
    expect(scopeColour(rules, "keyword")).toBe("#00aa00");
  });
});

describe("readMode", () => {
  it("believes the GROUND over the label", () => {
    /* `type` is a claim; the background is the fact, and real themes disagree. Believing the label
       derives a white-grounded theme with the dark ramp, whose surfaces climb the wrong way. */
    expect(readMode({ type: "dark", colors: { "editor.background": "#fafafa" } })).toBe("light");
    expect(readMode({ type: "light", colors: { "editor.background": "#111111" } })).toBe("dark");
  });

  it("falls back to the label only when there is no ground at all", () => {
    expect(readMode({ type: "light" })).toBe("light");
    expect(readMode({})).toBe("dark");
  });
});

describe("nearestHue", () => {
  it("prefers the NEAREST hue, with chroma only breaking a tie", () => {
    /* THE MUTANT that shipped: rank by chroma. Kimbie's `#f06431` is more saturated than its
       `#f79a32`, so the orange slot took the red-orange and the red slot took it too — one colour
       doing two jobs, and neither the one the theme would have chosen. */
    expect(nearestHue(["#f06431", "#f79a32"], 78)).toBe("#f79a32");
    expect(nearestHue(["#f79a32", "#f06431"], 27)).toBe("#f06431");
  });

  it("refuses a colour too grey to read as a state at all", () => {
    // A muted teal sat just above an earlier, lower floor and became a theme's "red".
    expect(nearestHue(["#8ab1b0"], 194)).toBeNull();
  });

  it("refuses a colour whose hue is simply a different colour", () => {
    // Calling a blue "the theme's red" because it was the least-blue thing available says less than
    // using Realm's own red and reporting that it was derived.
    expect(nearestHue(["#4b69c6"], 27)).toBeNull();
  });
});

describe("vscodeToSeed", () => {
  it("reads the thirteen out of a theme that states them", () => {
    const { seed, report } = vscodeToSeed(theme(
      { "editor.background": "#272822", "editor.foreground": "#f8f8f2", "textLink.foreground": "#66d9ef",
        "terminal.ansiGreen": "#a6e22e", "editorWarning.foreground": "#e6db74", "editorError.foreground": "#f92672" },
      [token("comment", "#88846f"), token("keyword", "#f92672"), token("string", "#e6db74"),
       token("constant.numeric", "#ae81ff"), token("entity.name.function", "#a6e22e"),
       token("entity.name.type", "#66d9ef"), token("entity.other.attribute-name", "#fd971f")],
    ), "dark");
    expect(seed).toEqual({
      bg: "#272822", ink: "#f8f8f2", accent: "#66d9ef", green: "#a6e22e", orange: "#e6db74", red: "#f92672",
      syntax: { comment: "#88846f", keyword: "#f92672", string: "#e6db74", number: "#ae81ff",
        title: "#a6e22e", type: "#66d9ef", attr: "#fd971f" },
    });
    expect(Object.values(report).every((v) => v === "stated")).toBe(true);
  });

  it("does not take a line-number colour for body ink — that is an accent in most themes", () => {
    /* THE MUTANT that shipped: end the ink chain at `editorLineNumber.activeForeground`. QuietLight
       states no foreground anywhere, and its body text came out purple. VS Code's own default for
       the face is what its author was looking at while they chose everything else. */
    const { seed, report } = vscodeToSeed(theme({
      "editor.background": "#f5f5f5", "editorLineNumber.activeForeground": "#9769dc",
    }), "light");
    expect(seed.ink).toBe("#1f1f1f");
    expect(report["ink"]).toBe("derived");
  });

  it("refuses a GREY accent and takes the theme's own keyword hue instead", () => {
    /* Realm spends the accent on focus rings, links and carets, every one of which has to be told
       from a border at a glance. Monokai states a grey-brown button and a grey focus border and
       nothing else — taken at face value, its focus ring is invisible. */
    const { seed, report } = vscodeToSeed(theme(
      { "editor.background": "#272822", "button.background": "#75715e", focusBorder: "#99947c" },
      [token("keyword", "#f92672")],
    ), "dark");
    expect(seed.accent).toBe("#f92672");
    // `borrowed`, not `derived`: the theme DID state one, and this is the single substitution Realm
    // makes against something its author actually wrote.
    expect(report["accent"]).toBe("borrowed");
  });

  it("keeps a stated accent that has real colour in it", () => {
    const { seed, report } = vscodeToSeed(theme(
      { "editor.background": "#000c18", "editorLink.activeForeground": "#0063a5" },
      [token("keyword", "#225588")],
    ), "dark");
    expect(seed.accent).toBe("#0063a5");
    expect(report["accent"]).toBe("stated");
  });

  it("borrows a missing state colour from the theme's own palette before any constant", () => {
    // A palette whose failures are Realm's red rather than its own reads as half-imported.
    const { seed } = vscodeToSeed(theme(
      { "editor.background": "#221a0f" },
      [token("entity.name.type", "#f06431"), token("string", "#889b4a"), token("constant.numeric", "#f79a32")],
    ), "dark");
    expect(seed.red).toBe("#f06431");
    expect(seed.green).toBe("#889b4a");
    expect(seed.orange).toBe("#f79a32");
  });

  it("falls back to a constant only when the theme has no such hue at all", () => {
    // A red theme genuinely has no green, and saying so beats tinting one of its reds.
    const { seed, report } = vscodeToSeed(theme(
      { "editor.background": "#390000" }, [token("keyword", "#f12727")],
    ), "dark");
    expect(seed.green).toBe("#3fb950");
    expect(report["green"]).toBe("derived");
  });

  it("produces a full seed from a theme that states nothing but a ground", () => {
    // THE MUTANT: require any key. Every field of a VS Code theme is optional and real ones omit
    // most of them; an import that throws on a sparse theme rejects half of what people have.
    const { seed } = vscodeToSeed(theme({ "editor.background": "#101014" }), "dark");
    for (const v of [seed.bg, seed.ink, seed.accent, seed.green, seed.orange, seed.red, ...Object.values(seed.syntax)]) {
      expect(v).toMatch(/^#[0-9a-f]{6}$/);
    }
    // The derived comment sits between the ink and the ground, which is what a comment is.
    const [c, ink, bg] = [seed.syntax.comment, seed.ink, seed.bg].map((h) => hexToOklch(h).l) as [number, number, number];
    expect(c).toBeLessThan(ink);
    expect(c).toBeGreaterThan(bg);
  });
});
