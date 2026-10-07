import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Everything a click acts on is something the pointer rule points at.
 *
 * The hand comes from ONE rule in styles.css, written against what an element is — its tag or its role
 * — rather than against forty class names, so a control written tomorrow points without a rule of its
 * own. That only holds if the control IS one of those things. A `<div onClick>` with no role is a
 * button to the mouse and a block of text to the stylesheet, the keyboard and a screen reader alike,
 * and it keeps the arrow however the rest of the app points. So the audit is of the markup: every
 * element in the renderer that answers a press is a tag or a role the rule lists, or is named below
 * with the reason a press there is not a click on a control.
 *
 * jsdom computes no cursor and lays out nothing, so this reads the source, as styles.test.ts reads the
 * stylesheet; the live check (`audits-live.mjs`) reads the cursor off the real window.
 */

/* Vite rewrites `import.meta.url` under jsdom, so walk up from the cwd — styles.test.ts's way. */
function repoFile(rel: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) { const p = join(dir, rel); if (existsSync(p)) return p; dir = dirname(dir); }
  throw new Error(`cannot locate ${rel} from ${process.cwd()}`);
}
const root = repoFile("apps/desktop/src/renderer/src");
const css = readFileSync(join(root, "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The pointer rule's own list, as the stylesheet writes it. */
const pointerList = (() => {
  const m = /:where\(([^{}]*)\)\s*\{\s*cursor:\s*pointer;\s*\}/.exec(css);
  return m ? m[1]!.replace(/\s+/g, " ") : "";
})();

/** The tags and roles a press may land on and point, read back out of that list. */
const POINTING_TAGS = ["button", "a", "summary", "select", "input", "label", "option", "textarea"];
const POINTING_ROLES = [...pointerList.matchAll(/\[role="([\w-]+)"\]/g)].map((m) => m[1]!);

/**
 * Elements that answer a press and rightly keep the arrow, by the class they wear (or, for one with
 * none, the file and tag). Each is a surface, not a control: what a press there does is not a click
 * on a thing the person was pointing at.
 */
const NOT_A_CONTROL: Record<string, string> = {
  "palette-backdrop": "the dimmed window round the palette: a press there puts the palette away",
  "sheet-backdrop": "the same, round a sheet",
  "spaces-backdrop": "the same, round the spaces overview",
  "quick-chat-bar": "a drag handle, which takes the grab cursor of its own",
  "sb-resize": "the sidebar's edge, which takes the resize cursor of its own",
  "resize-handle": "the side panel's edge, which takes the resize cursor of its own, as the sidebar's does",
  "hero-greeting": "the greeting's hidden nod, which nothing announces and nothing depends on",
  "selection-bar": "a toolbar whose press only keeps the text selection it acts on; its buttons point",
  "sim-screen": "a device's own screen, where the pointer stands in for a finger",
  "media-el": "a video's picture, which its play control sits over",
  "media-viewer-stage": "the viewer's ground round a file: a press there puts the viewer away, as a scrim's does",
  "media-viewer-canvas": "a zoomed picture's canvas, which takes the grab cursor of its own while it pans",
  "panes/session/Markdown.tsx:div": "a message's prose, which takes its links' clicks for them; each link wears its own role",
};

type Found = { file: string; line: number; tag: string; role: string | null; key: string };

/** Every lower-case JSX element that answers a press. Crude, and deliberately so: a tag is `<name`
 *  where an expression could start one, its attributes run to the first `>` outside braces and
 *  strings — enough to read a renderer whose markup is written one way throughout. */
function pressables(file: string, src: string): Found[] {
  const out: Found[] = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== "<") continue;
    const m = /^<([a-z][\w-]*)[\s>/]/.exec(src.slice(i, i + 40));
    if (!m) continue;
    // A `<` after a name, a quote or a backtick is a generic, a comparison or a string, not markup.
    if (/[\w"'`$.\]]/.test(src[i - 1] ?? "")) continue;
    let depth = 0, j = i + m[1]!.length + 1, quote: string | null = null;
    for (; j < src.length; j++) {
      const ch = src[j]!;
      if (quote) { if (ch === quote && src[j - 1] !== "\\") quote = null; continue; }
      // A comment in a handler is prose, and prose has apostrophes: read past it, or its "panel's"
      // opens a string that swallows the markup after it.
      if (depth > 0 && ch === "/" && src[j + 1] === "/") { const nl = src.indexOf("\n", j); if (nl < 0) break; j = nl; continue; }
      if (depth > 0 && ch === "/" && src[j + 1] === "*") { const end = src.indexOf("*/", j + 2); if (end < 0) break; j = end + 1; continue; }
      if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) break;
    }
    const tag = src.slice(i, j + 1);
    if (!/\bon(Click|MouseDown|PointerDown|DoubleClick)=/.test(tag)) continue;
    const role = /\brole="([\w-]+)"/.exec(tag)?.[1] ?? null;
    const cls = /className=(?:"([^"]*)"|\{`([^`]*)`\}|\{"([^"]*)")/.exec(tag);
    const first = (cls?.[1] ?? cls?.[2] ?? cls?.[3] ?? "").trim().split(/\s+/)[0] ?? "";
    out.push({ file, line: src.slice(0, i).split("\n").length, tag: m[1]!, role, key: first || `${file}:${m[1]}` });
  }
  return out;
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx$/.test(f) && !/\.test\./.test(f) ? [p] : [];
  });
}

const found = sources(root).flatMap((p) => pressables(relative(root, p), readFileSync(p, "utf8")));

describe("everything a click acts on points", () => {
  it("reads the real renderer", () => {
    // A scan that matched nothing would pass everything below.
    expect(found.length).toBeGreaterThan(20);
    expect(POINTING_ROLES).toEqual(expect.arrayContaining(["button", "link", "tab", "option", "switch", "menuitem"]));
  });

  it("is a tag or a role the pointer rule lists, or a surface named with its reason", () => {
    /* THE mutants: a `<div onClick>` with no role (a button nobody can tab to, wearing the arrow), or
       a role dropped from the stylesheet's list (every control of that kind loses the hand). */
    const strays = found.filter((f) => !POINTING_TAGS.includes(f.tag) && !(f.role && POINTING_ROLES.includes(f.role)) && !(f.key in NOT_A_CONTROL))
      .map((f) => `${f.file}:${f.line} <${f.tag}${f.role ? ` role=${f.role}` : ""}> ${f.key}`);
    expect(strays).toEqual([]);
  });

  it("names no surface that is not there any more", () => {
    // An exception for markup that has gone is a hole left open for the next `<div onClick>` to use.
    const keys = new Set(found.map((f) => f.key));
    expect(Object.keys(NOT_A_CONTROL).filter((k) => !keys.has(k))).toEqual([]);
  });
});
