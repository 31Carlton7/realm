import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useMemo, useRef, type MouseEvent as ReactMouseEvent } from "react";

marked.setOptions({ gfm: true, breaks: false });
// Links open in the OS browser: main's setWindowOpenHandler denies in-app windows and hands the URL to the shell.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") { node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener noreferrer"); }
});

/** How long the copy button holds its ✓ before cross-fading back (matches ToolCard's COPIED_MS). */
const COPIED_MS = 1400;

/* The copy button's two glyphs (BUI CodeBlock's copy/check pair). Static markup injected AFTER
 * sanitize — never derived from the markdown itself — and classed .tool-copy so the §6 icon swap
 * is the same rule ToolCard's copy buttons use. */
const COPY_BUTTON_HTML =
  '<svg class="copy-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
  '<svg class="copied-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>';

/** Post-sanitize DOM pass (DOMParser is inert — never executes scripts; the input is already
 *  DOMPurify-clean, and everything added here is our own static markup):
 *  - A-M1: a wide table must scroll inside its own container instead of stretching the transcript.
 *  - Plan 9 W2 (BUI CodeBlock): each fenced block becomes an editor panel — a header naming the
 *    fence's language beside a copy control, the <pre> as the body. The button is inert HTML;
 *    the Markdown component below wires it up by delegation. */
function decorate(html: string): string {
  if (!html.includes("<table") && !html.includes("<pre")) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const table of Array.from(doc.body.querySelectorAll("table"))) {
    const wrap = doc.createElement("div");
    wrap.className = "md-scroll";
    table.replaceWith(wrap);
    wrap.appendChild(table);
  }
  for (const pre of Array.from(doc.body.querySelectorAll("pre"))) {
    const lang = /language-([\w+-]+)/.exec(pre.querySelector("code")?.className ?? "")?.[1] ?? "";
    const wrap = doc.createElement("div");
    wrap.className = "md-code";
    const head = doc.createElement("div");
    head.className = "md-code-head";
    const label = doc.createElement("span");
    label.className = "md-code-lang";
    label.textContent = lang;
    const copy = doc.createElement("button");
    copy.type = "button";
    copy.className = "md-copy tool-copy";
    copy.setAttribute("aria-label", "Copy code");
    copy.title = "Copy";
    copy.innerHTML = COPY_BUTTON_HTML;
    head.append(label, copy);
    pre.replaceWith(wrap);
    wrap.append(head, pre);
  }
  return doc.body.innerHTML;
}

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false });
  return decorate(DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, ADD_ATTR: ["target"] }));
}

/** Assistant prose: markdown → sanitized HTML. `streaming` appends BUI StreamText's caret — a solid
 *  2px ink bar (the stream is live exactly as long as the caret exists, so it never blinks). The
 *  text itself is whatever has actually arrived: deltas pace the stream, there is no reveal timer,
 *  so a re-render can never replay it. `enter` opts the block into the transcript's 180ms enter
 *  animation (§6 — set only for blocks that are genuinely new). */
export function Markdown({ text, streaming = false, className = "", enter = false }: { text: string; streaming?: boolean; className?: string; enter?: boolean }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  // Copy buttons live inside dangerouslySetInnerHTML, so they are wired by delegation; the ✓ hold
  // is a DOM attribute (the injected nodes are outside React's tree), timers cleared on unmount.
  const timers = useRef(new Map<Element, ReturnType<typeof setTimeout>>());
  useEffect(() => () => { for (const t of timers.current.values()) clearTimeout(t); }, []);
  const onClick = (e: ReactMouseEvent) => {
    const btn = e.target instanceof Element ? e.target.closest(".md-copy") : null;
    if (!btn) return;
    const code = btn.closest(".md-code")?.querySelector("pre")?.textContent ?? "";
    void navigator.clipboard.writeText(code);
    btn.setAttribute("data-copied", "");
    clearTimeout(timers.current.get(btn));
    timers.current.set(btn, setTimeout(() => { btn.removeAttribute("data-copied"); timers.current.delete(btn); }, COPIED_MS));
  };
  return (
    <div className={`md ${className}`.trim()} data-streaming={streaming || undefined} data-enter={enter || undefined}>
      <div dangerouslySetInnerHTML={{ __html: html }} onClick={onClick} />
      {streaming && <span className="md-caret" aria-hidden="true" />}
    </div>
  );
}
