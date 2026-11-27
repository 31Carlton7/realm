import type { MarkedExtension, TokenizerExtension, Tokens } from "marked";

/** The TeX delimiters `math.ts` reads, apart from how a formula is drawn, so the PDF export in main
 *  reads a document's formulas exactly as the app does and typesets them with its own KaTeX. */

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

const blockMath: TokenizerExtension = {
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
};

const inlineMath: TokenizerExtension = {
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
};

/** The two tokenizers, each drawing its formula with `render`: the transcript's KaTeX once loaded, or
 *  main's KaTeX for a PDF. */
export function mathSyntax(render: (tex: string, display: boolean) => string): MarkedExtension {
  return {
    extensions: [
      { ...blockMath, renderer: (token: Tokens.Generic) => render(String(token["text"]), true) },
      { ...inlineMath, renderer: (token: Tokens.Generic) => render(String(token["text"]), false) },
    ],
  };
}
