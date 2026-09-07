import { useEffect, useMemo, useState } from "react";
import { basenameOf } from "@realm/contracts";
import { useApp } from "../../state/store";

/**
 * A Word, Excel, PowerPoint or iWork file, shown as the picture macOS renders of it.
 *
 * An `<img>` and not an iframe, deliberately. The server answers this path with a PNG (see
 * `quicklook.ts`), and a frame around one buys nothing but a second scrolling context and a border
 * to fight with — while an image gets `alt`, gets the pane's own scroller, and cannot navigate.
 *
 * Two honesty rules shape the rest:
 *
 *  - **The limit is stated, once, under the render.** This is a picture: there is no text to select
 *    and Quick Look gives one page for most formats. Someone who tries to select a paragraph and
 *    fails should have already read why, and the line offers the way out — the file opens in the app
 *    that owns it.
 *  - **A refusal says so.** A generator that declined (a password-protected document, a format with
 *    no generator installed, a machine that is not a Mac) answers 415, and the pane says macOS could
 *    not preview it rather than showing an empty frame that looks like a blank page.
 *
 * `version` is the buffer's disk hash, so an agent rewriting the file re-renders it: the URL changes,
 * the browser fetches, and the server's own cache key is the file's mtime and size.
 */
export function QuickLookView({ documentsId, path, version }: {
  documentsId: string; path: string; version: string | null;
}) {
  const previewInfo = useApp((s) => s.previewInfo);
  const [info, setInfo] = useState<{ port: number; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Reset on every new render request: a file that failed once and has since been fixed must not
  // keep showing the refusal from before the edit.
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    previewInfo().then((i) => { if (!cancelled) setInfo(i); }).catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [previewInfo]);

  const src = useMemo(() => {
    if (!info) return null;
    const rel = path.split("/").map(encodeURIComponent).join("/");
    return `http://127.0.0.1:${info.port}/p/${info.token}/${documentsId}/${rel}?v=${encodeURIComponent(version ?? "")}`;
  }, [info, documentsId, path, version]);

  useEffect(() => { setFailed(false); }, [src]);

  if (error) return <div className="documents-error">Preview unavailable: {error}</div>;
  if (!src) return <div className="pane-placeholder muted">Loading preview…</div>;
  if (failed) {
    return (
      <div className="documents-error">
        macOS could not preview {basenameOf(path)}. It may be password-protected, or this Mac may have
        no Quick Look generator for the format.
      </div>
    );
  }
  return (
    <div className="ql-view">
      <img className="ql-page" src={src} alt={`Preview of ${basenameOf(path)}`} onError={() => setFailed(true)} />
      {/* Under the render, not over it: the limit is worth knowing before you try to select text,
          and it must not sit on top of the document it is describing. */}
      <p className="ql-note">
        A preview of {basenameOf(path)}, rendered by macOS. Realm has no editor for this format, so
        the text cannot be selected and long files may show their first page only.
      </p>
    </div>
  );
}
