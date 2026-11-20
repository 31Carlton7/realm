import { basenameOf, documentKindFor } from "@realm/contracts";
import katex from "katex";
import katexCss from "katex/dist/katex.min.css?raw";
import { Marked, type Token, type Tokens } from "marked";
import markedFootnote from "marked-footnote";
import Papa from "papaparse";
import interItalic from "../renderer/src/assets/fonts/InterVariable-Italic.woff2?inline";
import inter from "../renderer/src/assets/fonts/InterVariable.woff2?inline";
import monoMedium from "../renderer/src/assets/fonts/JetBrainsMono-Medium.woff2?inline";
import mono from "../renderer/src/assets/fonts/JetBrainsMono-Regular.woff2?inline";
import hljs from "../renderer/src/panes/session/rich/highlight-grammars";
import { grammarFor, grammarForPath } from "../renderer/src/panes/session/rich/highlight-names";
import { mathSyntax } from "../renderer/src/panes/session/rich/math-syntax";
import printCss from "./print-document.css?raw";

/**
 * A text file as one static page for `printToPDF` (print-pdf.ts): Markdown set as a document, a CSV
 * as a table, anything else the documents pane opens as one highlighted block of code.
 *
 * The page is built here, in main, with KaTeX and highlight.js already run, because the window that
 * prints it has JavaScript off. And it is built from the user's file, so nothing in the file is ever
 * markup. A document's raw HTML is written out as its source, which is what the documents pane does
 * with it (a `rawBlock`, markdown-model.ts); a link is drawn only for http(s), mailto or a place in
 * the page; and a picture is one main read from disk beside the file. A remote picture is never
 * fetched, as the pane never fetches one (its `img-src` admits no remote host): it prints as a link.
 * The page's Content-Security-Policy then allows its own styles, data: fonts and data: images, so
 * even a mistake here could not fetch or run anything.
 */

export type PrintDocument = { html: string; title: string };

/** A picture beside the file as a data: URL, or null when the href names none (print-pdf.ts). */
export type ReadImage = (href: string) => Promise<string | null>;

const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'";

/** A picture main encoded itself. SVG is left out as the share page leaves it out: it is a document
 *  that can carry script, and anything else is not a picture. */
const RASTER = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Where a link may point: the web, mail, or a place in this page (a heading, a footnote). Parsed
 *  rather than prefix-matched, so `java\tscript:` and `JAVASCRIPT:` are read as a browser reads them. */
export function linkTarget(href: string): string | null {
  const trimmed = href.trim();
  if (/^#[\w.:-]+$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" ? url.href : null;
  } catch {
    return null;
  }
}

const isRemote = (href: string): boolean => /^(?:https?:)?\/\//i.test(href.trim());

/** KaTeX with the transcript's options (rich/math.ts). `trust: false` keeps `\href` and
 *  `\includegraphics` out, so a formula cannot add a link or a fetch. */
function typeset(tex: string, display: boolean): string {
  try {
    const html = katex.renderToString(tex, { displayMode: display, throwOnError: true, strict: "ignore", trust: false, output: "htmlAndMathml" });
    return display ? `<div class="math-display">${html}</div>` : html;
  } catch {
    return `<code class="math-raw">${esc(display ? `$$${tex}$$` : `$${tex}$`)}</code>`;
  }
}

function highlight(code: string, grammar: string | null): string {
  if (!grammar) return esc(code);
  try {
    return hljs.highlight(code, { language: grammar, ignoreIllegals: true }).value;
  } catch {
    return esc(code);
  }
}

/** The words of a heading, without its Markdown. */
function plainText(tokens: Token[]): string {
  return tokens.map((t) => ("tokens" in t && t.tokens ? plainText(t.tokens) : "text" in t ? t.text : "")).join("");
}

function markdownPage(images: Map<string, string>): Marked {
  const md = new Marked({ gfm: true, breaks: false, async: false });
  md.use({
    renderer: {
      html({ text: source, block }) { return block ? `<pre class="raw-html"><code>${esc(source)}</code></pre>\n` : esc(source); },
      link({ href, title, tokens }) {
        const words = this.parser.parseInline(tokens);
        const url = linkTarget(href);
        if (!url) return `<span class="dead-link">${words}</span>`;
        return `<a href="${esc(url)}"${title ? ` title="${esc(title)}"` : ""}>${words}</a>`;
      },
      image({ href, text: alt }) {
        const data = images.get(href) ?? (RASTER.test(href.trim()) ? href.trim() : null);
        if (data) return `<img src="${data}" alt="${esc(alt)}">`;
        const url = isRemote(href) ? linkTarget(href) : null;
        const label = esc(alt || basenameOf(href) || "Picture");
        return url ? `<a class="left-out" href="${esc(url)}">${label}</a>` : `<span class="left-out">${label}</span>`;
      },
      code({ text: source, lang }) {
        const name = (lang ?? "").trim().split(/\s+/)[0] ?? "";
        return `<pre><code class="hljs">${highlight(source, grammarFor(name))}</code></pre>\n`;
      },
    },
  });
  md.use(mathSyntax(typeset));
  md.use(markedFootnote());
  return md;
}

