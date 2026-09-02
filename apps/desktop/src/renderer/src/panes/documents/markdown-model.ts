import { Node as TiptapNode, getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import MarkdownIt, { type Token } from "markdown-it";
import { MarkdownParser, MarkdownSerializer, type MarkdownSerializerState } from "prosemirror-markdown";
import type { Node as ProseNode, Schema } from "@tiptap/pm/model";

/**
 * Markdown ⇄ ProseMirror for the docs editor (Plan 17 W2).
 *
 * The requirement that shapes every decision here is not "render markdown nicely" — it is **do not
 * mangle the user's file**. A document is a plain file that agents edit with Write/Edit and that git
 * diffs; a serializer that reformats on save would turn every one-word edit into a whole-file diff and
 * forfeit the reason the format decision was made in the first place.
 *
 * Two mechanisms enforce that:
 *
 * 1. **Nothing the schema cannot hold is ever parsed.** TipTap's StarterKit has no table node and no
 *    image node (verified against `getSchema`, not assumed), so a naive parser would silently delete a
 *    GFM table or an image on the first save. Every construct without a home in the schema — tables,
 *    HTML blocks, front-matter, footnotes, anything a future markdown-it plugin emits — is captured as
 *    a `rawBlock` holding its exact source text and written back byte-for-byte.
 * 2. **The serializer is canonical and idempotent.** One representation per construct, so a document
 *    that has been through it once never changes again (asserted by property test over a corpus that
 *    includes this repo's own plan docs).
 */

/** Holds source this schema cannot represent, verbatim. Atomic: the editor shows it, never re-flows it. */
export const RawBlock = TiptapNode.create({
  name: "rawBlock",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes: () => ({ source: { default: "" } }),
  parseHTML: () => [{ tag: "pre[data-raw-block]" }],
  renderHTML: ({ node }) => ["pre", { "data-raw-block": "", class: "documents-raw" }, node.attrs.source as string],
});

// `inline: true` is not cosmetic: TipTap's Image node defaults to a BLOCK, which cannot live inside a
// paragraph — so `![alt](src)` parsed into an empty paragraph and the image was silently deleted on the
// first edit. Caught only because a mutation run exposed the fallback path that source preservation
// normally hides.
export const docSchema: Schema = getSchema([StarterKit, Image.configure({ inline: true }), RawBlock]);

/** GFM-ish: CommonMark plus strikethrough and tables. Tables become rawBlocks — enabling them is what
 *  lets the tokenizer RECOGNISE one, which is precisely what stops it being shredded into paragraphs. */
const md = MarkdownIt("default", { html: true, linkify: false, typographer: false });

/** Block tokens with a home in the schema. Everything else is preserved verbatim. */
const HANDLED = new Set([
  "paragraph_open", "paragraph_close", "heading_open", "heading_close",
  "blockquote_open", "blockquote_close", "bullet_list_open", "bullet_list_close",
  "ordered_list_open", "ordered_list_close", "list_item_open", "list_item_close",
  "code_block", "fence", "hr", "inline", "text",
]);

/**
 * YAML front-matter, split off before tokenizing.
 *
 * markdown-it does not know front-matter: it reads the opening `---` as a thematic break and, worse,
 * can read `marp: true\n---` as a setext heading. Round-tripping that would corrupt exactly the block
 * `refineDocumentKind` uses to tell a slide deck from a document (see contracts/documents.ts).
 */
export function splitFrontMatter(src: string): { frontMatter: string; body: string } {
  const m = /^(---\r?\n[\s\S]*?\r?\n---)(\r?\n|$)/.exec(src);
  if (!m) return { frontMatter: "", body: src };
  return { frontMatter: m[1] ?? "", body: src.slice(m[0].length) };
}

/** The source lines a block token came from, used to preserve it verbatim. */
function sliceOf(lines: string[], token: Token): string {
  if (!token.map) return token.content ?? "";
  return lines.slice(token.map[0], token.map[1]).join("\n").replace(/\s+$/, "");
}

/**
 * Inline tokens with no entry in the token spec, rewritten into plain text so they survive verbatim.
 *
 * Both cases here were found by counting token types across this repo's own 31 markdown documents, not
 * by reading the CommonMark spec — and the more important one is easy to miss:
 *
 * - **`softbreak` (1146 occurrences).** A single newline inside a paragraph. The obvious mapping is a
 *   space, and it is badly wrong: prose wrapped at 100 columns would be rejoined into one long line,
 *   so opening any wrapped document and touching one word would rewrite every paragraph in it. Kept as
 *   a literal newline in a text node instead, which the serializer re-emits (re-applying any list or
 *   blockquote prefix) and the parser reads back as the same softbreak.
 * - **`html_inline`.** Inline HTML such as `<br>`; carried through as text. The escaper does not touch
 *   angle brackets, so it survives unchanged.
 */
function foldInline(children: Token[]): Token[] {
  return children.map((t) => {
    if (t.type !== "softbreak" && t.type !== "html_inline") return t;
    const text = Object.assign(Object.create(Object.getPrototypeOf(t) as object) as Token, t);
    text.type = "text";
    text.content = t.type === "softbreak" ? "\n" : t.content;
    return text;
  });
}

/**
 * Rewrite the token stream so unsupported top-level blocks become a single `raw_block` token.
 *
 * Nesting matters: a table's tokens run `table_open … table_close`, and dropping only the `table_open`
 * would leave its children to be parsed as loose paragraphs. The whole span is consumed by depth.
 */
function foldUnsupported(tokens: Token[], src: string): Token[] {
  const lines = src.split("\n");
  const out: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.type === "inline") { t.children = foldInline(t.children ?? []); out.push(t); continue; }
    if (HANDLED.has(t.type)) { out.push(t); continue; }
    const raw = new (t.constructor as new (type: string, tag: string, nesting: number) => Token)("raw_block", "", 0);
    raw.content = sliceOf(lines, t);
    out.push(raw);
    if (t.nesting === 1) {
      // Skip to the matching close token so the block's interior is never re-parsed.
      const openType = t.type.replace(/_open$/, "");
      let depth = 1;
      // Leaves `i` sitting ON the matching close token, so the for-loop's own `i++` steps past it and
      // no further token is swallowed. Advancing past the close here instead drops whatever follows
      // the block, which unbalances the stream and crashes the parser deep inside closeNode.
      while (i + 1 < tokens.length && depth > 0) {
        i++;
        const n = tokens[i]!;
        if (n.type === `${openType}_open`) depth++;
        else if (n.type === `${openType}_close`) depth--;
      }
    }
  }
  return out;
}

