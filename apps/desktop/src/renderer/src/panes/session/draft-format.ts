import { scanElementChips, scanMentions } from "@realm/contracts";

/**
 * The prompter's rich-text layer, as pure functions over the draft string.
 *
 * The draft stays a plain string end to end — the store holds it, `mentionQueryAt` indexes into it,
 * `scanMentions` re-reads it at send, and the three agent wires take markdown text. So "rich text"
 * here is PAINT, not a document model: `highlightSegments` cuts the same string into coloured runs
 * that Composer renders into a mirror layer sitting exactly under the textarea, and the list helpers
 * rewrite the string the way a list editor would. Nothing in this file changes what gets sent.
 *
 * The one hard constraint on every colour the mirror can wear: it must not move a glyph. The mirror
 * and the textarea share a font, a size, a line-height and a padding box, and the caret the user sees
 * is the textarea's — so a run may change colour, background and underline, and may never change
 * weight, family, size or spacing. `**bold**` is therefore not bolded; markdown's own markers are
 * dimmed instead, which reads as structure without shifting a single character.
 */

/** What a run of draft text is. `null` (below) means "plain" — no span, no class. */
export type SegmentKind =
  /** A URL. Underlined in the link colour, exactly as it will render in the transcript. */
  | "link"
  /** An `@id` that `scanMentions` resolves — this one WILL reach the agent as a skill. */
  | "mention"
  /** An `@id` the draft still declares whose skill is gone: it goes as plain text (see `staleMentions`). */
  | "mention-stale"
  /** The punctuation that opens a line and gives it structure: a list bullet, `>`, `#`. */
  | "marker"
  /** Inline markdown punctuation — a `**` pair. Dimmed, because the text between it cannot be
   *  bolded here without the mirror's glyphs drifting off the textarea's caret. */
  | "punct"
  /** A backticked span. Tinted, never re-typefaced — a monospace run here would shift the caret. */
  | "code"
  /** An `@[…]` token standing for an element the user picked in a browser pane. */
  | "element";

export type Segment = { text: string; kind: SegmentKind | null };

/** A claimed range of the draft, before overlaps are resolved. */
type Span = { start: number; end: number; kind: SegmentKind; rank: number };

/* Rank breaks ties when two spans start together, and decides who wins when they overlap: a URL
   inside backticks is code, an `@` inside a URL is neither. Lower wins. `element` shares marker's 0
   because its rank never decides anything: no other span here can begin at `@[`, so an element chip
   is never in a tie. */
const RANK = { element: 0, marker: 0, punct: 1, code: 2, link: 3, mention: 4 } as const;

