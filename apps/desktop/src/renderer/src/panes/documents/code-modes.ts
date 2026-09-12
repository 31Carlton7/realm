import type { Extension } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";
import type { CodeLanguage } from "./code-languages";

/**
 * Grammar id → the CodeMirror extension that parses it, loaded on demand.
 *
 * **Every arm is a dynamic import, and that is the whole point.** A grammar is a parse table; the
 * fourteen here plus the legacy modes are a few hundred kilobytes that a person editing one `.ts`
 * file must never pay for. Vite splits each `import()` into its own chunk, so opening a Python file
 * fetches the Python grammar and nothing else, and a workspace of Markdown fetches none of them.
 * A static table of `LanguageSupport` values — the obvious first draft — puts all of them in the
 * renderer's main bundle, which is the same mistake `DocumentsPane` already avoids for TipTap.
 *
 * A `switch` rather than a record of thunks because the import specifiers must be literal for the
 * bundler to see them, and because TypeScript then checks the arms against `CodeLanguage` for us:
 * adding a grammar to the table without adding it here is a compile error rather than a file that
 * silently opens grey.
 */
export async function loadCodeMode(language: CodeLanguage): Promise<Extension | null> {
  switch (language) {
    // One package, four configurations. The JSX and TypeScript flags are not cosmetic: the plain
    // JavaScript parser rejects `x as Y` and the non-JSX one rejects `<div/>`, and a rejected parse
    // is a file with a red squiggle from the first angle bracket to the end.
    case "javascript": return (await import("@codemirror/lang-javascript")).javascript();
    case "jsx": return (await import("@codemirror/lang-javascript")).javascript({ jsx: true });
    case "typescript": return (await import("@codemirror/lang-javascript")).javascript({ typescript: true });
    case "tsx": return (await import("@codemirror/lang-javascript")).javascript({ jsx: true, typescript: true });

    case "json": return (await import("@codemirror/lang-json")).json();
    case "markdown": return (await import("@codemirror/lang-markdown")).markdown();
    case "css": return (await import("@codemirror/lang-css")).css();
    case "html": return (await import("@codemirror/lang-html")).html();
    case "xml": return (await import("@codemirror/lang-xml")).xml();
    case "python": return (await import("@codemirror/lang-python")).python();
    case "yaml": return (await import("@codemirror/lang-yaml")).yaml();
    case "rust": return (await import("@codemirror/lang-rust")).rust();
    case "go": return (await import("@codemirror/lang-go")).go();
    case "java": return (await import("@codemirror/lang-java")).java();
    case "php": return (await import("@codemirror/lang-php")).php();
    case "sql": return (await import("@codemirror/lang-sql")).sql();
    case "c": return (await import("@codemirror/lang-cpp")).cpp();
    case "cpp": return (await import("@codemirror/lang-cpp")).cpp();

    /* The rest have no Lezer grammar, so they come from the CodeMirror 5 stream parsers. These are
       line-oriented tokenizers rather than real parsers: they colour correctly and they do not give
       the editor a syntax tree, which costs indentation and bracket matching and nothing else the
       pane uses. Shipping a worse highlighter for shell beats shipping none for it. */
    case "shell": return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/shell")).shell);
    case "toml": return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/toml")).toml);
    case "swift": return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/swift")).swift);
    case "ruby": return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/ruby")).ruby);
    case "perl": return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/perl")).perl);
    case "lua": return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/lua")).lua);
    case "r": return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/r")).r);
    case "haskell": return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/haskell")).haskell);
    case "dockerfile": return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/dockerfile")).dockerFile);
    case "properties": return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/properties")).properties);
    case "diff": return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/diff")).diff);
    case "protobuf": return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/protobuf")).protobuf);
    case "kotlin": return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/clike")).kotlin);
    case "scala": return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/clike")).scala);
    case "csharp": return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/clike")).csharp);
    case "objectivec": return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/clike")).objectiveC);
    case "dart": return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/clike")).dart);

    // Not a missing grammar — the absence of one. The editor is still an editor.
    case "text": return null;
  }
}