/** YAML front-matter (a Marp deck's settings) is the file's, not the reader's. */
const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

async function markdownBody(text: string, readImage: ReadImage): Promise<{ body: string; heading: string | null }> {
  const images = new Map<string, string>();
  const md = markdownPage(images);
  const tokens = md.lexer(text.replace(FRONT_MATTER, ""));
  // The extensions' own pass, which `parse` would have run: marked-footnote moves its notes to the end.
  if (md.defaults.walkTokens) md.walkTokens(tokens, md.defaults.walkTokens);
  const hrefs = new Set<string>();
  let heading: string | null = null;
  md.walkTokens(tokens, (t) => {
    if (t.type === "image" && !isRemote(t.href) && !t.href.trim().startsWith("data:")) hrefs.add(t.href);
    if (t.type === "heading" && heading === null) heading = plainText((t as Tokens.Heading).tokens).trim() || null;
  });
  for (const href of hrefs) {
    const data = await readImage(href);
    if (data && RASTER.test(data)) images.set(href, data);
  }
  return { body: md.parser(tokens), heading };
}

/** A number, as a spreadsheet would right-align it: digits with an optional sign, grouping, decimals,
 *  a currency sign or a percent. */
const NUMERIC = /^[-+]?[$€£¥]?\d[\d,]*(?:\.\d+)?%?$/;

function sheetBody(text: string, path: string): string {
  const parsed = Papa.parse<string[]>(text, { delimiter: path.toLowerCase().endsWith(".tsv") ? "\t" : ",", skipEmptyLines: "greedy" });
  const [header = [], ...rows] = parsed.data;
  const width = Math.max(header.length, ...rows.map((r) => r.length));
  const cell = (tag: "th" | "td", value = "") => `<${tag}${tag === "td" && NUMERIC.test(value.trim()) ? ' class="num"' : ""}>${esc(value)}</${tag}>`;
  const row = (tag: "th" | "td", cells: string[]) => `<tr>${Array.from({ length: width }, (_, i) => cell(tag, cells[i])).join("")}</tr>`;
  return `<table class="sheet"><thead>${row("th", header)}</thead><tbody>${rows.map((r) => row("td", r)).join("\n")}</tbody></table>`;
}

const FACES = `
@font-face { font-family: "Inter"; src: url("${inter}") format("woff2"); font-weight: 100 900; font-style: normal; font-display: swap; }
@font-face { font-family: "Inter"; src: url("${interItalic}") format("woff2"); font-weight: 100 900; font-style: italic; font-display: swap; }
@font-face { font-family: "JetBrains Mono"; src: url("${mono}") format("woff2"); font-weight: 400; font-style: normal; font-display: swap; }
@font-face { font-family: "JetBrains Mono"; src: url("${monoMedium}") format("woff2"); font-weight: 500; font-style: normal; font-display: swap; }
`;

/** KaTeX's faces, as data: URLs keyed by the file name its stylesheet asks for. */
const KATEX_FONTS: Record<string, string> = Object.fromEntries(
  Object.entries(import.meta.glob<string>("../../node_modules/katex/dist/fonts/*.woff2", { query: "?inline", import: "default", eager: true }))
    .map(([file, url]) => [file.slice(file.lastIndexOf("/") + 1), url]),
);

/** KaTeX's stylesheet with each face's `src` cut to the woff2 the page carries, as data. */
const katexStyle = (): string =>
  katexCss.replace(/src:url\(fonts\/([\w-]+\.woff2)\)[^;}]*/g, (whole, file: string) => (KATEX_FONTS[file] ? `src:url(${KATEX_FONTS[file]}) format("woff2")` : whole));

/** The page for `path`, whose text is `text`. The title is the document's first heading, or the file's
 *  name: it is the PDF's title and the footer's. */
export async function buildPrintDocument({ path, text, readImage }: { path: string; text: string; readImage: ReadImage }): Promise<PrintDocument> {
  const kind = documentKindFor(path);
  const name = basenameOf(path);
  let body: string;
  let title = name;
  if (kind === "doc" || kind === "slides") {
    const doc = await markdownBody(text, readImage);
    body = doc.body;
    title = doc.heading ?? name;
  } else if (kind === "sheet") {
    body = `<h1 class="file-name">${esc(name)}</h1>\n${sheetBody(text, path)}`;
  } else {
    body = `<h1 class="file-name">${esc(name)}</h1>\n<pre class="file"><code class="hljs">${highlight(text, grammarForPath(path))}</code></pre>`;
  }
  const html = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    `<title>${esc(title)}</title>`,
    `<style>${FACES}${kind === "doc" || kind === "slides" ? katexStyle() : ""}\n${printCss}</style>`,
    "</head>",
    `<body class="kind-${kind}">`,
    body,
    "</body>",
    "</html>",
  ].join("\n");
  return { html, title };
}
