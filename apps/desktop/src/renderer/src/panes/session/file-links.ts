import { iconSvg } from "@realm/ui";
import { documentKindFor, type TurnChanges } from "@realm/contracts";
import { useLayoutEffect, useState, type RefObject } from "react";
import { fileIconFor } from "../../components/file-icon";
import type { Block } from "./transcript-model";

/**
 * The files an agent names, as links that open them — Codex's file reference: the file's mark, its
 * path, and the line it points at, in the accent like any other link in the prose.
 *
 * Two halves, because only one of them can be decided from the text. `markFileRefs` runs over the
 * rendered markdown and marks every place a FILE might be named — inline code that is a path, a
 * link whose target is a local path, a path in running text — and decides nothing. `fileCandidates`
 * then turns one mark into the absolute paths it could mean, inside the session's checkout and
 * nowhere else, and the caller asks the disk which of them is a real file. Only that one becomes a
 * link: an agent's prose is full of things shaped like paths, and a link to a guess is worse than
 * the plain text it replaced.
 */

/** What a link needs from the session it is drawn in. */
export type FileLinkContext = {
  /** Where the agent stands: what a relative path in its prose is relative to. */
  cwd: string;
  /** The checkout's root — the boundary. A path that resolves outside it is never linked. */
  root: string;
  /** Files this session's tools touched, absolute. A bare `orgs.ts` that matches exactly one of them
   *  means that one — what Realm already knows, not a search. */
  known: ReadonlySet<string>;
  onOpen: (path: string, line: number | null) => void;
};

/** One path segment, a leading dot allowed (`.github`, `.env`). */
const SEG = String.raw`\.?[\w@%+-][\w.@%+-]*`;
/** A path whose last segment has an extension starting with a letter — `v1.2` is a version, not a file. */
const FILE = String.raw`(?:${SEG}\/)*[\w@%+-][\w.@%+-]*\.[A-Za-z]\w*`;
/** A line, the ways agents write one: `:83`, `:83:5`, `#L83`, `#L83-L90`, `#L83C5`. */
const LINE = String.raw`(?::(\d+)(?::\d+)?|#L(\d+)(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)?`;
/** The whole of an inline code, or of a link's target: an optional root, a file, a line. */
const WHOLE_REF = new RegExp(String.raw`^((?:~|\.{1,2})?\/?${FILE})${LINE}$`);
/** A relative path in running text, after a space or an opening bracket or quote, with Codex's
 *  ` (line 83)` absorbed when it follows. Absolute ones are already buttons by now (`markPaths`). */
const PROSE_REF = new RegExp(String.raw`(^|[\s(\["'])(${FILE})(?::(\d+)(?::\d+)?)?(\s\(lines?\s(\d+)(?:[-–]\d+)?\))?`, "g");

/** Never scanned: a block of code is copied whole, a heading is a label, a button already acts. */
const SKIP = "pre, h1, h2, h3, h4, h5, h6, button, a, code, .md-file";

/** A whole inline code, or a link target, read as a file and a line. */
export function parseFileRef(text: string): { ref: string; line: number | null } | null {
  const t = text.trim();
  if (t.length < 3 || t.includes("://") || /\s/.test(t)) return null;
  const m = WHOLE_REF.exec(t);
  if (!m) return null;
  const line = m[2] ?? m[3];
  return { ref: m[1]!, line: line ? Number(line) : null };
}

const mark = (el: Element, ref: string, line: number | null) => {
  el.setAttribute("data-file-ref", ref);
  if (line !== null) el.setAttribute("data-file-line", String(line));
};

/**
 * Mark every place in a sanitized fragment that might name a file. Mutates in place; returns how
 * many were marked. Inline code and links are marked where they stand, so an unresolved one keeps
 * exactly the look it had; a path in running text is wrapped in a span that carries no look at all.
 */