/** `http(s)://…` and bare `www.…`, up to whitespace. Trailing punctuation is trimmed below — a URL
 *  ending a sentence must not swallow the full stop, and a URL in parentheses must not eat the `)`. */
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>]+/g;
/** A backticked run. Deliberately single-line: a stray backtick must not tint the rest of the draft. */
const CODE_RE = /`[^`\n]+`/g;
/** A `**bold**` pair — only the four asterisks are claimed, never the text between them. */
const BOLD_RE = /\*\*(?=\S)([^*\n]+)(?<=\S)\*\*/g;
/** The list/quote/heading punctuation opening a line: indent, marker, and the space after it. */
const LINE_MARKER_RE = /^([ \t]*)(?:([-*+])|(\d{1,9}[.)])|(>+)|(#{1,6}))([ \t]+)/;

/** Characters that end a sentence rather than a URL. `)` is trimmed only when unbalanced. */
const URL_TRAIL = /[.,;:!?'"]+$/;

function urlEnd(text: string, start: number, raw: string): number {
  let s = raw.replace(URL_TRAIL, "");
  // A closing paren belongs to the URL only if the URL opened one (wiki links do this constantly).
  while (s.endsWith(")") && (s.match(/\(/g)?.length ?? 0) < (s.match(/\)/g)?.length ?? 0)) s = s.slice(0, -1).replace(URL_TRAIL, "");
  return start + s.length;
}

/**
 * The draft cut into runs, in order, covering every character exactly once.
 *
 * `liveIds` are the skills this session can actually hand over; `staleIds` are ids the draft still
 * declares whose skill has since been disabled or deleted. Both go through `scanMentions` — the same
 * function the server re-runs on the sent text — so a token is coloured as a mention if and only if
 * it would resolve as one. A highlight that guessed differently from the wire would be a lie told in
 * the one place the user could still act on it.
 */
export function highlightSegments(text: string, liveIds: Iterable<string>, staleIds: Iterable<string> = []): Segment[] {
  const spans: Span[] = [];
  // An element chip's label is arbitrary page text, so a URL or a backtick inside it must not cut the
  // token in half. What protects it is that it starts first: the `@[` is always left of anything the
  // label contains, and a span starting inside an already-emitted one is dropped whole.
  for (const c of scanElementChips(text)) spans.push({ start: c.start, end: c.end, kind: "element", rank: RANK.element });
  for (const t of scanMentions(text, liveIds)) spans.push({ start: t.start, end: t.end, kind: "mention", rank: RANK.mention });
  for (const t of scanMentions(text, staleIds)) spans.push({ start: t.start, end: t.end, kind: "mention-stale", rank: RANK.mention });
  for (const m of text.matchAll(CODE_RE)) spans.push({ start: m.index, end: m.index + m[0].length, kind: "code", rank: RANK.code });
  for (const m of text.matchAll(URL_RE)) {
    const end = urlEnd(text, m.index, m[0]);
    if (end > m.index) spans.push({ start: m.index, end, kind: "link", rank: RANK.link });
  }
  for (const m of text.matchAll(BOLD_RE)) {
    spans.push({ start: m.index, end: m.index + 2, kind: "punct", rank: RANK.punct });
    const close = m.index + m[0].length;
    spans.push({ start: close - 2, end: close, kind: "punct", rank: RANK.punct });
  }
  // Line-opening punctuation, walked with a running offset so the spans are absolute like the rest.
  for (let at = 0; at <= text.length; ) {
    const nl = text.indexOf("\n", at);
    const line = text.slice(at, nl < 0 ? text.length : nl);
    const m = LINE_MARKER_RE.exec(line);
    if (m) spans.push({ start: at + m[1]!.length, end: at + m[0].length - m[6]!.length, kind: "marker", rank: RANK.marker });
    if (nl < 0) break;
    at = nl + 1;
  }

  // Earliest span wins; ties break by rank; anything overlapping an already-emitted span is dropped
  // whole rather than truncated (half a URL in the link colour is worse than none).
  spans.sort((a, b) => a.start - b.start || a.rank - b.rank || b.end - a.end);
  const out: Segment[] = [];
  let cur = 0;
  const push = (s: string, kind: SegmentKind | null) => {
    if (!s) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += s; // adjacent plain runs merge — fewer DOM nodes
    else out.push({ text: s, kind });
  };
  for (const s of spans) {
    if (s.start < cur) continue;
    push(text.slice(cur, s.start), null);
    push(text.slice(s.start, s.end), s.kind);
    cur = s.end;
  }
  push(text.slice(cur), null);
  return out;
}

// ── List authoring ─────────────────────────────────────────────────────────

/** The list item opening `line`, if it is one. `content` is what follows the marker. */
export type ListItem = { indent: string; marker: string; space: string; ordered: boolean; content: string };

const LIST_RE = /^([ \t]*)(?:([-*+])|(\d{1,9})([.)]))([ \t]+)(.*)$/;

export function listItemAt(line: string): ListItem | null {
  const m = LIST_RE.exec(line);
  if (!m) return null;
  return { indent: m[1]!, marker: m[2] ?? `${m[3]}${m[4]}`, space: m[5]!, ordered: m[2] === undefined, content: m[6]! };
}

/** The [start, end) of the line containing `pos` — end excludes the newline. */
function lineRange(text: string, pos: number): [number, number] {
  const start = text.lastIndexOf("\n", pos - 1) + 1;
  const nl = text.indexOf("\n", pos);
  return [start, nl < 0 ? text.length : nl];
}

/** Every line index touched by [selStart, selEnd], as [start, end) pairs. */
function selectedLines(text: string, selStart: number, selEnd: number): [number, number][] {
  const out: [number, number][] = [];
  let at = lineRange(text, selStart)[0];
  const last = lineRange(text, selEnd)[1];
  while (at <= last) {
    const [s, e] = lineRange(text, at);
    out.push([s, e]);
    if (e >= last) break;
    at = e + 1;
  }
  return out;
}

/** A rewrite of the draft plus where the selection lands. Collapsed when `start === end`. */
export type DraftEdit = { text: string; start: number; end: number };

/**
 * Enter inside a list item: carry the list on.
 *
 * An item with content gets a sibling — same indent, same bullet, the next number for an ordered one.
 * An EMPTY item ends the list instead: one level of indent is dropped if there is one (so a nested
 * list unwinds a step at a time), and at the outer level the marker is cleared outright. That two-step
 * exit is the behaviour every list editor has, and it is why Enter on an empty bullet must not just
 * insert another bullet forever.
 *
 * Returns null when the caret is not in a list item — the caller inserts its ordinary newline.
 */
export function continueList(text: string, caret: number): DraftEdit | null {
  const [ls, le] = lineRange(text, caret);
  const item = listItemAt(text.slice(ls, le));
  if (!item) return null;
  if (item.content.trim() === "") {
    // Unwind: indented items step out one level, outer items lose the marker and become a blank line.
    const next = item.indent === "" ? "" : `${item.indent.slice(0, -Math.min(2, item.indent.length))}${item.marker}${item.space}`;
    return { text: text.slice(0, ls) + next + text.slice(le), start: ls + next.length, end: ls + next.length };
  }
  const marker = item.ordered ? `${Number.parseInt(item.marker, 10) + 1}${item.marker.slice(-1)}` : item.marker;
  const insert = `\n${item.indent}${marker}${item.space}`;
  const pos = caret + insert.length;
  return { text: text.slice(0, caret) + insert + text.slice(caret), start: pos, end: pos };
}

/** Two spaces per level — the width every markdown renderer reads as a nested item. */
const INDENT = "  ";

/**
 * Tab / Shift+Tab over list items: shift the selected items one level.
 *
 * Returns null unless at least one selected line IS a list item, which is what leaves Tab as Tab
 * everywhere else — stealing the key from a plain draft would trap keyboard users in the textarea.
 */
export function indentList(text: string, selStart: number, selEnd: number, dir: 1 | -1): DraftEdit | null {
  const lines = selectedLines(text, selStart, selEnd);
  if (!lines.some(([s, e]) => listItemAt(text.slice(s, e)))) return null;
  let out = "";
  let prev = 0;
  let startShift = 0;
  let endShift = 0;
  for (const [s, e] of lines) {
    const line = text.slice(s, e);
    const item = listItemAt(line);
    let delta = 0;
    let next = line;
    if (item) {
      if (dir === 1) { next = INDENT + line; delta = INDENT.length; }
      else if (item.indent.length > 0) { const cut = Math.min(INDENT.length, item.indent.length); next = line.slice(cut); delta = -cut; }
    }
    out += text.slice(prev, s) + next;
    prev = e;
    if (s < selStart) startShift += delta;
    endShift += delta;
  }
  // A caret sitting inside the indent that was just removed must not slide before its line start.
  const start = Math.max(lineRange(text, selStart)[0], selStart + startShift);
  return { text: out + text.slice(prev), start, end: Math.max(start, selEnd + endShift) };
}

/**
 * Toggle the selected lines into (or out of) a bullet or numbered list — ⌘⇧8 / ⌘⇧7, the shortcuts
 * these have in every editor that has them.
 *
 * Already-a-list-of-this-kind flips OFF (markers stripped); anything else flips ON, which includes
 * converting the other kind. Blank lines inside the selection are left blank rather than given an
 * empty bullet. Numbering always restarts at 1 down the selection, so toggling a paragraph into an
 * ordered list never emits `1. 1. 1.`.
 */
export function toggleList(text: string, selStart: number, selEnd: number, ordered: boolean): DraftEdit {
  const lines = selectedLines(text, selStart, selEnd);
  const bodies = lines.map(([s, e]) => text.slice(s, e));
  const filled = bodies.filter((l) => l.trim() !== "");
  const off = filled.length > 0 && filled.every((l) => listItemAt(l)?.ordered === ordered);
  let out = "";
  let prev = 0;
  let n = 0;
  let startShift = 0;
  let endShift = 0;
  for (let i = 0; i < lines.length; i++) {
    const [s, e] = lines[i]!;
    const line = bodies[i]!;
    const item = listItemAt(line);
    let next = line;
    if (line.trim() === "") next = line;
    else if (off) next = `${item!.indent}${item!.content}`;
    else { n += 1; next = `${item?.indent ?? ""}${ordered ? `${n}.` : "-"} ${item ? item.content : line.trimStart()}`; }
    const delta = next.length - line.length;
    out += text.slice(prev, s) + next;
    prev = e;
    if (s < selStart) startShift += delta;
    endShift += delta;
  }
  const start = Math.max(lineRange(text, selStart)[0], selStart + startShift);
  return { text: out + text.slice(prev), start, end: Math.max(start, selEnd + endShift) };
}

// ── Chip editing ───────────────────────────────────────────────────────────

/**
 * Backspace at the trailing edge of an element chip deletes the whole token.
 *
 * Element chips only, and the asymmetry is the point. `@[button "Sign in"]` is syntax the user never
 * types through: `@[` is not something a hand produces by accident, and half of it — `@[button "Sign`
 * — is neither a chip nor anything an agent can use. A mention is the opposite: `@mac` is a valid
 * chip that a hand passes THROUGH on its way to typing `@mac-cli`, so an atomic backspace there would
 * eat four characters at the one moment the user is mid-word.
 *
 * Null for everything else, including a non-empty selection: a selection is already the user saying
 * exactly what to delete, and overriding it would be the editor arguing.
 */
export function deleteElementChipBefore(text: string, caret: number): DraftEdit | null {
  const chip = scanElementChips(text).find((c) => c.end === caret);
  if (!chip) return null;
  return { text: text.slice(0, chip.start) + text.slice(chip.end), start: chip.start, end: chip.start };
}
