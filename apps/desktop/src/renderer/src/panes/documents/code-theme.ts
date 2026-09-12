import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

/**
 * Realm's own code theme, expressed entirely in the app's tokens.
 *
 * **Why not One Dark.** A stock CodeMirror theme ships its own palette, its own surfaces and its own
 * idea of what a keyword looks like, and the result is an editor that is visibly a different product
 * from the pane around it — and one that goes on being dark after the user switches to the light
 * face. Realm already owns a code palette: `--syn-*` in `theme/tokens.css`, seven roles the
 * transcript's fenced blocks and file previews are painted with, which a custom theme repaints as a
 * set (`packages/ui/src/themes.ts`). Naming those roles here is what makes the editor and the
 * transcript show the same file the same way, and what makes a theme switch reach the editor at all.
 *
 * Every value below is a `var()`, never a resolved colour. That is the mechanism: the tokens are
 * plain custom properties on `:root`, so a mode flip or a theme change repaints this editor with no
 * re-render and no listener — the browser recomputes the same declarations against new values.
 *
 * The theme is therefore mode-blind by construction, which is why it is NOT registered with
 * CodeMirror's `dark` flag. That flag is a static claim baked into a class name at module load, and
 * this editor has to be right in both faces of a window the user can flip at any moment.
 */

/** Where the tokens are named, in the order the transcript's own mapping names them (styles.css's
 *  `.hljs-*` block). Kept in step deliberately: one file rendered twice, in a transcript and in an
 *  editor, must not be two different colour schemes. */
const highlight = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--syn-comment)", fontStyle: "italic" },
  {
    tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword,
      t.modifier, t.self, t.null, t.atom, t.bool, t.tagName],
    color: "var(--syn-keyword)",
  },
  { tag: [t.string, t.special(t.string), t.regexp, t.character, t.inserted], color: "var(--syn-string)" },
  { tag: [t.number, t.integer, t.float, t.unit, t.url, t.link, t.escape], color: "var(--syn-number)" },
  {
    tag: [t.heading, t.function(t.variableName), t.function(t.propertyName),
      t.definition(t.function(t.variableName)), t.definition(t.variableName)],
    color: "var(--syn-title)", fontWeight: "var(--fw-title)",
  },
  { tag: [t.typeName, t.className, t.namespace, t.constant(t.name), t.standard(t.name)], color: "var(--syn-type)" },
  { tag: [t.propertyName, t.attributeName, t.labelName, t.definition(t.propertyName)], color: "var(--syn-attr)" },
  { tag: [t.meta, t.processingInstruction, t.documentMeta, t.annotation, t.attributeValue], color: "var(--syn-meta)" },
  // `invalid` shares the deleted colour because both mean "this is wrong or going away", and the
  // palette has one red. A second red for parse errors would be a hue nobody could tell apart.
  { tag: [t.deleted, t.invalid], color: "var(--syn-deleted)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "var(--fw-strong)" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  // Markdown's link text, the one place in the palette where an underline is right: it is describing
  // the source file's own markup, not offering a link to click.
  { tag: t.link, textDecoration: "underline" },
]);

const surface = EditorView.theme({
  /* Transparent, not `--canvas`. A pane sits on the window's own material (design.md, "Surfaces and
     depth"), and a fixed tone painted across the editor stripes that material with a colour it shows
     straight through. What the code rests on is whatever the pane already rests on. */
  "&": {
    backgroundColor: "transparent",
    color: "var(--syn-fg)",
    height: "100%",
  },
  // The caret is the focus indicator inside a text editor; a ring drawn around the whole editing
  // surface on top of it says the same thing twice and boxes in the one area that should read as open.
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    fontSize: "12.5px",
    lineHeight: "1.65",
    // The app's scrollbar rule in styles.css lists its scrollers by class and cannot know about one
    // CodeMirror mints at runtime, so this scroller asks for the same bar itself.
    scrollbarWidth: "thin",
  },
  ".cm-content": { padding: "14px 0", caretColor: "var(--accent)" },
  ".cm-line": { padding: "0 18px 0 8px" },

  /* The gutter is sticky at the left edge and the code scrolls horizontally UNDER it, which is the
     one condition design.md names for a hairline. It also has to be opaque for that reason: a
     transparent rail would show the code passing beneath the line numbers. */
  ".cm-gutters": {
    backgroundColor: "var(--inset)",
    color: "var(--ink-3)",
    border: "none",
    borderRight: "var(--hairline-w) solid var(--line)",
    fontVariantNumeric: "tabular-nums",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 14px", minWidth: "0" },
  ".cm-activeLine": { backgroundColor: "var(--hover)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--ink-2)" },

  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--accent-tint)",
  },
  // Other occurrences of what is selected: a neutral step, not the accent. The accent here would
  // claim every one of them is a selection.
  ".cm-selectionMatch": { backgroundColor: "var(--hover-2)" },

  /* Find. The current match and the rest are the same tint and differ by a RING, rather than by two
     colours — which of twenty highlighted runs the editor is sitting on is a position, not a state,
     and a second hue would have to mean something. */
  ".cm-searchMatch": { backgroundColor: "var(--accent-tint)", borderRadius: "var(--r-sm)" },
  ".cm-searchMatch.cm-searchMatch-selected": { boxShadow: "inset 0 0 0 1px var(--accent)" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "var(--hover-2)", color: "inherit", borderRadius: "var(--r-sm)",
  },
  ".cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket": { color: "var(--syn-deleted)" },

  /* The find/replace panel. A raised surface above the scroller and NOT ruled off from it: the panel
     is a flex sibling, the code clips at its own edge, and nothing ever passes under the boundary —
     which is exactly the case design.md calls decoration. The surface step is the boundary. */
  ".cm-panels": { backgroundColor: "var(--surface)", color: "var(--ink)", border: "none" },
  ".cm-panels.cm-panels-bottom, .cm-panels.cm-panels-top": { border: "none" },
  ".cm-panel.cm-search": { padding: "8px 10px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px" },
  ".cm-panel.cm-search label": { fontSize: "11px", color: "var(--ink-2)", display: "inline-flex", alignItems: "center", gap: "4px" },
  ".cm-panel.cm-search input[type=text]": {
    font: "12px var(--font-mono)", color: "var(--ink)", backgroundColor: "var(--field)",
    border: "var(--hairline-w) solid var(--line)", borderRadius: "var(--r-chip)",
    padding: "5px 8px", minWidth: "180px", outline: "none",
  },
  ".cm-panel.cm-search input[type=text]:focus": { borderColor: "var(--accent)" },
  ".cm-panel.cm-search button, .cm-panel.cm-search button[name=close]": {
    font: "12px inherit", color: "var(--ink-2)", backgroundColor: "var(--inset)", backgroundImage: "none",
    border: "var(--hairline-w) solid var(--line)", borderRadius: "var(--r-chip)", padding: "4px 9px", cursor: "default",
  },
  ".cm-panel.cm-search button:hover": { color: "var(--ink)", backgroundColor: "var(--hover)" },
  ".cm-panel.cm-search button[name=close]": {
    position: "absolute", top: "4px", right: "6px", padding: "2px 6px", backgroundColor: "transparent", border: "none",
  },

  ".cm-tooltip": {
    backgroundColor: "var(--surface)", color: "var(--ink)",
    border: "none", borderRadius: "var(--r-panel)", boxShadow: "var(--shadow-hairline)",
  },
  ".cm-placeholder": { color: "var(--ink-3)" },
});

/** The theme as CodeMirror extensions: the surface rules, then the token colours. */
export const realmCodeTheme = (): Extension[] => [surface, syntaxHighlighting(highlight)];
