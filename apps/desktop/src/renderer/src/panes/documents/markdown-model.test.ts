import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { canonicalize, docSchema, parseMarkdown, serializeMarkdown, splitFrontMatter } from "./markdown-model";

const rt = (md: string) => canonicalize(md);

describe("round-trips the constructs the schema owns", () => {
  const cases: [string, string][] = [
    ["heading", "# Title\n"],
    ["deep heading", "#### Fourth\n"],
    ["paragraph", "Just some prose.\n"],
    ["bold", "Some **bold** text.\n"],
    ["italic", "Some *italic* text.\n"],
    ["strikethrough", "Some ~~struck~~ text.\n"],
    ["inline code", "Call `documents.read` now.\n"],
    ["link", "See [the plan](./plan.md).\n"],
    ["link with title", 'See [the plan](./plan.md "Plan 17").\n'],
    ["bullet list", "- one\n- two\n"],
    ["nested bullets", "- one\n  - nested\n- two\n"],
    ["ordered list", "1. first\n2. second\n"],
    ["blockquote", "> quoted\n"],
    ["fenced code", "```ts\nconst a = 1;\n```\n"],
    ["fenced code without language", "```\nplain\n```\n"],
    ["horizontal rule", "---\n"],
    ["image", "![alt text](./a.png)\n"],
  ];
  for (const [name, md] of cases) {
    it(name, () => { expect(rt(md)).toBe(md); });
  }
});

describe("preserves what the schema cannot represent", () => {
  it("keeps a GFM table byte-for-byte", () => {
    const table = "| A | B |\n| --- | --- |\n| 1 | 2 |\n";
    // StarterKit has no table node: without the rawBlock path this content is destroyed on first save.
    expect(rt(table)).toBe(table);
  });

  it("keeps an HTML block", () => {
    const html = "<details>\n<summary>More</summary>\n</details>\n";
    expect(rt(html)).toBe(html);
  });

  it("keeps inline HTML", () => {
    expect(rt("Line one<br>still one.\n")).toBe("Line one<br>still one.\n");
  });

  it("keeps a table that sits between ordinary prose", () => {
    const md = "Before.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nAfter.\n";
    expect(rt(md)).toBe(md);
  });
});

describe("front-matter", () => {
  it("splits it off rather than letting markdown-it see a thematic break", () => {
    expect(splitFrontMatter("---\nmarp: true\n---\n\n# Hi\n"))
      .toEqual({ frontMatter: "---\nmarp: true\n---", body: "\n# Hi\n" });
    expect(splitFrontMatter("# No front-matter\n").frontMatter).toBe("");
  });

  /** Marp decks are `.md` files identified by this block (contracts/documents.ts). Reflowing it would
   *  silently turn a presentation back into a document. */
  it("round-trips a Marp deck's front-matter intact", () => {
    const deck = "---\nmarp: true\ntheme: gaia\n---\n\n# Slide one\n\n---\n\n# Slide two\n";
    expect(rt(deck)).toBe(deck);
  });
});

describe("soft line breaks", () => {
  /** The mutant that would do the most damage: mapping softbreak to a space. Every wrapped paragraph
   *  in the repo would be rejoined into one long line the first time anyone edited the file. */
  it("keeps wrapped prose wrapped instead of rejoining it", () => {
    const wrapped = "This paragraph is wrapped\nacross three separate\nsource lines.\n";
    expect(rt(wrapped)).toBe(wrapped);
  });

  it("keeps wrapping inside a list item and a blockquote", () => {
    expect(rt("- wrapped\n  item\n")).toBe("- wrapped\n  item\n");
    expect(rt("> wrapped\n> quote\n")).toBe("> wrapped\n> quote\n");
  });
});

describe("idempotency", () => {
  const corpus = [
    "# T\n\nSome *text* with `code`.\n",
    "- a\n- b\n\n1. one\n2. two\n",
    "> quote\n\n```js\nx\n```\n",
    "| A |\n| --- |\n| 1 |\n",
    "---\nmarp: true\n---\n\n# Deck\n",
  ];
  it("is stable after one pass", () => {
    for (const md of corpus) expect(rt(rt(md))).toBe(rt(md));
  });
});

/**
 * The measurement the plan asked for, against real documents rather than fixtures: every markdown file
 * this repository actually contains. Two distinct properties are checked, and the difference matters.
 */
