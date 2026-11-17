import { EditorState } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import type { HLJSApi } from "highlight.js";
import { describe, expect, it, vi } from "vitest";
import { codeHighlight } from "./code-highlight";
import { docSchema, parseMarkdown } from "./markdown-model";

/** highlight.js loads after the window is up (`rich-libs.ts`), so a document can open before it has. */
const libs = vi.hoisted(() => ({ hljs: null as HLJSApi | null, land: () => {} }));
vi.mock("../session/rich/rich-libs", () => ({
  hljsIfLoaded: () => libs.hljs,
  loadRichLibs: () => new Promise<void>((resolve) => { libs.land = resolve; }),
}));

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
