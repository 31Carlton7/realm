import { uiBlockKind, type UiBlockKind } from "@realm/contracts";
import { useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { UiBlockPortal } from "./UiBlock";

/**
 * Where a ```mermaid, ```realm-chart or ```realm-compare fence becomes a block in assistant prose.
 *
 * The code renderer in `Markdown.tsx` still writes the fence as highlighted code — that is what a
 * body that does not parse falls back to, and it is the source a reader can show again — and marks
 * it to be drawn only once its closing fence has arrived. `decorate` then parks the code in a
 * placeholder, and `useUiBlockPortals` portals the drawn block into it: the media extension's
 * pattern, for the same reason, since the prose is an innerHTML blob React does not own.
 */

/** Stamped on a fence the renderer itself parked, so markup an agent wrote by hand (`<pre
 *  data-ui-block>`) cannot pass for one and draw before its fence has closed. */
export const BLOCK_MARK = Math.random().toString(36).slice(2, 10);

/**
 * Whether a fenced code token's raw source ends in its closing fence.
 *
 * CommonMark lets a fence run unclosed to the end of the document, which is exactly what a message
 * mid-stream looks like: nothing is drawn from half a body. The close is the opener's character,
 * at least as many of them, and nothing after — so "``" a delta short of three is still open.
 */
export function fenceClosed(raw: string): boolean {
  const lines = raw.replace(/\n+$/, "").split("\n");
  const open = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0] ?? "");
  if (!open || lines.length < 2) return false;
  const fence = open[1]!;
  return new RegExp(`^ {0,3}\\${fence[0]}{${fence.length},}[ \\t]*$`).test(lines.at(-1)!);
}

/** The attributes the code renderer adds to a block fence's `<pre>` — none for any other fence, or
 *  for a block fence still open. */
export function blockFenceAttrs(lang: string, raw: string): string {
  const kind = uiBlockKind(lang);
  return kind && fenceClosed(raw) ? ` data-ui-block="${kind}" data-ui-mark="${BLOCK_MARK}"` : "";
}

/** Run by `decorate` on each code panel it builds: a parked block's panel goes into the placeholder,
 *  with a slot in its head for the reason it stays code, if it does. */
export function parkUiBlock(panel: HTMLElement): void {
  const pre = panel.querySelector("pre");
  if (pre?.getAttribute("data-ui-mark") !== BLOCK_MARK) { pre?.removeAttribute("data-ui-block"); return; }
  const kind = pre.getAttribute("data-ui-block") ?? "";
  pre.removeAttribute("data-ui-mark");
  pre.removeAttribute("data-ui-block");
  const doc = panel.ownerDocument;
  const holder = doc.createElement("div");
  holder.className = "md-block";
  holder.setAttribute("data-ui-block", kind);
  const reason = doc.createElement("span");
  reason.className = "md-block-reason";
  panel.querySelector(".md-code-lang")?.after(reason);
  panel.replaceWith(holder);
  holder.appendChild(panel);
}

/** Fills the placeholders `parkUiBlock` made. After `useMediaPortals`, whose layout effect writes
 *  the markup these are read from. */
export function useUiBlockPortals(body: RefObject<HTMLDivElement | null>, html: string): ReactNode {
  const [refs, setRefs] = useState<{ kind: UiBlockKind; source: string; el: HTMLElement; reason: HTMLElement | null }[]>([]);
  useLayoutEffect(() => {
    const root = body.current;
    if (!root) return;
    const found = Array.from(root.querySelectorAll<HTMLElement>(".md-block")).flatMap((el) => {
      const kind = el.dataset["uiBlock"] as UiBlockKind | undefined;
      const code = el.querySelector("pre code");
      // The renderer ends the highlighted text with the fence's own newline; the body is what is inside.
      return kind && code ? [{ kind, source: (code.textContent ?? "").replace(/\n$/, ""), el, reason: el.querySelector<HTMLElement>(".md-block-reason") }] : [];
    });
    setRefs((prev) => (prev.length === found.length && prev.every((r, i) => r.el === found[i]!.el) ? prev : found));
  }, [html, body]);
  return refs.map((r, i) => createPortal(<UiBlockPortal kind={r.kind} source={r.source} reasonSlot={r.reason} />, r.el, String(i)));
}