function buildParser(schema: Schema): MarkdownParser {
  return new MarkdownParser(
    schema,
    // MarkdownParser only ever calls `tokenizer.parse`, so this wrapper is the seam where the token
    // stream gets folded before any node is built. Typed through `unknown` because the parameter is
    // declared as a whole MarkdownIt instance while only this one method is ever reached.
    { parse: (text: string, env: Record<string, unknown>) => foldUnsupported(md.parse(text, env), text) } as unknown as ConstructorParameters<typeof MarkdownParser>[1],
    {
      paragraph: { block: "paragraph" },
      heading: { block: "heading", getAttrs: (tok) => ({ level: +tok.tag.slice(1) }) },
      blockquote: { block: "blockquote" },
      bullet_list: { block: "bulletList" },
      ordered_list: { block: "orderedList", getAttrs: (tok) => ({ start: +(tok.attrGet("start") ?? 1) }) },
      list_item: { block: "listItem" },
      code_block: { block: "codeBlock", noCloseToken: true },
      fence: { block: "codeBlock", getAttrs: (tok) => ({ language: tok.info.trim() || null }), noCloseToken: true },
      hr: { node: "horizontalRule" },
      hardbreak: { node: "hardBreak" },
      image: { node: "image", getAttrs: (tok) => ({
      src: tok.attrGet("src"), title: tok.attrGet("title") || null,
      alt: tok.children?.[0]?.content ?? null,
      }) },
      raw_block: { node: "rawBlock", getAttrs: (tok) => ({ source: tok.content }) },
      em: { mark: "italic" },
      strong: { mark: "bold" },
      s: { mark: "strike" },
      code_inline: { mark: "code", noCloseToken: true },
      link: { mark: "link", getAttrs: (tok) => ({ href: tok.attrGet("href"), title: tok.attrGet("title") || null }) },
    },
  );
}

/** One parser per Schema. TipTap's editor builds its own Schema instance, and a node created
 *  against a different one cannot be inserted — the failure is a silent empty document, not an error. */
const parsers = new WeakMap<Schema, MarkdownParser>();
function parserFor(schema: Schema): MarkdownParser {
  let p = parsers.get(schema);
  if (!p) { p = buildParser(schema); parsers.set(schema, p); }
  return p;
}

