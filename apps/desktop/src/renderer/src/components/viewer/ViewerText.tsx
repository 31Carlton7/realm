import { Suspense, lazy, useEffect, useState, type ReactNode } from "react";
import { documentKindFor } from "@realm/contracts";

/* The documents pane's own editors, read-only, and split out the way the pane splits them: a look at a
   picture must never pay for CodeMirror or ProseMirror. */
const CodeEditor = lazy(() => import("../../panes/documents/CodeEditor").then((m) => ({ default: m.CodeEditor })));
const RichTextEditor = lazy(() => import("../../panes/documents/RichTextEditor").then((m) => ({ default: m.RichTextEditor })));

/** How the viewer draws a file as text: Markdown rendered, anything else as highlighted source. */
export type TextView = "markdown" | "code";

/**
 * Which files the viewer reads as text rather than asking macOS for a picture of the page.
 *
 * The documents pane's answer, so a file looks the same in the viewer as in the pane it opens into:
 * Markdown is the rich view, source is the code editor, and LaTeX and a CSV are their source — the
 * picture QuickLook makes of any of them is black type on a grey page, in both faces, at a size
 * nobody reads code at. A name with no extension (`Makefile`, `LICENSE`) or a bare dotfile is TRIED
 * as text: the read refuses a binary, and the picture is what such a file falls back to. Everything
 * else — a PDF, a Word file, a page of HTML whose point is how it renders — keeps the picture.
 */
export function textViewFor(path: string): TextView | "try" | null {
  const kind = documentKindFor(path);
  if (kind === "doc" || kind === "slides") return "markdown";
  if (kind === "code" || kind === "latex" || kind === "sheet") return "code";
  if (kind !== "unsupported") return null;
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot === -1 || dot === 0 ? "try" : null;
}

const NOOP = () => {};

/**
 * A text file on the viewer's stage, drawn by the documents pane's own renderers — rendered Markdown,
 * highlighted source with its line numbers — on a sheet of the app's surface, so it reads in the
 * theme and the face the rest of the window is in. Read-only: the viewer is a look, and the pane is
 * one click away in the head for an edit.
 *
 * `fallback` is what the stage shows when the file is not text after all (a binary with no
 * extension, a file past the pane's ceiling) or when there is no bridge to read it through: the
 * picture macOS makes of it, as before.
 */
export function ViewerText({ path, view, version, onBackdrop, fallback }: {
  path: string;
  view: TextView | "try";
  version: number | null;
  onBackdrop: () => void;
  fallback: ReactNode;
}) {
  const [read, setRead] = useState<{ key: string; text: string | null } | null>(null);
  const key = `${path}:${version ?? ""}`;
  useEffect(() => {
    let live = true;
    const readText = window.realm?.files?.readText;
    if (!readText) { setRead({ key, text: null }); return; }
    void readText(path).catch(() => null).then((r) => { if (live) setRead({ key, text: r?.ok ? r.text : null }); });
    return () => { live = false; };
  }, [path, key]);
  if (!read || read.key !== key) return <div className="media-viewer-stage" onClick={onBackdrop} />;
  if (read.text === null) return <>{fallback}</>;
  const shown: TextView = view === "try" ? "code" : view;
  return (
    <div className="media-viewer-stage media-viewer-text" onClick={(e) => { if (e.target === e.currentTarget) onBackdrop(); }}>
      <div className="media-viewer-doc" data-view={shown}>
        <Suspense fallback={null}>
          {shown === "markdown"
            ? <RichTextEditor key={key} text={read.text} onChange={NOOP} readOnly />
            : <CodeEditor key={key} path={path} text={read.text} onChange={NOOP} readOnly blinkCaret={false} />}
        </Suspense>
      </div>
    </div>
  );
}
