import { useEffect, useRef } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { Icon } from "@realm/ui";
import { RawBlock, TABLE_EXTENSIONS, parseMarkdown, serializeMarkdown } from "./markdown-model";
import { useScrollMemory } from "../scroll-memory";

/**
 * The WYSIWYG half of the docs editor (Plan 17 W2). Markdown in, markdown out; the file on disk stays
 * the source of truth and this is a view over it.
 *
 * **Why the document is dispatched rather than `setContent`.** Round-trip fidelity rests on ProseMirror
 * node identity: `parseMarkdown` records each top-level block's original source in a WeakMap keyed by
 * the node object, and `serializeMarkdown` gives those bytes back for every block the user did not
 * touch. `setContent(json)` rebuilds every node from JSON, so all of that identity — and with it every
 * preserved byte — would be thrown away on load, and the first keystroke would rewrite the whole file
 * (measured at 72% of lines on this repo's own docs). Replacing the document with the parsed nodes
 * themselves keeps identity intact, so only edited blocks are ever re-serialized.
 */
export function RichTextEditor({ text, onChange, scrollKey = null }: {
  text: string; onChange: (markdown: string) => void;
  /** What this column is, for the scroll memory that survives a space switch (scroll-memory.ts).
   *  Null opts out — the read-only mounts have no reader to put back. */
  scrollKey?: string | null;
}) {
  const scroll = useScrollMemory(scrollKey);
  /** Set while this component is writing the document, so programmatic changes are not read as edits. */
  const applying = useRef(false);
  /** The last markdown this editor produced, to recognise its own value coming back down as a prop. */
  const lastEmitted = useRef<string | null>(null);

  const editor = useEditor({
    extensions: [StarterKit, Image.configure({ inline: true }), ...TABLE_EXTENSIONS, RawBlock],
    editorProps: { attributes: { class: "documents-rich-surface", "aria-label": "Rich text editor" } },
    onUpdate: ({ editor: ed }) => {
      if (applying.current) return;
      const md = serializeMarkdown(ed.state.doc);
      lastEmitted.current = md;
      onChange(md);
    },
  });

  useEffect(() => {
    // `isDestroyed` is load-bearing, not defensive: under React 19, TipTap's useEditor destroys and
    // recreates the editor across a commit, and this effect still fires once against the STALE
    // instance — whose `schema` getter returns null after destroy. Parsing against that crashed the
    // whole pane in the built app (found by the live check; jsdom's lifecycle never hit it). The
    // recreated editor changes the `editor` dep, so the effect re-runs against the live one.
    if (!editor || editor.isDestroyed) return;
    // Our own emission echoing back through the buffer: re-parsing it would replace every node object
    // and destroy the identity the preserved source is keyed on, for no visible change.
    if (text === lastEmitted.current) return;
    // Parsed against the EDITOR's schema: TipTap builds its own Schema instance, and ProseMirror
    // will not accept a node created against another one — it drops it, leaving a blank document.
    const doc = parseMarkdown(text, editor.schema);
    applying.current = true;
    try {
      const { state, view } = editor;
      // `replaceWith` inserts these exact node objects, which is what carries the WeakMap entries into
      // the live document.
      view.dispatch(state.tr.replaceWith(0, state.doc.content.size, doc.content).setMeta("addToHistory", false));
    } finally {
      applying.current = false;
    }
  }, [editor, text]);

  if (!editor) return <div className="documents-rich" />;
  return (
    <div className="documents-rich">
      <RichToolbar editor={editor} />
      {/* The class is load-bearing, not decorative. `EditorContent` renders a plain wrapper div
          between this flex column and the ProseMirror element that actually scrolls, and a wrapper
          with no `flex`/`min-height` sizes to its CONTENT — so the scroller inside it was never
          bounded and a long document grew the pane instead of scrolling (measured: a 4148px surface
          in an 860px pane). The scroll lives on the wrapper rather than on ProseMirror so that the
          editor's own selection and caret handling never fight a scroll container it does not know
          about. */}
      {/* The ref is the scroll memory's, and it lands on the same wrapper for the same reason the
          class does: that div is what scrolls. It attaches while the div is still EMPTY — ProseMirror
          appends into it a beat later — which is exactly the case the hook's settle loop exists for. */}
      <EditorContent editor={editor} className="documents-rich-scroll" ref={scroll} />
    </div>
  );
}

type Ed = NonNullable<ReturnType<typeof useEditor>>;

function RichToolbar({ editor }: { editor: Ed }) {
  const btn = (label: string, icon: Parameters<typeof Icon>[0]["name"], active: boolean, run: () => void) => (
    <button className="icon-btn" aria-label={label} aria-pressed={active} title={label}
      onClick={() => { run(); editor.commands.focus(); }}>
      <Icon name={icon} size={14} />
    </button>
  );
  return (
    <div className="documents-rich-toolbar">
      {btn("Bold", "edit", editor.isActive("bold"), () => editor.chain().toggleBold().run())}
      {btn("Italic", "idea", editor.isActive("italic"), () => editor.chain().toggleItalic().run())}
      {btn("Inline code", "code", editor.isActive("code"), () => editor.chain().toggleCode().run())}
      <span className="documents-rich-sep" />
      {[1, 2, 3].map((level) => (
        <button key={level} className="icon-btn documents-h" aria-label={`Heading ${level}`}
          aria-pressed={editor.isActive("heading", { level })}
          onClick={() => { editor.chain().toggleHeading({ level: level as 1 | 2 | 3 }).run(); editor.commands.focus(); }}>
          H{level}
        </button>
      ))}
      <span className="documents-rich-sep" />
      {btn("Bulleted list", "more", editor.isActive("bulletList"), () => editor.chain().toggleBulletList().run())}
      {btn("Quote", "chevronRight", editor.isActive("blockquote"), () => editor.chain().toggleBlockquote().run())}
      {btn("Code block", "terminal", editor.isActive("codeBlock"), () => editor.chain().toggleCodeBlock().run())}
    </div>
  );
}