/**
 * Source preservation — the mechanism that keeps an edit's diff the size of the edit.
 *
 * Measured before this existed: canonically re-serializing this repository's own plan docs rewrote
 * **72% of their lines**. Escaping turned every `- [ ]` task item into `- \[ \]`, block spacing shifted,
 * and a document you opened and touched once would have come back as a whole-file diff. A canonical
 * serializer alone — which is all the plan originally called for — is not sufficient for a format whose
 * whole point is that git and agents read it.
 *
 * So the serializer is the FALLBACK, not the default. Every top-level block remembers the exact source
 * it was parsed from, and gives those bytes back untouched. Only a block the user actually edited is
 * re-serialized. This works because ProseMirror nodes are persistent: a transaction creates new node
 * objects for what changed and REUSES the objects for everything else, so object identity is already a
 * precise record of "did the user touch this block", and a WeakMap reads it without holding anything
 * alive.
 */
const blockSource = new WeakMap<ProseNode, { text: string; gap: string }>();
/** Nodes from a slice that produced several siblings: none may claim the shared source bytes. */
const claimless = new WeakSet<ProseNode>();

/** One top-level unit of the document: a line range, and whether the schema can represent it. */
type Span = { start: number; end: number; supported: boolean };

/**
 * The top-level block spans of a token stream.
 *
 * The gap-filling at the end is not a tidiness measure. Link reference definitions (`[a]: /url`) are
 * consumed by markdown-it into `env` and emit NO tokens at all, so a parser that only walks tokens
 * deletes them silently. Anything no token claimed is preserved verbatim instead.
 */
function topLevelSpans(tokens: Token[], lineCount: number): Span[] {
  const spans: Span[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (!t.map) continue;
    const supported = HANDLED.has(t.type);
    spans.push({ start: t.map[0], end: t.map[1], supported });
    if (t.nesting === 1) {
      const openType = t.type.replace(/_open$/, "");
      let depth = 1;
      while (i + 1 < tokens.length && depth > 0) {
        i++;
        const n = tokens[i]!;
        if (n.type === `${openType}_open`) depth++;
        else if (n.type === `${openType}_close`) depth--;
      }
    }
  }
  spans.sort((a, b) => a.start - b.start);
  const filled: Span[] = [];
  let cursor = 0;
  for (const sp of spans) {
    if (sp.start > cursor) filled.push({ start: cursor, end: sp.start, supported: false });
    filled.push(sp);
    cursor = Math.max(cursor, sp.end);
  }
  if (cursor < lineCount) filled.push({ start: cursor, end: lineCount, supported: false });
  return filled;
}

/** The text lines of a span, with trailing blank lines removed (those belong to the gap after it). */
function trimTrailingBlanks(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? "").trim() === "") end--;
  return lines.slice(0, end);
}

/** Markdown → ProseMirror. Front-matter is re-attached as the leading rawBlock. */
export function parseMarkdown(text: string, schema: Schema = docSchema): ProseNode {
  const parser = parserFor(schema);
  const { frontMatter, body } = splitFrontMatter(text);
  const allLines = text.split("\n");
  // One coordinate system for everything, so gaps between blocks are simple line arithmetic. The
  // front-matter occupies the first lines of the file; body spans are offset past it.
  const offset = frontMatter ? frontMatter.split("\n").length : 0;
  const bodyLines = body.split("\n");

  /** node + where its text sits in `allLines`; the gap to the next block is computed afterwards. */
  const entries: { node: ProseNode; start: number; endOfText: number }[] = [];

  if (frontMatter) {
    entries.push({ node: schema.nodes.rawBlock!.create({ source: frontMatter }), start: 0, endOfText: offset });
  }

  for (const span of topLevelSpans(md.parse(body, {}), bodyLines.length)) {
    const kept = trimTrailingBlanks(bodyLines.slice(span.start, span.end));
    const blockText = kept.join("\n");
    if (blockText.trim() === "") continue;
    const start = span.start + offset;
    const endOfText = start + kept.length;

    if (!span.supported) {
      entries.push({ node: schema.nodes.rawBlock!.create({ source: blockText }), start, endOfText });
      continue;
    }
    // Parsed in isolation so each resulting node maps to exactly one known source slice — the
    // correspondence the WeakMap needs, which a whole-document parse does not hand back.
    const sub = parser.parse(blockText);
    if (!sub || sub.childCount === 0) continue;
    const single = sub.childCount === 1;
    sub.forEach((child, _off, index) => {
      // Only a slice that produced exactly one node may claim its source; otherwise those bytes would
      // be emitted once per sibling.
      entries.push({ node: child, start, endOfText: single || index === 0 ? endOfText : start });
      if (!single && index > 0) claimless.add(child);
    });
  }

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (claimless.has(e.node)) continue;
    const next = entries[i + 1];
    // Lines are joined by "\n", so stepping from the end of this block's text to the start of the
    // next one takes (nextStart - thisEnd) + 1 newlines — which is "\n\n" for the ordinary case of a
    // single blank line between blocks, and "\n" for blocks that sit directly against each other.
    const gap = next ? "\n".repeat(Math.max(1, next.start - e.endOfText + 1)) : "\n";
    blockSource.set(e.node, { text: allLines.slice(e.start, e.endOfText).join("\n"), gap });
  }

  if (entries.length === 0) return schema.topNodeType.createAndFill()!;
  return schema.topNodeType.create(null, entries.map((e) => e.node));
}

