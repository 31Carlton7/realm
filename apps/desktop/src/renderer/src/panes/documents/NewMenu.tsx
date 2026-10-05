import { Icon } from "@realm/ui";
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { documentKindFor, extOf, freeFileName, type DocumentKind } from "@realm/contracts";
import { Menu, type MenuItem } from "../../components/Menu";
import { useDissolve } from "../../components/ScrollFades";
import { useAnchoredPopover } from "../../components/use-anchored-popover";
import { CODE_FILE_LANGUAGES, planNewFile, withExtension } from "./home-model";

/**
 * What New offers. `menu` and `stem` are written out rather than derived from one another, because
 * the one case where a rule would have been tidy — lowercasing the menu word to build the stem — is
 * the case that gets it wrong: "LaTeX" is not "latex".
 */
export const NEW_KINDS: { kind: DocumentKind; menu: string; detail: string; stem: string; ext: string }[] = [
  { kind: "doc", menu: "Document", detail: "Markdown, written as rich text", stem: "Untitled document", ext: "md" },
  { kind: "sheet", menu: "Spreadsheet", detail: "A CSV in a grid, with formulas", stem: "Untitled spreadsheet", ext: "csv" },
  { kind: "slides", menu: "Presentation", detail: "Slides, written in Markdown", stem: "Untitled presentation", ext: "slides.md" },
  { kind: "latex", menu: "LaTeX", detail: "A paper, in source", stem: "Untitled LaTeX", ext: "tex" },
  // Plan 22: an interactive study guide — self-contained HTML the preview server renders.
  { kind: "html", menu: "Study guide", detail: "A page with quizzes and step-throughs", stem: "Untitled guide", ext: "html" },
];

type DocIcon = "artifact" | "documents" | "table" | "browser" | "layout" | "code";

export function iconForKind(k: DocumentKind): DocIcon {
  return k === "sheet" ? "table" : k === "html" ? "browser" : k === "slides" ? "layout"
    : k === "code" ? "code"
    : k === "unsupported" || k === "pdf" ? "artifact" : "documents";
}
export const iconFor = (path: string): DocIcon => iconForKind(documentKindFor(path));

/** The extension "Code file…" starts on: the last one picked this run, so someone writing Python
 *  is not walked back to TypeScript every time. In memory only — a preference nobody set is not
 *  worth a row in the settings table. */
let lastCodeExt = "ts";

/**
 * New — one menu for every kind of file the pane writes, and "Open a file…" for one it already has.
 *
 * Drawn in the app rather than by the OS (`Menu`'s `inApp`): the rows say what each kind IS, and the
 * one row that most needed saying was the code editor's. A code file was always a document the pane
 * could write — any name ending in `.ts` or `.py` — and nothing on screen said so, so nobody knew.
 * "Code file…" asks for its language or its name, because that is the one decision it needs made.
 */
