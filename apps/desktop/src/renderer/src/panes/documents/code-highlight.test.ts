import type { Node as PmNode } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import type { HLJSApi } from "highlight.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { highlightToHtml } from "../session/rich/highlight";
import { codeHighlight } from "./code-highlight";
import { docSchema, parseMarkdown } from "./markdown-model";

/** highlight.js loads after the window is up (`rich-libs.ts`), so a document can open before it has. */
const libs = vi.hoisted(() => ({ hljs: null as HLJSApi | null, land: () => {} }));
vi.mock("../session/rich/rich-libs", () => ({
  hljsIfLoaded: () => libs.hljs,
  loadRichLibs: () => new Promise<void>((resolve) => { libs.land = resolve; }),
}));

vi.mock("../session/rich/highlight", async (actual) => {
  const real = await actual<typeof import("../session/rich/highlight")>();
  return { ...real, highlightToHtml: vi.fn(real.highlightToHtml) };
});
const highlighted = vi.mocked(highlightToHtml);

describe("a document's code colours", () => {
  it("arrive when highlight.js lands, for a document opened before it did", async () => {
    const doc = parseMarkdown("```ts\nconst a = 1;\n```\n", docSchema);
    const view = new EditorView(document.createElement("div"), { state: EditorState.create({ doc, plugins: [codeHighlight()] }) });
    expect(view.dom.querySelector(".hljs-keyword")).toBeNull();
    libs.hljs = (await import("../session/rich/highlight-grammars")).default;
    libs.land();
    await vi.waitFor(() => expect(view.dom.querySelector(".hljs-keyword")?.textContent).toBe("const"));
    // The text is still the document's own: colour is a decoration, not an edit.
    expect(view.state.doc.textContent).toBe("const a = 1;");
    view.destroy();
  });
});

