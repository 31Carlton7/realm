import { useEffect, useRef } from "react";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, indentUnit } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, Transaction, type Extension } from "@codemirror/state";
import {
  EditorView, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, keymap, lineNumbers, rectangularSelection,
} from "@codemirror/view";
import { codeLanguageFor, type CodeLanguage } from "./code-languages";
import { loadCodeMode } from "./code-modes";
import { realmCodeTheme } from "./code-theme";
import { useScrollMemory } from "../scroll-memory";

/**
 * The source editor for a `code` document (CodeMirror 6).
 *
 * **What this component is and is not.** It is text in, text out — the same contract as
 * `RichTextEditor` and `SheetEditor`, and deliberately so. Dirty state, the autosave tick, the
 * `baseHash` write and the keep-mine / take-theirs bar all live in `DocumentsPane` and `buffers.ts`
 * already, and they are the same policy for a `.ts` file as for a `.md` one: an agent's write and
 * the user's unsaved paragraph must not destroy each other. A code editor with its own conflict
 * dialog would be a second answer to a question the pane has already answered, and the two would
 * drift the first time either was changed.
 *
 * **Why the textarea it replaces was not enough.** Not the colours. A `<textarea>` has no undo that
 * survives a programmatic value change, no find, no bracket matching, no indentation, and a fixed
 * tab that inserts a character instead of a level — which is why editing two wrong characters in a
 * source file meant leaving Realm for a real editor and coming back.
 */
