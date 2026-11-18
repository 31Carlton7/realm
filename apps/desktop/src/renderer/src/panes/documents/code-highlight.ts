import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
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
    decorations.push(...blockDecorations(node, pos));
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

function blockDecorations(node: PmNode, pos: number): Decoration[] {
  const language = (node.attrs["language"] as string | null) ?? "";
  if (uiBlockKind(language)) return [];
  const html = highlightToHtml(node.textContent, grammarFor(language));
  if (!html.includes("<span")) return [];
  const parsed = document.createElement("template");
  parsed.innerHTML = html;
  const decorations: Decoration[] = [];
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
  return decorations;
}

/**
 * The colours after an edit: the old ones carried through it, and only the code blocks it touched
 * highlighted again. Highlighting every block on every keystroke costs seconds in a long document.
 */
function rehighlightTouched(tr: Transaction, old: DecorationSet, before: PmNode): DecorationSet {
  const changed: [number, number][] = [];
  tr.mapping.maps.forEach((map, i) => {
    const after = tr.mapping.slice(i + 1);
    map.forEach((_oldFrom, _oldTo, from, to) => changed.push([after.map(from, -1), after.map(to, 1)]));
  });
  const back = tr.mapping.invert();
  let set = old.map(tr.mapping, tr.doc);
  tr.doc.descendants((node, pos) => {
    if (node.type.name !== "codeBlock") return !node.isTextblock;
    const from = pos + 1;
    const to = pos + node.nodeSize - 1;
    const was = before.nodeAt(back.map(pos));
    const touched = changed.some(([a, b]) => a <= to && b >= from)
      || was?.type !== node.type || was.attrs["language"] !== node.attrs["language"];
    if (touched) set = set.remove(set.find(from, to)).add(tr.doc, blockDecorations(node, pos));
    return false;
  });
  return set;
}

export function codeHighlight(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: (_, state) => highlightDecorations(state.doc),
      apply: (tr, old, before) => {
        if (tr.getMeta(key)) return highlightDecorations(tr.doc);
        return tr.docChanged ? rehighlightTouched(tr, old, before.doc) : old;
      },
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
