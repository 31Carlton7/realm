import katex from "katex";
import type { MarkedExtension, TokenizerAndRendererExtension, Tokens } from "marked";

/** TeX in assistant prose, rendered by KaTeX (Plan 24 W1).
 *
 *  This is not a coding-agent nicety — it is the school spaces: a lecture answered in the transcript,
 *  a derivation walked through step by step, a study guide's formula quoted back. Left as text,
 *  `\int_0^1 x^2\,dx` is something the reader has to decode; set properly it is something they can
 *  read at a glance.
 *
 *  Four delimiter pairs, because agents write all four: `$…$` and `\(…\)` inline, `$$…$$` and
 *  `\[…\]` display. The `$` pair is the dangerous one — prose is full of prices and shell is full of
 *  variables — so it is the only one with guards (below), and nothing inside a code span or fence
 *  ever reaches here: marked's own codespan/fence tokenizers consume those first.
 */

/** KaTeX's own markup for one expression, or null when it will not parse.
 *
 *  A failed parse falls back to the raw TeX rather than KaTeX's red error markup: the agent wrote
 *  something, and showing what it wrote is more useful than a red `ParseError` the reader cannot
 *  act on. */
export function renderTex(tex: string, display: boolean): string | null {
  try {
    return katex.renderToString(tex, {
      displayMode: display,
      throwOnError: true,
      // `strict: "ignore"` accepts the LaTeX-isms KaTeX merely warns about (unicode text in math,
      // `\newline`), which agents emit constantly and which render fine.
      strict: "ignore",
      // `trust: false` is the default and stays: it disables \href, \url and \includegraphics, so a
      // formula cannot smuggle a link or a remote fetch into the transcript.
      trust: false,
      output: "htmlAndMathml",
    });
  } catch {
    return null;
  }
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** What a block renders as: KaTeX's markup, or the raw source in a marked-up span if it would not
 *  parse. `display` blocks get their own centred row; inline ones flow with the sentence. */
const render = (tex: string, display: boolean): string => {
  const html = renderTex(tex, display);
  if (html === null) return `<span class="math-raw" title="This expression did not parse as TeX">${escapeHtml(display ? `$$${tex}$$` : `$${tex}$`)}</span>`;
  return display ? `<div class="math-display">${html}</div>` : html;
};

/* `$…$` guards, in the order they matter:
 *  - no whitespace just inside either delimiter, so "costs $5, sells for $9" is not one expression
 *    spanning the comma;
 *  - the closer is not followed by a digit, so "$5 and $10" does not read as `5 and ` in math;
 *  - the opener is not itself escaped (`\$`) or doubled (`$$`, which is the display tokenizer's).
 *  A `$` that fails any of them is left as the literal character it almost always is. */
const INLINE_DOLLAR = /^\$(?![\s$])((?:\\[\s\S]|[^$\\])+?)(?<![\s\\])\$(?!\d)/;
const INLINE_PAREN = /^\\\(([\s\S]+?)\\\)/;
const BLOCK_DOLLAR = /^\$\$((?:[^$]|\$(?!\$))+?)\$\$(?:\n+|$)/;
const BLOCK_BRACKET = /^\\\[([\s\S]+?)\\\](?:\n+|$)/;

const blockMath: TokenizerAndRendererExtension = {
  name: "blockMath",
  level: "block",
  start: (src: string) => {
    const m = /\$\$|\\\[/.exec(src);
    return m ? m.index : undefined;
  },
  tokenizer(src: string) {
    const m = BLOCK_DOLLAR.exec(src) ?? BLOCK_BRACKET.exec(src);
    if (!m) return undefined;
    return { type: "blockMath", raw: m[0], text: m[1]!.trim() };
  },
  renderer: (token: Tokens.Generic) => render(String(token["text"]), true),
};

const inlineMath: TokenizerAndRendererExtension = {
  name: "inlineMath",
  level: "inline",
  start: (src: string) => {
    const m = /\$(?![\s$])|\\\(/.exec(src);
    return m ? m.index : undefined;
  },
  tokenizer(src: string) {
    const m = INLINE_DOLLAR.exec(src) ?? INLINE_PAREN.exec(src);
    if (!m) return undefined;
    return { type: "inlineMath", raw: m[0], text: m[1]!.trim() };
  },
  renderer: (token: Tokens.Generic) => render(String(token["text"]), false),
};

export const mathExtension: MarkedExtension = { extensions: [blockMath, inlineMath] };