export function CodeEditor({ path, text, onChange, onSave, revealLine = null, scrollKey = null }: {
  /** The document's path. Decides the grammar, and names the editor for a screen reader. */
  path: string;
  text: string;
  onChange: (text: string) => void;
  /** ⌘S. Optional: the pane autosaves anyway, and this only makes "save now" explicit. The binding
   *  is claimed either way, so the key never reaches the browser's own save. */
  onSave?: () => void;
  /** 1-based line to put the cursor on when the file opens — what a `project.grep` row means by
   *  "this match". Null for an ordinary open, which resumes wherever the reader left off. */
  revealLine?: number | null;
  /** Where the reader was in this file, across the unmount a space switch causes (scroll-memory.ts). */
  scrollKey?: string | null;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  /** Everything about the file that changes when the file changes: grammar, wrapping, accessible
   *  name. One compartment rather than three, because they are reconfigured by one event. */
  const perFile = useRef(new Compartment());
  /** The handlers, read through a ref so a new `onChange` identity never rebuilds the editor —
   *  rebuilding would throw away the undo history and the cursor on every keystroke. */
  const handlers = useRef({ onChange, onSave });
  handlers.current = { onChange, onSave };
  /** The last document this editor produced, to recognise its own value arriving back as a prop. */
  const lastEmitted = useRef<string | null>(null);
  /** What the pane currently holds. Read when a view is BUILT — which is usually mount, but is also
   *  any later rebuild, and a rebuild that seeded itself from the first render's text would quietly
   *  revert the file. */
  const currentText = useRef(text);
  currentText.current = text;
  /** The grammar and wrapping this file resolved to. Held outside the view so a rebuilt view is not
   *  left with no grammar until the path happens to change again. */
  const perFileConfig = useRef<Extension>([]);
  const attachScroll = useScrollMemory(scrollKey);

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const v = new EditorView({
      parent,
      state: EditorState.create({
        doc: currentText.current,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          dropCursor(),
          rectangularSelection(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          bracketMatching(),
          // Two spaces, because the alternative is guessing. Reading the file's own indentation would
          // be right more often and wrong invisibly — a file whose first indented line is inside a
          // string literal teaches the editor a width nobody can see, and every subsequent line
          // disagrees with the rest of the repo.
          indentUnit.of("  "),
          highlightSelectionMatches(),
          // Above the code rather than below it. The panel is chrome for the file, and the thing a
          // person looks at while typing a query is the first match — which is at the top far more
          // often than it is at the bottom.
          search({ top: true }),
          /* Order is precedence. Save first so nothing can claim ⌘S; then find, then history, then
             Tab, then the defaults — `defaultKeymap` is last because it is the broadest and would
             otherwise shadow the specific bindings above it. */
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              // Handled even with no `onSave`, on purpose: an unclaimed ⌘S in a packaged Electron app
              // is the browser's own save-page, which is never what a person meant here.
              run: () => { handlers.current.onSave?.(); return true; },
            },
            ...searchKeymap,
            ...historyKeymap,
            /* Tab indents. CodeMirror leaves this unbound by default because it takes Tab away from
               keyboard traversal, and that trade is made knowingly here: a code editor whose Tab key
               moves focus is not a code editor, and every other way out of this pane — ⌘K, the tab
               strip, ⌘⌥arrows, ⌘W — is reachable without it. */
            indentWithTab,
            ...defaultKeymap,
          ]),
          perFile.current.of(perFileConfig.current),
          realmCodeTheme(),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            const next = u.state.doc.toString();
            lastEmitted.current = next;
            handlers.current.onChange(next);
          }),
        ],
      }),
    });
    view.current = v;
    /* The scroller is CodeMirror's own element, not one React rendered, so the hook cannot be
       attached as a ref and is called by hand. Its ref-callback cleanup is real (it removes the
       scroll listener and the settle loop) and is simply not in the hook's `void` return type. */
    const detach = (attachScroll as (el: HTMLElement | null) => (() => void) | void)(v.scrollDOM);
    return () => {
      // `void` in the hook's return type, a real cleanup at runtime — checked rather than cast twice.
      if (typeof detach === "function") detach();
      v.destroy();
      view.current = null;
      lastEmitted.current = null;
    };
  }, [attachScroll]);

  // ---- the grammar, fetched for this file only -----------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    const language = codeLanguageFor(path);
    void loadCodeMode(language)
      .then((mode) => {
        if (cancelled) return;
        perFileConfig.current = [
          ...(mode ? [mode] : []),
          /* Prose wraps; code does not. A wrapped line of source destroys the column structure that
             makes it readable, and an unwrapped paragraph of Markdown runs off the screen — so this
             follows the grammar rather than being a setting nobody would find. */
          ...(WRAPS.has(language) ? [EditorView.lineWrapping] : []),
          // The editing surface is a `contenteditable`, so its accessible name has to be set on it
          // rather than on the box around it, and it names the FILE — "Edit" alone is every tab.
          EditorView.contentAttributes.of({ "aria-label": `Edit ${path.split("/").pop() ?? path}` }),
        ];
        view.current?.dispatch({ effects: perFile.current.reconfigure(perFileConfig.current) });
      })
      // A grammar chunk that fails to load (an interrupted update, an offline first run) leaves an
      // editor with no colours, which is the same outcome as a file we have no grammar for.
      .catch(() => {});
    return () => { cancelled = true; };
  }, [path]);

  // ---- land on the line a search sent us to --------------------------------------------------------
  useEffect(() => {
    const v = view.current;
    if (!v || revealLine === null) return;
    // Clamped rather than ignored when out of range: the file may have been edited between the search
    // and the open, and the top of the right file beats an error about the wrong line.
    const line = v.state.doc.line(Math.min(Math.max(1, revealLine), v.state.doc.lines));
    v.dispatch({
      selection: { anchor: line.from },
      // `center`, not `nearest`: a match scrolled to the last visible row is a match with no context
      // under it, which is most of what a person reads a search result for.
      effects: EditorView.scrollIntoView(line.from, { y: "center" }),
    });
    v.focus();
  }, [revealLine, path]);

  // ---- disk moved under us ------------------------------------------------------------------------
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    // Our own emission echoing back through the buffer. Replacing the document with itself would
    // collapse the selection and put an identical change on the undo stack, once per keystroke.
    if (text === lastEmitted.current) return;
    const current = v.state.doc.toString();
    if (text === current) return;
    const { anchor, head } = v.state.selection.main;
    v.dispatch({
      changes: { from: 0, to: current.length, insert: text },
      // Clamped rather than reset: a clean buffer reloading after an agent edited the file elsewhere
      // should leave the reader roughly where they were, and a shorter file must not leave the
      // selection past the end.
      selection: { anchor: Math.min(anchor, text.length), head: Math.min(head, text.length) },
      /* Not undoable. ⌘Z after an outside reload would otherwise restore a version of the file that
         no longer exists on disk, and the next save would write it back over the agent's work —
         which is the exact failure `baseHash` exists to prevent, reintroduced through the keyboard.
         Taking or discarding an outside change is what the pane's conflict bar is for. */
      annotations: Transaction.addToHistory.of(false),
    });
  }, [text]);

  return <div className="documents-code" ref={host} />;
}

/** Grammars whose files are read as prose rather than as columns. */
const WRAPS: ReadonlySet<CodeLanguage> = new Set<CodeLanguage>(["markdown", "text"]);