export function NewMenu({ variant, folder, onNewKind, onNewFile, onOpenExisting, taken }: {
  /** The strip's "+" or the home's labelled button. Two openers for one menu must not share a name:
   *  the strip's is always there, the home's is the page's own. */
  variant: "strip" | "home";
  /** The checkout's folder name, for the open row's description. */
  folder: string | null;
  onNewKind: (kind: DocumentKind, ext: string, stem: string) => void;
  /** Make a file by its whole name — what the code prompt hands back. */
  onNewFile: (name: string) => void;
  onOpenExisting: () => void;
  /** The names already at the top of the folder, lowercased: the prompt numbers its default past
   *  them and refuses a typed one that is taken. Asked for when the prompt opens. */
  taken: () => Promise<ReadonlySet<string>>;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState<ReadonlySet<string> | null>(null);
  const items: MenuItem[] = [
    { kind: "header", label: "New" },
    ...NEW_KINDS.slice(0, 1).map(row),
    {
      label: "Code file…", icon: <Icon name="code" size={16} />,
      detail: "Any language — the editor follows the extension",
      onSelect: () => { void taken().catch(() => new Set<string>()).then(setPrompt); },
    },
    ...NEW_KINDS.slice(1).map(row),
    { kind: "header", label: "Open" },
    { label: "A file in this folder…", icon: <Icon name="folder" size={16} />, detail: folder ?? undefined, onSelect: onOpenExisting },
  ];
  function row({ kind, menu, detail, stem, ext }: (typeof NEW_KINDS)[number]): MenuItem {
    return { label: menu, icon: <Icon name={iconForKind(kind)} size={16} />, detail, onSelect: () => onNewKind(kind, ext, stem) };
  }
  return (
    <>
      <button ref={ref} type="button" aria-haspopup="menu" aria-expanded={open}
        className={variant === "home" ? "btn docs-home-new" : "icon-btn documents-new"}
        aria-label={variant === "home" ? undefined : "Add a document"}
        title={variant === "home" ? "Make a document, a code file or a sheet" : "Add a document"}
        onClick={() => setOpen((v) => !v)}>
        <Icon name="add" size={variant === "home" ? 14 : 13} />
        {variant === "home" && <>New<Icon name="chevronDown" size={12} className="docs-home-new-chevron" /></>}
      </button>
      {open && <Menu items={items} anchorRef={ref} onClose={() => setOpen(false)} label="New" inApp className="new-doc-menu"
        align={variant === "home" ? "right" : "left"} />}
      {prompt && (
        <CodeFilePrompt anchorRef={ref} taken={prompt} align={variant === "home" ? "right" : "left"}
          onCreate={(name) => { lastCodeExt = extOf(name) || lastCodeExt; setPrompt(null); onNewFile(name); }}
          onClose={() => setPrompt(null)} />
      )}
    </>
  );
}

/**
 * A code file, asked for by language or by name: one field holding the whole name, and the languages
 * under it. Picking a language rewrites the extension; typing one picks the language — the name is the
 * one source of truth, because it is what decides the editor once the file exists.
 *
 * A panel rather than a menu, because it holds a field. It opens on `untitled.<last language>` with
 * the stem selected, so the first keystroke names the file and Return makes it.
 */
export function CodeFilePrompt({ anchorRef, taken, align = "left", onCreate, onClose }: {
  anchorRef: RefObject<HTMLElement | null>;
  taken: ReadonlySet<string>;
  align?: "left" | "right";
  onCreate: (name: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const { pos, closing, close } = useAnchoredPopover({ ref, anchorRef, align, onClose, returnFocusRef: anchorRef, exit: true });
  // The languages scroll inside the panel and run out into its edges, as a menu's rows do.
  useDissolve(list);
  const [name, setName] = useState(() => freeFileName("untitled", lastCodeExt, taken));
  const plan = useMemo(() => planNewFile(name, taken), [name, taken]);
  const at = CODE_FILE_LANGUAGES.findIndex((l) => l.ext === extOf(name.trim()));

  // The stem selected once the panel is placed — a field is not focusable while it is hidden.
  const selected = useRef(false);
  useLayoutEffect(() => {
    const el = field.current;
    if (!pos || !el || selected.current) return;
    selected.current = true;
    el.focus();
    el.setSelectionRange(0, Math.max(0, name.lastIndexOf(".")));
  }, [pos, name]);
  useLayoutEffect(() => {
    if (at >= 0) list.current?.querySelector(`[data-index="${at}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [at]);

  const pick = (i: number) => {
    const lang = CODE_FILE_LANGUAGES[(i + CODE_FILE_LANGUAGES.length) % CODE_FILE_LANGUAGES.length]!;
    setName((n) => withExtension(n, lang.ext));
  };
  const create = () => { if (plan?.ok) onCreate(plan.name); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); pick(at + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); pick(at < 0 ? -1 : at - 1); }
    else if (e.key === "Enter") { e.preventDefault(); create(); }
    // Stopped here: the pane's own Escape (and the session's interrupt behind it) must not hear it.
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
  };
  const style: CSSProperties = { position: "fixed", left: pos?.left ?? -9999, top: pos?.top ?? -9999,
    visibility: pos ? "visible" : "hidden", transformOrigin: pos?.origin ?? "top left" };

  return createPortal(
    <div ref={ref} role="dialog" aria-label="New code file" className="menu code-file-prompt" style={style}
      data-closing={closing || undefined} inert={closing} onKeyDown={onKey}>
      <label className="code-file-name">
        <span className="code-file-head">New code file</span>
        <input ref={field} className="search-field" value={name} spellCheck={false} aria-label="File name"
          aria-controls="code-file-languages" aria-describedby="code-file-says"
          onChange={(e) => setName(e.target.value)} />
      </label>
      <div ref={list} id="code-file-languages" className="code-file-languages" role="listbox" aria-label="Language">
        {CODE_FILE_LANGUAGES.map((l, i) => (
          <div key={l.ext} role="option" aria-selected={i === at} data-index={i} className="code-file-language"
            onMouseDown={(e) => e.preventDefault()} onClick={() => pick(i)}>
            <span className="code-file-language-name">{l.label}</span>
            <span className="code-file-language-ext">.{l.ext}</span>
          </div>
        ))}
      </div>
      <div className="code-file-foot">
        <p id="code-file-says" className="code-file-says" data-tone={plan && !plan.ok ? "warning" : undefined}>
          {plan ? plan.says : "End the name with an extension, or pick a language."}
        </p>
        <button type="button" className="btn primary" disabled={!plan?.ok} onClick={create}>Create</button>
      </div>
    </div>,
    document.body,
  );
}