export function markFileRefs(root: ParentNode): number {
  let found = 0;
  const doc = root.ownerDocument ?? (root as unknown as Document);
  for (const code of Array.from(root.querySelectorAll("code"))) {
    if (code.closest("pre, a")) continue;
    const ref = parseFileRef(code.textContent ?? "");
    if (ref) { mark(code, ref.ref, ref.line); found++; }
  }
  for (const a of Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
    const href = a.getAttribute("href") ?? "";
    // A scheme is somewhere else entirely; `#…` alone is an anchor in this page.
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) continue;
    let decoded = href;
    try { decoded = decodeURI(href); } catch { /* a malformed escape is just text */ }
    const ref = parseFileRef(decoded);
    if (ref) { mark(a, ref.ref, ref.line); found++; }
  }
  // An absolute path in prose is already a button (file-paths.ts) — the same candidate, already cut.
  for (const btn of Array.from(root.querySelectorAll<HTMLElement>("button.md-path[data-path]"))) {
    const ref = parseFileRef(btn.getAttribute("data-path") ?? "");
    if (ref) { mark(btn, ref.ref, ref.line); found++; }
  }
  const walker = doc.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    if (!t.data.includes(".") || t.parentElement?.closest(SKIP)) continue;
    PROSE_REF.lastIndex = 0;
    if (PROSE_REF.test(t.data)) targets.push(t);
  }
  for (const t of targets) {
    const frag = doc.createDocumentFragment();
    let last = 0;
    PROSE_REF.lastIndex = 0;
    for (let m = PROSE_REF.exec(t.data); m; m = PROSE_REF.exec(t.data)) {
      const path = m[2]!;
      // Bare names in running text are only taken when they are a kind of file Realm opens: "Node.js"
      // is code by its extension and costs one look at the disk, "e.g." is nothing and costs none.
      if (!path.includes("/") && documentKindFor(path) === "unsupported") continue;
      const start = m.index + m[1]!.length;
      const text = m[0].slice(m[1]!.length);
      if (start > last) frag.append(t.data.slice(last, start));
      const span = doc.createElement("span");
      mark(span, path, m[3] ? Number(m[3]) : m[5] ? Number(m[5]) : null);
      span.textContent = text;
      frag.append(span);
      last = start + text.length;
      found++;
    }
    if (last === 0) continue;
    if (last < t.data.length) frag.append(t.data.slice(last));
    t.replaceWith(frag);
  }
  return found;
}

/** `/`-joined and normalised the way a filesystem reads it: `.` dropped, `..` climbing. Null when a
 *  `..` would climb past the root of the path itself. */
export function normalizePath(path: string): string | null {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { if (out.length === 0) return null; out.pop(); continue; }
    out.push(seg);
  }
  return `/${out.join("/")}`;
}

const trim = (p: string) => p.replace(/\/+$/, "");
const inside = (path: string, root: string) => path === root || path.startsWith(`${trim(root)}/`);
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/**
 * The absolute paths one mark could mean, in the order they are tried — and only inside the checkout,
 * and only of a kind the documents pane opens. A `~` path is left alone: it names the home folder,
 * which is not this checkout, and the path menu already handles those.
 *
 *  - absolute: itself;
 *  - with a separator: from where the agent stands, then from the checkout's root (agents write
 *    repository paths from the root whatever directory they were started in);
 *  - a bare name: beside the agent, then the one file of that name this session's tools touched — if
 *    exactly one did. Two `index.ts` files touched is two answers, and a link must have one.
 */
export function fileCandidates(ref: string, ctx: Pick<FileLinkContext, "cwd" | "root" | "known">): string[] {
  if (ref.startsWith("~") || documentKindFor(ref) === "unsupported") return [];
  const root = trim(ctx.root);
  const tries = ref.startsWith("/") ? [ref]
    : ref.includes("/") ? [`${ctx.cwd}/${ref}`, `${root}/${ref}`]
    : [`${ctx.cwd}/${ref}`, ...uniqueByName(ref, ctx.known)];
  const out: string[] = [];
  for (const raw of tries) {
    const p = normalizePath(raw);
    if (p && inside(p, root) && !out.includes(p)) out.push(p);
  }
  return out;
}

function uniqueByName(name: string, known: ReadonlySet<string>): string[] {
  const hits = [...known].filter((p) => baseOf(p) === name);
  return hits.length === 1 ? hits : [];
}

/**
 * Turn a confirmed mark into the link: the file's mark, then what the agent wrote — with the line
 * said in words, " (line 83)", where it wrote `:83`. An inline element with a link's role rather than
 * a button: a button is an atomic box and a long path would push out of the column whole, where a
 * link in prose wraps with the sentence it is in. The Markdown host answers its click and its Enter.
 */
