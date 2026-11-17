import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { uiBlockKind } from "@realm/contracts";
import { grammarFor, highlightToHtml } from "../session/rich/highlight";
import { loadRichLibs } from "../session/rich/rich-libs";

/**
 * A code block in a Markdown document coloured as the transcript colours a fence: the same
 * highlight.js grammars and the same `.hljs-*` classes, so a theme's `--syn-*` roles reach both.
 *
 * The colour is decorations over the block's text, never marks in the document, so the file is
 * written back exactly as it was read. A block that draws (```mermaid and the rest) is left to its
 * own view, and a fence in a language Realm has no grammar for stays uncoloured.
 */
const key = new PluginKey<DecorationSet>("realm-code-highlight");

export function highlightDecorations(doc: PmNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "codeBlock") return true;
    const language = (node.attrs["language"] as string | null) ?? "";
    if (uiBlockKind(language)) return false;
    const html = highlightToHtml(node.textContent, grammarFor(language));
    if (!html.includes("<span")) return false;
    const parsed = document.createElement("template");
    parsed.innerHTML = html;
    let at = pos + 1;
    const walk = (parent: ParentNode, classes: string) => {
      for (const child of Array.from(parent.childNodes)) {
        if (child instanceof Element) { walk(child, `${classes} ${child.className}`.trim()); continue; }
        const length = child.textContent?.length ?? 0;
        if (classes && length) decorations.push(Decoration.inline(at, at + length, { class: classes }));
        at += length;
      }
    };
    walk(parsed.content, "");
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

export function codeHighlight(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: (_, state) => highlightDecorations(state.doc),
      apply: (tr, old) => (tr.docChanged || tr.getMeta(key) ? highlightDecorations(tr.doc) : old),
    },
    props: { decorations: (state) => key.getState(state) },
    // highlight.js loads after the window is up; a document opened before it lands is coloured when it does.
    view: (view) => {
      let live = true;
      loadRichLibs().then(() => { if (live) view.dispatch(view.state.tr.setMeta(key, true)); }, () => {});
      return { destroy: () => { live = false; } };
    },
  });
}
