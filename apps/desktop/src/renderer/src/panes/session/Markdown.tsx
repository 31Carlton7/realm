import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { grammarFor, highlightToHtml } from "./rich/highlight";
import { mathExtension } from "./rich/math";
import { mediaExtension, mediaRefsIn } from "./media/md-media";
import { MediaFrame, MediaLightbox } from "./media/MediaView";
import { useMediaByCandidate } from "./media/use-media";

marked.setOptions({ gfm: true, breaks: false });
/* Fenced code is tokenised here rather than left as plain text (Plan 24 W1). It happens BEFORE
 * sanitize on purpose: highlight.js emits only `<span class>` and escapes everything else, and
 * running its output through DOMPurify with the rest of the document keeps one gate for all
 * generated markup instead of a trusted side channel around it. The `language-*` class survives so
 * `decorate` below can still label the block's header. */
marked.use({
  renderer: {
    code({ text, lang }) {
      const name = (lang ?? "").trim().split(/\s+/)[0] ?? "";
      const grammar = grammarFor(name);
      const cls = ["hljs", name && `language-${name.toLowerCase().replace(/[^\w+-]/g, "")}`].filter(Boolean).join(" ");
      // The trailing newline is marked\'s own: a fence\'s last line ends in one, and dropping it
      // changes what the copy button puts on the clipboard.
      return `<pre><code class="${cls}">${highlightToHtml(text, grammar)}\n</code></pre>\n`;
    },
  },
});
marked.use(mathExtension);
/* Local `![](…)` and `[](…)` become parked placeholders the component below fills with a real
 * player. AFTER the math extension so a formula is never mistaken for a path. */
marked.use(mediaExtension);
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
/** GitHub's admonition syntax: a blockquote whose first line is `[!NOTE]` (or TIP / IMPORTANT /
 *  WARNING / CAUTION). Agents write these constantly and a plain grey bar throws away the one thing
 *  the marker was for — which of the five it is. Anything else in the brackets is left alone. */
const CALLOUTS = new Set(["note", "tip", "important", "warning", "caution"]);

function decorate(html: string): string {
  if (!html.includes("<table") && !html.includes("<pre") && !html.includes("<blockquote")) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const quote of Array.from(doc.body.querySelectorAll("blockquote"))) {
    const first = quote.firstElementChild;
    const m = /^\[!(\w+)\]\s*/.exec(first?.textContent ?? "");
    const kind = m?.[1]?.toLowerCase() ?? "";
    if (!first || !CALLOUTS.has(kind)) continue;
    // The marker line is the callout's TITLE, not its body: it becomes the header, and whatever the
    // agent wrote after it on the same line stays as the first paragraph.
    first.textContent = first.textContent!.slice(m![0].length);
    if (!first.textContent.trim()) first.remove();
    const head = doc.createElement("div");
    head.className = "md-callout-head";
    head.textContent = kind.charAt(0).toUpperCase() + kind.slice(1);
    quote.prepend(head);
    quote.className = "md-callout";
    quote.setAttribute("data-kind", kind);
  }
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
  /* MathML and SVG join the HTML profile for KaTeX's sake: it emits `<math>` alongside its visual
   * markup (so the expression can be selected, copied and read aloud) and `<svg>` for the parts CSS
   * cannot draw — surd bars, stretchy braces. With the html profile alone the sanitizer strips both
   * and every formula loses its accessible half and its radicals. */
  return decorate(DOMPurify.sanitize(html, { USE_PROFILES: { html: true, mathMl: true, svg: true }, ADD_ATTR: ["target"] }));
}

/** Assistant prose: markdown → sanitized HTML. The text itself is whatever has actually arrived:
 *  deltas pace the stream, there is no reveal timer, so a re-render can never replay it. `enter`
 *  opts the block into the transcript's 180ms enter animation (§6 — set only for blocks that are
 *  genuinely new). */
export function Markdown({ text, className = "", enter = false }: { text: string; className?: string; enter?: boolean }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  const body = useRef<HTMLDivElement>(null);
  const media = useMediaPortals(body, html);
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
    <div className={`md ${className}`.trim()} data-enter={enter || undefined}>
      {/* The markup is written imperatively rather than through `dangerouslySetInnerHTML`, and the
          reason is portals: React 19 does not commit a portal into a node it created by setting
          innerHTML, so media parked inside the prose would never appear. A node the effect below
          made is an ordinary foreign node, and portals into it land. The string is the same
          DOMPurify-clean html either way. */}
      <div ref={body} onClick={onClick} />
      {media}
    </div>
  );
}

/**
 * Fills the placeholders `mediaExtension` parked for `![](/local/path)` with real players.
 *
 * Portals rather than markup: the player is a React component with state (playing, muted, the
 * scrub position) and the surrounding prose is an innerHTML blob React does not own. A portal is
 * what lets the two coexist — the span stays where the sentence put it, and the component inside it
 * survives every re-render the stream causes, so a video does not restart mid-message.
 *
 * Nothing is drawn for a path main did not confirm. An agent that embeds a file it failed to write
 * leaves the empty span it always would have, not a broken frame.
 */
function useMediaPortals(body: React.RefObject<HTMLDivElement | null>, html: string) {
  const [refs, setRefs] = useState<{ path: string; el: HTMLElement }[]>([]);
  // Layout effect, not effect: the markup has to be in the DOM before the browser paints, or every
  // message would flash empty for a frame — and, while streaming, on every delta.
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    el.innerHTML = html;
    const found = mediaRefsIn(el);
    // Replacing the array unconditionally would re-portal on every delta of a streaming message.
    setRefs((prev) => (prev.length === found.length && prev.every((r, i) => r.el === found[i]!.el) ? prev : found));
  }, [html, body]);
  // Keyed by the candidate, not the resolved path: the placeholder holds `~/out/clip.mp4` and main
  // answers `/Users/me/out/clip.mp4`, so a by-path lookup would find nothing for every `~` embed.
  const byCandidate = useMediaByCandidate(refs.map((r) => r.path));
  const [open, setOpen] = useState<import("@realm/contracts").MediaFile | null>(null);
  return (
    <>
      {refs.map(({ path, el }) => {
        const file = byCandidate.get(path);
        return file ? createPortal(<MediaFrame file={file} onExpand={() => setOpen(file)} />, el, file.path) : null;
      })}
      {open && <MediaLightbox file={open} onClose={() => setOpen(null)} />}
    </>
  );
}