describe("an edit to a document", () => {
  const md = [
    "Intro.", "",
    "```ts", "const a = 1;", "let b = \"two\";", "```", "",
    "Between.", "",
    "```py", "def f(x):", "    return x + 1", "```", "",
    "```json", "{ \"on\": true }", "```", "",
    "Outro.", "",
  ].join("\n");

  let view: EditorView;
  beforeEach(async () => {
    libs.hljs = (await import("../session/rich/highlight-grammars")).default;
    view?.destroy();
    view = new EditorView(document.createElement("div"), { state: EditorState.create({ doc: parseMarkdown(md, docSchema), plugins: [codeHighlight()] }) });
    highlighted.mockClear();
  });

  const nth = (type: string, n: number) => {
    const found: { node: PmNode; pos: number }[] = [];
    view.state.doc.descendants((node, pos) => { if (node.type.name === type) found.push({ node, pos }); return node.type.name === "doc"; });
    return found[n]!;
  };
  const typeAt = (pos: number, text: string) => {
    for (const [i, ch] of Array.from(text).entries()) {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + i)).insertText(ch));
    }
  };
  /** What a document opened fresh with the same text draws: the full rebuild the edits must equal. */
  const rebuilt = () => {
    const fresh = new EditorView(document.createElement("div"), { state: EditorState.create({ doc: view.state.doc, plugins: [codeHighlight()] }) });
    const html = fresh.dom.innerHTML;
    fresh.destroy();
    return html;
  };

  it("highlights again only the block it types into", () => {
    const py = nth("codeBlock", 1);
    typeAt(py.pos + 1 + "def f(x):".length, " # note");
    expect(highlighted).toHaveBeenCalledTimes(" # note".length);
    for (const [code] of highlighted.mock.calls) expect(code).toMatch(/^def f\(x\):/);
    expect(view.dom.innerHTML).toBe(rebuilt());
  });

  it("highlights nothing for prose typed beside a block", () => {
    const between = nth("paragraph", 1);
    typeAt(between.pos + 1, "Before ");
    typeAt(nth("paragraph", 1).pos + nth("paragraph", 1).node.nodeSize - 1, " after");
    const outro = nth("paragraph", 2);
    typeAt(outro.pos + 1, "Then ");
    expect(highlighted).not.toHaveBeenCalled();
    expect(view.dom.innerHTML).toBe(rebuilt());
  });

  it("colours what is typed at the very start and end of a block's text", () => {
    const ts = nth("codeBlock", 0);
    view.dispatch(view.state.tr.insertText("onst c = 3;\n", ts.pos + 1));
    view.dispatch(view.state.tr.insertText("c", nth("codeBlock", 0).pos + 1));
    const end = nth("codeBlock", 0);
    view.dispatch(view.state.tr.insertText("\nlet d = 4; cons", end.pos + end.node.nodeSize - 1));
    typeAt(nth("codeBlock", 0).pos + nth("codeBlock", 0).node.nodeSize - 1, "t");
    expect(view.dom.innerHTML).toBe(rebuilt());
    expect(Array.from(view.dom.querySelectorAll(".hljs-keyword"), (k) => k.textContent)).toContain("const");
  });

  it("uncolours what is left when a block's first or last character is deleted", () => {
    const ts = nth("codeBlock", 0);
    view.dispatch(view.state.tr.delete(ts.pos + 1, ts.pos + 2));
    expect(view.dom.innerHTML).toBe(rebuilt());
    const end = nth("codeBlock", 0);
    view.dispatch(view.state.tr.delete(end.pos + end.node.nodeSize - 2, end.pos + end.node.nodeSize - 1));
    expect(view.dom.innerHTML).toBe(rebuilt());
    expect(view.dom.querySelector("pre")?.textContent).toBe("onst a = 1;\nlet b = \"two\"");
  });

  it("recolours a block whose language changes", () => {
    const ts = nth("codeBlock", 0);
    expect(view.dom.querySelector("pre .hljs-keyword")?.textContent).toBe("const");
    view.dispatch(view.state.tr.setNodeAttribute(ts.pos, "language", "text"));
    expect(highlighted).toHaveBeenCalledTimes(1);
    expect(view.dom.innerHTML).toBe(rebuilt());
    expect(view.dom.querySelector("pre")?.querySelector(".hljs-keyword")).toBeNull();
    view.dispatch(view.state.tr.setNodeMarkup(ts.pos, undefined, { language: "ts" }));
    expect(view.dom.innerHTML).toBe(rebuilt());
    expect(view.dom.querySelector("pre .hljs-keyword")?.textContent).toBe("const");
  });

  it("comes out as a full rebuild would after splits, joins, pastes and deletes", () => {
    const steps: (() => void)[] = [
      // Split the ts block in two, inside its string.
      () => view.dispatch(view.state.tr.split(nth("codeBlock", 0).pos + 1 + "const a = 1;\nlet b = \"t".length)),
      // Open a string that runs on through the rest of the first half.
      () => typeAt(nth("codeBlock", 0).pos + 1, "\""),
      // Join the halves back up.
      () => view.dispatch(view.state.tr.join(nth("codeBlock", 1).pos)),
      // Paste a new block into the prose, and type in the old one, in one transaction.
      () => {
        const between = nth("paragraph", 1);
        const pasted = docSchema.nodes["codeBlock"]!.create({ language: "py" }, docSchema.text("import os\nprint(os.name)"));
        const tr = view.state.tr.insertText("x = 2\n", nth("codeBlock", 1).pos + 1);
        tr.insert(tr.mapping.map(between.pos), pasted);
        tr.insertText("Lead. ", 1);
        view.dispatch(tr);
      },
      // Delete the json block whole, then the range from the middle of one block into the next.
      () => { const json = nth("codeBlock", 3); view.dispatch(view.state.tr.delete(json.pos, json.pos + json.node.nodeSize)); },
      () => view.dispatch(view.state.tr.delete(nth("codeBlock", 1).pos + 4, nth("codeBlock", 2).pos + 5)),
      () => typeAt(nth("codeBlock", 0).pos + 2, "return "),
    ];
    for (const step of steps) {
      step();
      expect(view.dom.innerHTML).toBe(rebuilt());
    }
    expect(view.dom.querySelectorAll("[class*=hljs-]").length).toBeGreaterThan(0);
  });
});
