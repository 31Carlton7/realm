import { basenameOf } from "@realm/contracts";
import { blockKey, goalTurnLabel, type Block, type UserBlock } from "./transcript-model";

/** One prompt on the scroll track: its tick, and what its card says. */
export type TrackPrompt = {
  /** The user row's render key (`blockKey`), which is how its row is found in the column. */
  key: string;
  /** When it was sent. */
  ts: number;
  /** What the card leads with: the message's first line, or what stands in for one. */
  title: string;
  /** The session that asked it, when another one did. The bubble is attributed, so the card is. */
  from: string | null;
  /** How the answer opens, as plain text. Null until the agent has said anything. */
  reply: string | null;
  /** Files the turn changed, as its Edited card counts them. 0 for a turn that changed none. */
  edited: number;
};

/** The least distance between two ticks: Codex's pitch, and about the least a pointer can tell apart. */
export const TICK_PITCH = 10;
/** How much track a pixel of scrollback is worth, before the track runs out of room — at 1/40 a turn
 *  shorter than 400px is a pitch like any other, and only a long one opens a gap. */
export const TRACK_SCALE = 1 / 40;
/** How far into the answer the card reads. It clamps to three lines anyway; this keeps a reply that is
 *  still streaming from rebuilding the card on every token once there is more than it can show. */
const OPENING_MAX = 240;
/** How much of a row has to be on screen before it counts as on screen, at the log's end. */
const ON_SCREEN_PX = 24;

const ELEMENT_TOKEN = /@\[([^\]\n]+)\]/g;

/** One line, its whitespace collapsed. */
const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

const firstLine = (text: string): string => text.split("\n").map(squash).find(Boolean) ?? "";

/** What a prompt's card leads with. A goal's own turn is named as the bubble names it — nobody typed
 *  it — and a message that carried only files is the files. */
function promptTitle(b: UserBlock): string {
  if (b.goal) return goalTurnLabel(b.goal);
  // A picked element's token is a delimiter round its label; the bubble draws the label alone.
  const line = firstLine(b.text.replace(ELEMENT_TOKEN, "$1"));
  if (line) return line;
  return b.attachments?.map((a) => basenameOf(a.path)).join(", ") || "Message";
}

