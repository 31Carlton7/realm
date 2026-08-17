import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";

marked.setOptions({ gfm: true, breaks: false });
// Links open in the OS browser: main's setWindowOpenHandler denies in-app windows and hands the URL to the shell.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") { node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener noreferrer"); }
});

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false });
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, ADD_ATTR: ["target"] });
}

/** Assistant prose: markdown → sanitized HTML. `streaming` appends a caret. */
export function Markdown({ text, streaming = false, className = "" }: { text: string; streaming?: boolean; className?: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div className={`md ${className}`.trim()} data-streaming={streaming || undefined}>
      <div dangerouslySetInnerHTML={{ __html: html }} />
      {streaming && <span className="md-caret" aria-hidden="true">▍</span>}
    </div>
  );
}
