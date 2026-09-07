/**
 * Filesystem paths in an agent's prose, made reachable.
 *
 * An agent that writes six files and then tells you where they are has produced six artifacts you
 * cannot get to: the text names them and nothing opens them, so the only way to read what was just
 * written is to leave for the Finder. This is the scan that turns those names into things you can
 * click.
 *
 * **Conservative by construction.** A false positive here is worse than a miss: it puts a control in
 * the middle of a sentence that was not about a file. So only two shapes are recognised, and both
 * are shapes prose does not produce by accident:
 *
 *  - **Inline code whose WHOLE content is a path.** The overwhelmingly common case — an agent writes
 *    `/Users/…/PROFILE.md` in backticks — and the least ambiguous, because the author already marked
 *    it as machine text.
 *  - **Absolute paths in running text**, starting `/` or `~/`, with at least two segments. Relative
 *    paths are deliberately NOT matched in prose: `and/or`, `he/she` and every date are relative
 *    paths by any loose rule, and the cost of getting that wrong is a sentence full of buttons.
 *
 * Nothing inside a link, a code block or a heading is touched: a `<pre>` is a thing you copy whole,
 * and an `<a>` already has a destination.
 */

/** One path segment: word characters and the punctuation filenames really carry. Deliberately
 *  excludes `,` `;` `)` and quotes, which end a path in prose far more often than they are in one. */
const SEG = String.raw`[\w.@%+-]+`;
/** An absolute path with at least two segments. The trailing `/?` lets a directory match. */
const ABS = new RegExp(String.raw`(?:~|)(?:\/${SEG}){2,}\/?`, "g");
/** Anything a whole `<code>` may be for it to count as a path: the absolute form above, or a
 *  relative one that carries a separator AND an extension (`applications/ESSAY-BANK.md`). */
const CODE_PATH = new RegExp(String.raw`^(?:(?:~|\.{1,2})?(?:\/${SEG})+\/?|${SEG}(?:\/${SEG})+\.${SEG})$`);

/** Elements whose text is never scanned. A link has a destination already; a code block is copied
 *  whole; a heading is a label, not a location. */
const SKIP = new Set(["A", "PRE", "CODE", "H1", "H2", "H3", "H4", "H5", "H6", "BUTTON"]);

/** Trailing punctuation that ends the sentence rather than the path. A path really can end in a dot
 *  segment, so only a dot FOLLOWED BY nothing is dropped. */
const trimTail = (p: string): string => p.replace(/[.,;:!?]+$/, "");

/** Whether this looks like a path Realm should offer to open. Exported for the tests, which is where
 *  the false-positive budget is actually spent. */
export function looksLikePath(text: string): boolean {
  const t = text.trim();
  if (t.length < 3 || t.includes("://") || t.includes(" ")) return false;
  return CODE_PATH.test(t);
}

/**
 * Mark every path in a sanitized fragment.
 *
 * Mutates in place and returns the count, which the caller uses only to decide whether to bother
 * attaching a click handler. The mark is a `<button>` rather than an `<a>`: there is no href that
 * would mean anything here, and a button is what a screen reader should announce for something that
 * opens a pane.
 */
export function markPaths(root: ParentNode): number {
  let found = 0;
  const doc = root.ownerDocument ?? (root as unknown as Document);

  // 1. Inline code that IS a path, marked in place so the code styling survives.
  for (const code of Array.from(root.querySelectorAll("code"))) {
    if (code.closest("pre") || code.closest("a")) continue;
    const text = code.textContent ?? "";
    if (!looksLikePath(text)) continue;
    code.classList.add("md-path");
    code.setAttribute("data-path", text.trim());
    code.setAttribute("role", "button");
    code.setAttribute("tabindex", "0");
    code.setAttribute("title", `${text.trim()} — click to open`);
    found += 1;
  }

  // 2. Absolute paths in running text. Collected first: replacing a text node while walking the
  //    tree it is in would invalidate the walk.
  const walker = doc.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    if (!t.data.includes("/")) continue;
    const parent = t.parentElement;
    if (!parent || parent.closest(SKIP_SELECTOR)) continue;
    ABS.lastIndex = 0;
    if (ABS.test(t.data)) targets.push(t);
  }
  for (const t of targets) {
    const frag = doc.createDocumentFragment();
    let last = 0;
    ABS.lastIndex = 0;
    for (let m = ABS.exec(t.data); m; m = ABS.exec(t.data)) {
      const raw = trimTail(m[0]);
      if (raw.length < 3) continue;
      if (m.index > last) frag.append(t.data.slice(last, m.index));
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "md-path";
      btn.setAttribute("data-path", raw);
      btn.title = `${raw} — click to open`;
      btn.textContent = raw;
      frag.append(btn);
      last = m.index + raw.length;
      found += 1;
    }
    if (last < t.data.length) frag.append(t.data.slice(last));
    t.replaceWith(frag);
  }
  return found;
}

const SKIP_SELECTOR = [...SKIP].map((t) => t.toLowerCase()).join(",");