/** A line of markdown as the words a reader sees: no heading, quote or list marks, a link as its text. */
const plainLine = (line: string): string => squash(line
  .replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
  .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
  .replace(/\*\*|__|~~|`/g, ""));

/** A rule or a table's divider row: structure, with no words in it. */
const STRUCTURE = /^(?:[-*_]\s*){3,}$|^\|?\s*:?-{3,}/;

/**
 * How an answer opens, for the card: its first paragraphs as plain text, one line each. Code is left
 * out — an answer that opens on a fenced block opens, for a reader skimming, on the sentence after it
 * — and so is everything past what three lines can show. Null when there are no words yet.
 */
export function opening(md: string): string | null {
  const lines: string[] = [];
  let fenced = false, length = 0;
  for (const raw of md.split("\n")) {
    if (/^\s*(?:```|~~~)/.test(raw)) { fenced = !fenced; continue; }
    if (fenced || STRUCTURE.test(raw.trim())) continue;
    const line = plainLine(raw);
    if (!line) continue;
    lines.push(line);
    length += line.length;
    if (length >= OPENING_MAX) break;
  }
  if (lines.length === 0) return null;
  const text = lines.join("\n");
  if (text.length <= OPENING_MAX) return text;
  const cut = text.slice(0, OPENING_MAX);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), OPENING_MAX - 20)).trimEnd()}…`;
}

/**
 * Every prompt in the log, in order — the user's own messages, a peer's question and a goal's turns
 * alike, because each starts a turn the reader may want to go back to.
 *
 * `editedBy(i)` is the number of files the run line at block `i` closes its turn on, read from the
 * transcript's own Edited cards, so the track and the card under the turn cannot disagree about it.
 */
export function trackPrompts(blocks: readonly Block[], editedBy: (runIndex: number) => number): TrackPrompt[] {
  const out: TrackPrompt[] = [];
  let open: TrackPrompt | null = null;
  // A turn that failed before it said anything is still a turn the card can describe.
  let failed: string | null = null;
  const settle = () => { if (open && open.reply === null && failed) open.reply = failed; };
  blocks.forEach((b, i) => {
    if (b.kind === "user") {
      settle();
      open = { key: blockKey(b, i), ts: b.ts, title: promptTitle(b), from: b.from?.title ?? null, reply: null, edited: 0 };
      failed = null;
      out.push(open);
      return;
    }
    if (!open) return;
    if (b.kind === "assistant" && open.reply === null) open.reply = opening(b.text);
    else if (b.kind === "error" && failed === null) failed = firstLine(b.message) || null;
    else if (b.kind === "run") open.edited = Math.max(open.edited, editedBy(i));
  });
  settle();
  return out;
}

/** Whether two prompt lists say the same thing — what keeps a streaming turn from handing the track a
 *  new list, and every tick a re-render, on each token. */
export function samePrompts(a: readonly TrackPrompt[], b: readonly TrackPrompt[]): boolean {
  return a.length === b.length && a.every((p, i) => {
    const q = b[i]!;
    return p.key === q.key && p.ts === q.ts && p.title === q.title && p.from === q.from && p.reply === q.reply && p.edited === q.edited;
  });
}

/**
 * Where each tick sits, from where each prompt sits in the scrollback: `offsets` are the prompts' tops
 * in the log, `room` the track's height, and the answer is each tick's distance from the first.
 *
 * A tick is as far below the one before it as that turn is long, at `TRACK_SCALE` — but never less than
 * `TICK_PITCH`, so a log of short turns is simply evenly spaced. When that would run past the room, the
 * scale comes down until it fits, and the pitch is held as long as it can be: the short turns keep
 * their spacing and the long ones give up the difference. A log with more prompts than the room has
 * pitches for is evenly spaced at whatever pitch it has.
 */
export function tickPositions(offsets: readonly number[], room: number): number[] {
  if (offsets.length === 0) return [];
  const spans = offsets.slice(1).map((y, i) => Math.max(0, y - offsets[i]!));
  const floor = spans.length === 0 ? 0 : Math.min(TICK_PITCH, Math.max(0, room) / spans.length);
  const length = (k: number) => spans.reduce((sum, d) => sum + Math.max(floor, d * k), 0);
  let scale = TRACK_SCALE;
  if (length(scale) > room) {
    let lo = 0, hi = scale;
    for (let i = 0; i < 32; i++) { const mid = (lo + hi) / 2; if (length(mid) > room) hi = mid; else lo = mid; }
    scale = lo;
  }
  const out = [0];
  for (const d of spans) out.push(out.at(-1)! + Math.max(floor, d * scale));
  return out;
}

/** The log's viewport, in the coordinates the offsets are measured in. `inset` is the log's top
 *  padding — where a prompt the track jumps to comes to rest. */
export type TrackView = { top: number; height: number; scrollHeight: number; inset: number };

/**
 * The prompt being read: the last one whose row has come up past the reading line a third of the way
 * down the log, so a prompt stays current while its answer is read. Once the log is at its end and can
 * move no further, it is the last one on screen at all — or a short final turn could never become the
 * current one. Before any row has reached the line, the first prompt is current.
 */
export function currentPrompt(offsets: readonly number[], view: TrackView): number {
  if (offsets.length === 0) return -1;
  const atEnd = view.scrollHeight - view.top - view.height < 2;
  // The line sits below the inset, so a prompt the track has just brought to rest there is past it.
  const line = view.top + (atEnd ? view.height - ON_SCREEN_PX : Math.max(view.height / 3, view.inset + 1));
  let i = 0;
  while (i + 1 < offsets.length && offsets[i + 1]! <= line) i++;
  return i;
}