describe("this repository's own documents", () => {
  const roots = ["docs/superpowers/plans", "docs/superpowers/specs", "docs/dev"];
  // vitest runs from the repo root; the pane lives five directories down.
  const repo = join(__dirname, "..", "..", "..", "..", "..", "..", "..");
  const files: { name: string; text: string }[] = [];
  for (const r of roots) {
    let names: string[] = [];
    try { names = readdirSync(join(repo, r)); } catch { continue; }
    for (const n of names.filter((f) => f.endsWith(".md"))) {
      files.push({ name: `${r}/${n}`, text: readFileSync(join(repo, r, n), "utf8") });
    }
  }

  it("found the corpus", () => { expect(files.length).toBeGreaterThan(20); });

  /** Non-negotiable: a document must never change again once it has been through the serializer. */
  it("is idempotent on every one of them", () => {
    for (const f of files) {
      const once = canonicalize(f.text);
      expect(once, `not idempotent: ${f.name}`).toBe(canonicalize(once));
    }
  });

  /** Also non-negotiable: no content may vanish. Tables are the case that would fail loudest. */
  it("never drops a table, fence or heading", () => {
    const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;
    for (const f of files) {
      const out = canonicalize(f.text);
      expect(count(out, /^\| /gm), `tables lost in ${f.name}`).toBe(count(f.text, /^\| /gm));
      expect(count(out, /^```/gm), `fences lost in ${f.name}`).toBe(count(f.text, /^```/gm));
      expect(count(out, /^#{1,6} /gm), `headings lost in ${f.name}`).toBe(count(f.text, /^#{1,6} /gm));
    }
  });

  /**
   * Not a pass/fail property but a REPORT: how many lines a first edit would rewrite in a file that was
   * never canonical to begin with. Zero would be ideal; the assertion is deliberately loose because
   * the honest goal is "small and visible", and a silent regression here is what would make the editor
   * a diff-noise generator. If this number climbs, the serializer changed for the worse.
   */
  it("rewrites few lines of an already-well-formed document", () => {
    const report: { name: string; changed: number; total: number }[] = [];
    for (const f of files) {
      const out = canonicalize(f.text);
      const a = f.text.split("\n"), b = out.split("\n");
      let changed = Math.abs(a.length - b.length);
      for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) changed++;
      report.push({ name: f.name, changed, total: a.length });
    }
    const worst = [...report].sort((x, y) => y.changed / y.total - x.changed / x.total).slice(0, 5);
    const totalChanged = report.reduce((n, r) => n + r.changed, 0);
    const totalLines = report.reduce((n, r) => n + r.total, 0);
    // eslint-disable-next-line no-console
    console.log(`\n  markdown round-trip churn: ${totalChanged}/${totalLines} lines (${((totalChanged / totalLines) * 100).toFixed(1)}%)`);
    for (const w of worst) console.log(`    ${w.name}: ${w.changed}/${w.total}`);
    expect(totalChanged / totalLines).toBeLessThan(0.25);
  });
});

/**
 * The claim source preservation actually makes. The corpus test above only proves an UNTOUCHED document
 * survives; these prove the edited case, which is the one users hit.
 */
describe("an edit rewrites only the block that was edited", () => {
  const doc = [
    "# Title",
    "",
    "- [ ] a task item that escaping would mangle",
    "- [ ] another",
    "",
    "| A | B |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "Prose wrapped",
    "across two lines.",
    "",
    "```ts",
    "const x = 1;",
    "```",
    "",
  ].join("\n");

  /** Replace child `index` with a fresh paragraph — what a user typing into that block produces. */
  function editBlock(src: string, index: number, text: string) {
    const parsed = parseMarkdown(src);
    const children: any[] = [];
    parsed.forEach((c) => children.push(c));
    children[index] = docSchema.nodes.paragraph!.create(null, docSchema.text(text));
    return serializeMarkdown(docSchema.topNodeType.create(null, children));
  }

  it("leaves the untouched blocks byte-identical", () => {
    // Index 3 is the wrapped prose paragraph; the task list, table and fence must not move.
    const out = editBlock(doc, 3, "Replaced prose.");
    expect(out).toContain("- [ ] a task item that escaping would mangle\n- [ ] another");
    expect(out).toContain("| A | B |\n| --- | --- |\n| 1 | 2 |");
    expect(out).toContain("```ts\nconst x = 1;\n```");
    expect(out).toContain("Replaced prose.");
    expect(out).not.toContain("across two lines.");
  });

  it("keeps the document parseable and stable after the edit", () => {
    const once = editBlock(doc, 3, "Replaced prose.");
    expect(canonicalize(once)).toBe(once);
  });

  it("preserves the task list when a DIFFERENT block is edited", () => {
    // The escaping mutant (`- [ ]` → `- \[ \]`) would fire here if preservation were bypassed.
    expect(editBlock(doc, 0, "Changed heading text")).toContain("- [ ] a task item");
  });

  /** Regression: images parsed into an EMPTY paragraph because TipTap's Image node defaults to a block.
   *  Source preservation hid it — an unedited document round-tripped fine while an edited one lost the
   *  image. Every construct therefore needs one assertion that goes through the fallback path. */
  it("keeps an image when its own block is rebuilt", () => {
    const parsed = parseMarkdown("![alt text](./a.png)\n");
    const first = parsed.child(0);
    const rebuilt = docSchema.nodes.paragraph!.create(null, first.content);
    expect(serializeMarkdown(docSchema.topNodeType.create(null, [rebuilt]))).toBe("![alt text](./a.png)\n");
  });

  it("re-serializes the edited block canonically", () => {
    const out = editBlock(doc, 0, "Now a paragraph");
    expect(out.startsWith("Now a paragraph\n")).toBe(true);
    expect(out).not.toContain("# Title");
  });
});

describe("document shape", () => {
  it("always ends with exactly one newline", () => {
    expect(rt("# A")).toBe("# A\n");
    expect(rt("# A\n\n\n")).toBe("# A\n");
  });

  it("parses an empty document into a usable doc", () => {
    const doc = parseMarkdown("");
    expect(doc.type.name).toBe("doc");
    expect(serializeMarkdown(doc)).toBe("\n");
  });
});

describe("GFM tables", () => {
  const TBL = "| Engine | Ships |\n| --- | --- |\n| Claude | yes |\n| Codex | no |\n";

  it("parses into real table nodes with their cells intact", () => {
    // The failure this replaced was silent and total: cells hold `block+`, markdown-it hands them
    // INLINE tokens, so every cell was dropped and a table parsed into a stack of empty rows. The
    // document still round-tripped (source preservation hid it), so only reading the pane showed it.
    const doc = parseMarkdown(TBL);
    expect(doc.firstChild?.type.name).toBe("table");
    const rows = doc.firstChild!;
    expect(rows.childCount).toBe(3);
    expect(rows.child(0).child(0).type.name).toBe("tableHeader");
    expect(rows.child(0).textContent).toBe("EngineShips");
    expect(rows.child(2).textContent).toBe("Codexno");
  });

  it("no longer preserves a table as its own source", () => {
    // It used to, and that was right while the schema had nowhere to put one. It is also exactly
    // why a document full of tables read as raw markdown.
    const doc = parseMarkdown(TBL);
    expect(doc.content.content.some((n) => n.type.name === "rawBlock")).toBe(false);
  });

  it("round-trips an untouched table byte for byte", () => {
    expect(canonicalize(TBL)).toBe(TBL);
  });

  it("writes an EDITED table back as GFM rather than losing it", () => {
    // The whole reason tables were preserved rather than parsed: a construct the schema cannot hold
    // is deleted on the first save. Now that it can hold one, the serializer has to be able to
    // produce it — and this is the only path that proves it, because an unedited table never
    // reaches the serializer at all.
    const doc = parseMarkdown(TBL);
    const table = doc.firstChild!;
    // A fresh node object: no WeakMap entry, so the serializer's canonical path runs.
    const rebuilt = docSchema.topNodeType.create(null, [docSchema.nodes.table!.create(null, table.content)]);
    expect(serializeMarkdown(rebuilt)).toBe(TBL);
  });

  it("escapes a pipe inside a cell, which would otherwise shift every column after it", () => {
    const src = "| A | B |\n| --- | --- |\n| x \\| y | z |\n";
    const doc = parseMarkdown(src);
    const rebuilt = docSchema.topNodeType.create(null, [docSchema.nodes.table!.create(null, doc.firstChild!.content)]);
    expect(serializeMarkdown(rebuilt)).toBe(src);
  });

  it("pads a ragged row rather than writing it short", () => {
    // ProseMirror allows a colspan; markdown does not. A short row written short moves every cell
    // after it into the wrong column, which is a data corruption dressed as a formatting bug.
    const two = docSchema.nodes.tableCell!;
    const cell = (t: string) => two.create(null, docSchema.nodes.paragraph!.create(null, docSchema.text(t)));
    const row = (...cells: string[]) => docSchema.nodes.tableRow!.create(null, cells.map(cell));
    const table = docSchema.nodes.table!.create(null, [row("a", "b"), row("c")]);
    expect(serializeMarkdown(docSchema.topNodeType.create(null, [table])))
      .toBe("| a | b |\n| --- | --- |\n| c |  |\n");
  });

  it("flattens a multi-paragraph cell onto one line", () => {
    // A GFM cell is one line and a ProseMirror cell may legally hold several blocks. A newline
    // written into a cell ends the ROW, so this is the difference between a table and a mess.
    const p = (t: string) => docSchema.nodes.paragraph!.create(null, docSchema.text(t));
    const cell = docSchema.nodes.tableCell!.create(null, [p("one"), p("two")]);
    const table = docSchema.nodes.table!.create(null, [docSchema.nodes.tableRow!.create(null, [cell])]);
    expect(serializeMarkdown(docSchema.topNodeType.create(null, [table]))).toBe("| one two |\n| --- |\n");
  });
});
