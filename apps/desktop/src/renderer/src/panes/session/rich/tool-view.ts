import { isPlayablePath } from "@realm/contracts";
import { fileDiffsFor, isUnifiedDiff, parseUnifiedDiff, type FileDiff } from "./diff";

/** What a tool call's input and result should be DRAWN as, rather than dumped as JSON and text.
 *
 *  A tool card's two wells are the transcript's most-read surface and its least designed one: an
 *  Edit's payload is the change the agent is about to make, a TodoWrite's is a plan, a Bash result
 *  is a terminal. Rendering all three as `JSON.stringify(…, 2)` makes the reader do the parsing.
 *
 *  Two rules hold everywhere in here:
 *  - A view is only claimed when the payload actually supports it. Every parser returns null on
 *    anything it does not fully understand, and null means "show the raw well" — a half-parsed view
 *    silently drops content, and the reader cannot tell what is missing.
 *  - Nothing is inferred that the payload does not state. No guessed line numbers, no guessed exit
 *    codes, no "probably a file list".
 */

export type Todo = { content: string; status: "pending" | "in_progress" | "completed"; activeForm: string | null };
export type Match = { line: number | null; text: string };
export type MatchGroup = { path: string; matches: Match[] };

export type ToolInputView =
  | { kind: "diff"; files: FileDiff[] }
  | { kind: "todos"; todos: Todo[] }
  | { kind: "command"; command: string; cwd: string | null; description: string | null }
  | { kind: "request"; url: string | null; query: string | null; prompt: string | null };

export type ToolResultView =
  | { kind: "diff"; files: FileDiff[] }
  | { kind: "terminal"; output: string; exitCode: number | null }
  | { kind: "code"; path: string; text: string; firstLine: number | null }
  | { kind: "matches"; groups: MatchGroup[]; note: string | null };

const str = (o: Record<string, unknown>, k: string): string | null => (typeof o[k] === "string" && (o[k] as string).length > 0 ? (o[k] as string) : null);

const DIFF_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "apply_patch"]);
const COMMAND_TOOLS = new Set(["Bash", "exec_command"]);

/** TodoWrite's list, or null if the payload is not the shape it documents. `activeForm` is optional
 *  in practice, so its absence is carried as null rather than faked from `content`. */
export function parseTodos(input: Record<string, unknown>): Todo[] | null {
  const todos = input["todos"];
  if (!Array.isArray(todos) || todos.length === 0) return null;
  const out: Todo[] = [];
  for (const t of todos) {
    if (!t || typeof t !== "object") return null;
    const bag = t as Record<string, unknown>;
    const content = str(bag, "content");
    const status = str(bag, "status");
    if (content === null || (status !== "pending" && status !== "in_progress" && status !== "completed")) return null;
    out.push({ content, status, activeForm: str(bag, "activeForm") });
  }
  return out;
}

export function toolInputView(name: string, input: Record<string, unknown>): ToolInputView | null {
  if (DIFF_TOOLS.has(name)) {
    const files = fileDiffsFor(name, input);
    return files ? { kind: "diff", files } : null;
  }
  if (COMMAND_TOOLS.has(name)) {
    const command = str(input, "command");
    return command ? { kind: "command", command, cwd: str(input, "cwd"), description: str(input, "description") } : null;
  }
  if (name === "TodoWrite") {
    const todos = parseTodos(input);
    return todos ? { kind: "todos", todos } : null;
  }
  if (name === "WebFetch" || name === "WebSearch" || name === "webSearch") {
    const url = str(input, "url"), query = str(input, "query");
    return url || query ? { kind: "request", url, query, prompt: str(input, "prompt") } : null;
  }
  return null;
}

/** A trailing `[exit N]` line, which is how the Codex mapper records a non-zero exit — the only
 *  place an exit code appears in a result at all. Claude's Bash result carries none, and this
 *  returns null there rather than assuming success. */
export function splitExitCode(output: string): { output: string; exitCode: number | null } {
  const m = /\n?\[exit (\d+)\]\s*$/.exec(output);
  if (!m) return { output, exitCode: null };
  return { output: output.slice(0, m.index), exitCode: Number(m[1]) };
}

/** `cat -n`-style numbering, which is exactly how Read returns a file: right-aligned number, a tab,
 *  the line. Returns the stripped text and the first line's real number — so a `Read` with an offset
 *  keeps the file's own numbering instead of restarting at 1.
 *
 *  Requires EVERY non-empty line to carry a number: one unnumbered line means this is not a numbered
 *  listing (an error message, a truncation notice), and stripping a prefix off the rest would
 *  silently mangle it. */