/**
 * The canonical serializer — the FALLBACK used only for blocks the user actually edited. Everything
 * untouched is emitted from its original source instead (see `blockSource`), which is why this one
 * being opinionated about `-` bullets and `**` bold costs nothing on an unedited document.
 */
const serializer = new MarkdownSerializer(
  {
    paragraph: (state, node) => { state.renderInline(node); state.closeBlock(node); },
    heading: (state, node) => {
      state.write(`${"#".repeat(node.attrs.level as number)} `);
      state.renderInline(node);
      state.closeBlock(node);
    },
    blockquote: (state, node) => state.wrapBlock("> ", null, node, () => state.renderContent(node)),
    bulletList: (state, node) => state.renderList(node, "  ", () => "- "),
    orderedList: (state, node) => {
      const start = (node.attrs.start as number) || 1;
      const pad = String(start + node.childCount - 1).length;
      state.renderList(node, " ".repeat(pad + 2), (i) => `${String(start + i).padStart(pad, " ")}. `);
    },
    listItem: (state, node) => state.renderContent(node),
    codeBlock: (state, node) => {
      const lang = (node.attrs.language as string | null) ?? "";
      state.write(`\`\`\`${lang}\n`);
      state.text(node.textContent, false);
      state.ensureNewLine();
      state.write("```");
      state.closeBlock(node);
    },
    horizontalRule: (state, node) => { state.write("---"); state.closeBlock(node); },
    hardBreak: (state) => state.write("\\\n"),
    image: (state, node) => {
      const { src, alt, title } = node.attrs as { src: string; alt: string | null; title: string | null };
      state.write(`![${state.esc(alt ?? "")}](${src}${title ? ` "${title}"` : ""})`);
    },
    text: (state, node) => state.text(node.text ?? ""),
    // Verbatim, by definition: this node exists precisely because the schema cannot re-derive it.
    rawBlock: (state, node) => { state.write(node.attrs.source as string); state.closeBlock(node); },
  },
  {
    bold: { open: "**", close: "**", mixable: true, expelEnclosingWhitespace: true },
    italic: { open: "*", close: "*", mixable: true, expelEnclosingWhitespace: true },
    strike: { open: "~~", close: "~~", mixable: true, expelEnclosingWhitespace: true },
    code: { open: "`", close: "`", escape: false },
    link: {
      open: "[",
      close: (_state, mark) => `](${mark.attrs.href as string}${mark.attrs.title ? ` "${mark.attrs.title as string}"` : ""})`,
    },
  },
);

/**
 * ProseMirror → Markdown. Preserved blocks give back their original bytes; only edited ones are
 * re-serialized canonically.
 */
export function serializeMarkdown(doc: ProseNode): string {
  const parts: string[] = [];
  doc.forEach((child, _offset, index) => {
    const kept = blockSource.get(child);
    const last = index === doc.childCount - 1;
    if (kept) { parts.push(kept.text, last ? "\n" : kept.gap); return; }
    const wrapper = child.type.schema.topNodeType.create(null, [child]);
    const out = serializer.serialize(wrapper, { tightLists: true } as Parameters<MarkdownSerializer["serialize"]>[1]);
    parts.push(out.replace(/\n+$/, ""), last ? "\n" : "\n\n");
  });
  const text = parts.join("");
  // A file ends with exactly one newline; an empty document is still one newline, not zero bytes.
  return text === "" ? "\n" : text.replace(/\n*$/, "\n");
}

/** Convenience for tests and for measuring what a first edit would rewrite. */
export function canonicalize(text: string): string {
  return serializeMarkdown(parseMarkdown(text));
}

export type { MarkdownSerializerState };