export function upgradeFileRef(el: HTMLElement, path: string, root: string): void {
  const doc = el.ownerDocument;
  const line = el.getAttribute("data-file-line");
  const ref = el.getAttribute("data-file-ref") ?? path;
  const said = (el.textContent ?? "").trim();
  const rel = inside(path, root) ? path.slice(trim(root).length + 1) : path;
  // A link keeps the agent's own words; an absolute path is said from the checkout's root, the way
  // the rest of the session's rows name its files.
  const written = el.tagName === "A" && said !== "" && said !== el.getAttribute("href") ? said : ref.startsWith("/") ? rel : ref;
  const label = line && !written.includes(line) ? `${written} (line ${line})` : written.replace(/:(\d+)(?::\d+)?$/, " (line $1)");
  const link = doc.createElement("span");
  link.className = "md-file";
  link.setAttribute("role", "link");
  link.setAttribute("tabindex", "0");
  link.setAttribute("data-file", path);
  if (line) link.setAttribute("data-line", line);
  link.title = line ? `Open ${rel} at line ${line}` : `Open ${rel}`;
  link.innerHTML = iconSvg(fileIconFor(path), 14, "md-file-mark");
  const name = doc.createElement("span");
  name.className = "md-file-name";
  name.textContent = label;
  link.append(name);
  el.replaceWith(link);
}

/**
 * Every file this session's tools named or changed, absolute — what a bare `orgs.ts` in the prose is
 * matched against. The tool calls say what the agent touched; a turn's measured changes add what a
 * shell command or a sub-agent wrote, which no call names.
 */
export function touchedFiles(blocks: readonly Block[], changes: Readonly<Record<number, TurnChanges>> | undefined, cwd: string): Set<string> {
  const out = new Set<string>();
  const add = (p: unknown, base = cwd) => {
    if (typeof p !== "string" || p === "") return;
    const abs = normalizePath(p.startsWith("/") ? p : `${base}/${p}`);
    if (abs) out.add(abs);
  };
  for (const b of blocks) {
    if (b.kind !== "tool") continue;
    add(b.input["file_path"] ?? b.input["notebook_path"]);
    const patch = b.input["changes"];
    if (b.name === "apply_patch" && Array.isArray(patch)) for (const c of patch) add((c as Record<string, unknown> | null)?.["path"]);
  }
  for (const c of Object.values(changes ?? {})) for (const f of c.files) add(f.path, c.root);
  return out;
}

/* ── Asking the disk ─────────────────────────────────────────────────────────
 * One look per path, through main's `files.stat` (a regular file, or null), remembered for the life
 * of the window. A miss is remembered only briefly: an agent names a file in the sentence BEFORE the
 * call that writes it, and the link should appear once it exists rather than never. */

const looked = new Map<string, { file: boolean; at: number }>();
const MISS_MS = 5_000;

function seen(path: string): boolean | undefined {
  const s = looked.get(path);
  if (!s) return undefined;
  if (!s.file && Date.now() - s.at > MISS_MS) { looked.delete(path); return undefined; }
  return s.file;
}

async function look(path: string): Promise<void> {
  const r = await (window.realm?.files?.stat?.(path) ?? Promise.resolve(null)).catch(() => null);
  looked.set(path, { file: r !== null && r !== undefined, at: Date.now() });
}

/** Test seam: the answers are process-wide, so a suite must start each case from nothing. */
export function forgetLookedFiles(): void { looked.clear(); }

/** What the disk has said so far about a mark: its file, null when no candidate is a file, and
 *  undefined while a candidate still has to be asked about. */
function resolvedFile(ref: string, ctx: FileLinkContext): string | null | undefined {
  for (const p of fileCandidates(ref, ctx)) {
    const s = seen(p);
    if (s === undefined) return undefined;
    if (s) return p;
  }
  return null;
}

async function ask(ref: string, ctx: FileLinkContext): Promise<void> {
  for (const p of fileCandidates(ref, ctx)) {
    if (seen(p) === undefined) await look(p);
    if (seen(p)) return;
  }
}

/**
 * Upgrade the marks in a rendered message into links as the disk confirms them. A layout effect, so a
 * re-render of the same markup re-applies what is already known before it paints and a link never
 * blinks back to plain text; what still has to be asked is asked once, and the effect runs again
 * when the answers are in. No context, no links — a read-only mount, or a message still streaming.
 */
export function useFileLinks(body: RefObject<HTMLElement | null>, html: string, ctx: FileLinkContext | undefined): void {
  const [answers, setAnswers] = useState(0);
  useLayoutEffect(() => {
    const el = body.current;
    if (!el || !ctx) return;
    const pending: Promise<void>[] = [];
    for (const mark of Array.from(el.querySelectorAll<HTMLElement>("[data-file-ref]"))) {
      const ref = mark.getAttribute("data-file-ref") ?? "";
      const file = resolvedFile(ref, ctx);
      if (file) upgradeFileRef(mark, file, ctx.root);
      else if (file === undefined) pending.push(ask(ref, ctx));
    }
    if (pending.length === 0) return;
    let live = true;
    void Promise.all(pending).then(() => { if (live) setAnswers((n) => n + 1); });
    return () => { live = false; };
  }, [body, html, ctx, answers]);
}