export function stripLineNumbers(text: string): { text: string; firstLine: number } | null {
  const lines = text.split("\n");
  if (lines.length === 0) return null;
  const out: string[] = [];
  let first = 0, seen = 0, prev = 0;
  for (const line of lines) {
    if (line === "" && out.length > 0) { out.push(""); continue; }
    const m = /^\s{0,9}(\d+)\t([\s\S]*)$/.exec(line);
    if (!m) return null;
    const n = Number(m[1]);
    // Numbers must actually count up by one. A file of tab-separated numbers would otherwise be
    // mistaken for a listing and lose its first column.
    if (seen === 0) first = n; else if (n !== prev + 1) return null;
    prev = n; seen++;
    out.push(m[2]!);
  }
  return seen === 0 ? null : { text: out.join("\n"), firstLine: first };
}

/** `path:line:text` / `path-line-text` / bare-path result lines, grouped by file — the three shapes
 *  Grep's output modes and Glob produce. Returns null unless the WHOLE result parses: a partial
 *  parse would drop the lines it did not understand, which for a search result is the one thing
 *  that must not happen. */
export function parseMatches(text: string): { groups: MatchGroup[]; note: string | null } | null {
  const lines = text.split("\n").filter((l, i, all) => l !== "" || i < all.length - 1);
  if (lines.length === 0) return null;
  let note: string | null = null;
  const groups: MatchGroup[] = [];
  const byPath = new Map<string, MatchGroup>();
  const push = (path: string, match: Match | null) => {
    let g = byPath.get(path);
    if (!g) { g = { path, matches: [] }; byPath.set(path, g); groups.push(g); }
    if (match) g.matches.push(match);
  };
  for (const [i, line] of lines.entries()) {
    // Grep prefaces content mode with "Found N files" and closes truncated output with a notice;
    // both are ABOUT the result rather than part of it, so they become the view's note.
    if (i === 0 && /^Found \d+ (file|match|line)/.test(line)) { note = line; continue; }
    if (/^(\.\.\.|\(Results are truncated|Showing first )/.test(line)) { note = note ? `${note} · ${line}` : line; continue; }
    if (line === "") continue;
    const withLine = /^(\/[^:]*?|[A-Za-z]:[^:]*?|[^:\s][^:]*?):(\d+):([\s\S]*)$/.exec(line);
    if (withLine) { push(withLine[1]!, { line: Number(withLine[2]), text: withLine[3]! }); continue; }
    // A bare path: absolute, or relative with a separator or an extension. Anything else is prose
    // and disqualifies the whole parse.
    if (/^([/~]|[A-Za-z]:[\\/])\S*$/.test(line) || /^[\w.@-]+(?:[\\/][\w.@ -]+)+$/.test(line)) { push(line, null); continue; }
    return null;
  }
  return groups.length ? { groups, note } : null;
}

/** From this size on, a result stays in ToolCard's raw well and keeps its "Show all (N KB)"
 *  expander (A-M2) rather than being drawn. The drawn views all bound their own HEIGHT, but a
 *  half-megabyte result is thousands of DOM nodes whichever shape they are in, and an agent that
 *  cats a bundle must not be able to wedge the transcript by doing it inside a tool Realm draws. */
export const DRAW_LIMIT = 50 * 1024;

export function toolResultView(name: string, input: Record<string, unknown>, content: string, isError: boolean): ToolResultView | null {
  if (isError || content === "" || content.length >= DRAW_LIMIT) return null;
  // A diff printed into ANY result is a diff — `git diff` and `git show` in a Bash result are how
  // most changes actually reach the transcript, and they deserve the same card an Edit gets.
  if (isUnifiedDiff(content)) {
    const files = parseUnifiedDiff(content);
    if (files.length) return { kind: "diff", files };
  }
  if (COMMAND_TOOLS.has(name)) return { kind: "terminal", ...splitExitCode(content) };
  if (name === "Read") {
    const path = str(input, "file_path") ?? "";
    const numbered = stripLineNumbers(content);
    return numbered
      ? { kind: "code", path, text: numbered.text, firstLine: numbered.firstLine }
      : { kind: "code", path, text: content, firstLine: null };
  }
  if (name === "Grep" || name === "Glob") {
    const matches = parseMatches(content);
    if (matches) return { kind: "matches", ...matches };
  }
  return null;
}

const MEDIA_PATH_TOOLS = new Set(["Read", "Write", "view_image", "read_file"]);

/** A file a tool call names that Realm can actually SHOW. `Read`-ing a screenshot and then seeing
 *  the raw well say `file_path: "/tmp/s1.png"` is the transcript at its least useful: the agent
 *  looked at a picture, and the reader is told its name. Only the input is used — a `Read` result
 *  for an image is a base64 block or a stub, never something worth drawing twice. */
export function toolMediaPath(name: string, input: Record<string, unknown>): string | null {
  if (!MEDIA_PATH_TOOLS.has(name)) return null;
  const path = str(input, "file_path") ?? str(input, "path") ?? str(input, "notebook_path");
  return path && isPlayablePath(path) ? path : null;
}

/** What a tool call is in the middle of MAKING, while it is still running.
 *
 *  This drives the one state aicss.dev's image-generation component has: a canvas of roughly the
 *  right shape, shimmering, captioned with what is being made. It is worth having because encoding
 *  a video is the rare tool call that takes minutes, and a spinner that says `Bash` for four of them
 *  tells the reader nothing about the thing they are waiting for.
 *
 *  Recognition is by the command's PRODUCER, never by guesswork about intent: `ffmpeg` writes video
 *  (an image only when explicitly asked for a single frame), the ImageMagick and macOS converters
 *  write images, and a tool whose own name is about generating pictures generates pictures.
 *  `ffprobe` and friends inspect and are deliberately absent — nothing is being made. */
export type MediaWork = { kind: "image" | "video"; label: string; detail: string | null; aspect: string };

/** Command words that WRITE media. The value is what they write by default. */
const PRODUCERS: Record<string, "image" | "video"> = {
  ffmpeg: "video", avconv: "video", "HandBrakeCLI": "video",
  magick: "image", convert: "image", sips: "image", "rsvg-convert": "image", "qlmanage": "image",
};
/** Tool names that mean an image or a video is being generated — an MCP server's own, whatever it
 *  is called. Matched on the whole name, so an `Edit` or a `Read` can never fall in here. */
const GENERATOR_TOOL = /(?:^|[_.\-:])(?:generate_?(?:image|video)|image_?gen\w*|video_?gen\w*|text_to_(?:image|video)|imagine|dall_?e\d*|flux|sora|veo|midjourney|stable_?diffusion)(?:$|[_.\-:])/i;

/** A `WIDTHxHEIGHT` or `scale=W:H` pair stated in the command, so the placeholder is the shape of
 *  the thing coming rather than a default square. Both sides must be three digits or more — a
 *  timestamp (`14:03`) and a CRF are not dimensions, and a placeholder in the wrong shape is worse
 *  than an honest square. */
export function aspectIn(text: string): string | null {
  const m = /\b(\d{3,5})[x:](\d{3,5})\b/.exec(text);
  if (!m) return null;
  const w = Number(m[1]), h = Number(m[2]);
  // A wildly lopsided pair is a pair of numbers that happened to be adjacent, not a frame size.
  const ratio = w / h;
  return ratio > 0.1 && ratio < 10 ? `${w} / ${h}` : null;
}

/** The first command word of each `;`/`&&`/`|`-separated segment — where a producer's name has to
 *  appear for it to BE the command rather than a word inside an argument. `ls ffmpeg-notes.txt`
 *  must not read as an encode. */
function commandWords(command: string): string[] {
  return command
    .split(/[;|&\n]+|\$\(|`/)
    .map((seg) => /^\s*(?:\w+=\S*\s+)*(?:sudo\s+|env\s+|time\s+|nice\s+)?([\w.\/-]+)/.exec(seg)?.[1] ?? "")
    .map((word) => word.slice(word.lastIndexOf("/") + 1))
    .filter(Boolean);
}

export function mediaWorkFor(name: string, input: Record<string, unknown>): MediaWork | null {
  if (GENERATOR_TOOL.test(name)) {
    const prompt = str(input, "prompt") ?? str(input, "text") ?? str(input, "description");
    const kind = /video|sora|veo/i.test(name) ? "video" : "image";
    return { kind, label: `Generating ${kind}`, detail: prompt, aspect: aspectIn(JSON.stringify(input)) ?? (kind === "video" ? "16 / 9" : "1 / 1") };
  }
  if (!COMMAND_TOOLS.has(name)) return null;
  const command = str(input, "command");
  if (!command) return null;
  const producer = commandWords(command).map((w) => PRODUCERS[w]).find(Boolean);
  if (!producer) return null;
  // `ffmpeg -frames:v 1 out.png` is a frame grab, not an encode — the same binary, a different
  // artefact, and the placeholder should be the shape of what actually lands.
  const kind = producer === "video" && /-frames:v\s+1\b|-vframes\s+1\b/.test(command) ? "image" : producer;
  return {
    kind,
    label: kind === "video" ? "Encoding video" : "Rendering image",
    detail: str(input, "description"),
    aspect: aspectIn(command) ?? (kind === "video" ? "16 / 9" : "1 / 1"),
  };
}
