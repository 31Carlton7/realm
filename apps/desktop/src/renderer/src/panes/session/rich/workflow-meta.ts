/** What a workflow script says about itself: the `meta` it has to begin with.
 *
 *  A `Workflow` call carries a script an agent wrote, and the script opens by naming itself with
 *  `export const meta = { name, description, phases }`. That literal is the only place a workflow's
 *  name exists, so everything that names one reads it here: its row, the running-agents list, the
 *  sub-agent panel, and the view a permission card draws before the launch is allowed.
 *
 *  The text is the agent's, so it is READ and never run. Nothing here evaluates or imports it. The
 *  reader walks it one character at a time, with no pattern that could back up over it, and looks at
 *  a fixed length and no further. It follows the rule of the views beside it in tool-view.ts. What
 *  it does not understand in full it does not report at all, and null means "show the script alone".
 *  Half a `meta` would put a name over a script whose phases it had silently dropped.
 */

/** One phase a script declares. `detail` is absent where the script gave none, never an empty string. */
export type WorkflowPhase = { title: string; detail?: string };

/** `phases` is absent where the script declares none. */
export type WorkflowMeta = { name: string; description: string; phases?: WorkflowPhase[] };

/** How much of a script the reader looks at for the literal, counted in characters from the
 *  script's first. A `meta` that has not closed by here is not read. A name, a sentence and a dozen
 *  phases come to a few hundred. */
export const META_LIMIT = 16 * 1024;

/** How much further the reader looks, counted from the literal's closing brace, to see whether the
 *  declaration ends there (`endsThere`). A bound of its own, apart from `META_LIMIT`. The space and
 *  the comments before the next statement come to a line or two. */
export const TAIL_LIMIT = 4 * 1024;

/** How deep lists and tables may nest inside the literal before the reader gives up on it. A real
 *  `meta` is three deep: the table, its phases, a phase. */
const MAX_DEPTH = 16;

/** A value the literal may hold. A table is a Map, so a key the agent chose, `__proto__` or
 *  `constructor` say, is only ever a key and never lands on an object with a prototype to reach. */
type Literal = string | number | boolean | null | Literal[] | Map<string, Literal>;

/** Where the reader stands. `text` is the script already cut to what the reader may look at, which
 *  is `META_LIMIT` for the literal and `TAIL_LIMIT` for what follows it. So running off its end IS
 *  the limit, and nothing below has to count. */
type Cursor = { readonly text: string; at: number };

/** Whether a character may stand between two tokens: a tab, a line end, or a space separator of any
 *  width. The language allows the wide and narrow spaces of other scripts wherever it allows a
 *  space, the harness reads past them all, and a script that holds one must not read as null. */
const isSpace = (c: number): boolean => c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0xfeff || c === 0x2028 || c === 0x2029
  || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x202f || c === 0x205f || c === 0x3000;
const isLineEnd = (c: number): boolean => c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
const isDigit = (c: number): boolean => c >= 48 && c <= 57;
const isWordStart = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
const isWord = (c: number): boolean => isWordStart(c) || isDigit(c);
const hexDigit = (c: number): number => (isDigit(c) ? c - 48 : c >= 97 && c <= 102 ? c - 87 : c >= 65 && c <= 70 ? c - 55 : -1);

/** Steps over whitespace and comments, of either kind. False when a block comment is still open
 *  where the text ends. */
function skip(c: Cursor): boolean {
  for (;;) {
    const ch = c.text.charCodeAt(c.at);
    if (isSpace(ch)) { c.at++; continue; }
    if (ch !== 47) return true;
    const next = c.text.charCodeAt(c.at + 1);
    if (next === 47) {
      c.at += 2;
      while (c.at < c.text.length && !isLineEnd(c.text.charCodeAt(c.at))) c.at++;
      continue;
    }
    if (next !== 42) return true;
    c.at += 2;
    while (c.at < c.text.length && !(c.text.charCodeAt(c.at) === 42 && c.text.charCodeAt(c.at + 1) === 47)) c.at++;
    if (c.at >= c.text.length) return false;
    c.at += 2;
  }
}

/** The bare word at the cursor, or "" where there is none. A word is a keyword, a key, or one of
 *  `true`, `false` and `null`. */
function word(c: Cursor): string {
  const from = c.at;
  if (!isWordStart(c.text.charCodeAt(c.at))) return "";
  c.at++;
  while (isWord(c.text.charCodeAt(c.at))) c.at++;
  return c.text.slice(from, c.at);
}

/** `count` hexadecimal digits at the cursor, as the character they name. */
function hex(c: Cursor, count: number): string | undefined {
  let code = 0;
  for (let i = 0; i < count; i++) {
    const digit = hexDigit(c.text.charCodeAt(c.at + i));
    if (digit < 0) return undefined;
    code = code * 16 + digit;
  }
  c.at += count;
  return String.fromCharCode(code);
}

/** A braced code point, from its `{`. */
function codePoint(c: Cursor): string | undefined {
  let code = 0, i = c.at + 1;
  for (; c.text.charAt(i) !== "}"; i++) {
    const digit = hexDigit(c.text.charCodeAt(i));
    if (digit < 0) return undefined;
    code = code * 16 + digit;
    if (code > 0x10ffff) return undefined;
  }
  if (i === c.at + 1) return undefined;
  c.at = i + 1;
  return String.fromCodePoint(code);
}

/** One escape, from its backslash, as the text it stands for. A line break after the backslash
 *  continues the string and stands for nothing. Undefined for an escape a module may not write: a
 *  legacy octal, a malformed hexadecimal one, a backslash with nothing after it. */
function escapeAt(c: Cursor): string | undefined {
  const ch = c.text.charAt(c.at + 1), code = c.text.charCodeAt(c.at + 1);
  c.at += 2;
  if (isLineEnd(code)) {
    if (code === 13 && c.text.charCodeAt(c.at) === 10) c.at++;
    return "";
  }
  switch (ch) {
    case "n": return "\n";
    case "t": return "\t";
    case "r": return "\r";
    case "b": return "\b";
    case "f": return "\f";
    case "v": return "\v";
    case "0": return isDigit(c.text.charCodeAt(c.at)) ? undefined : "\0";
    case "x": return hex(c, 2);
    case "u": return c.text.charAt(c.at) === "{" ? codePoint(c) : hex(c, 4);
    case "": return undefined;
    default: return ch >= "1" && ch <= "9" ? undefined : ch;
  }
}

/** A string from its opening quote, which may be single, double or back, with its escapes read.
 *  Undefined where it is not a plain literal: it never closes, a quoted line breaks, an escape is not
 *  one, or a back-quoted string substitutes with `${`, which makes it a computation. */
function quoted(c: Cursor): string | undefined {
  const quote = c.text.charCodeAt(c.at);
  let out = "";
  c.at++;
  while (c.at < c.text.length) {
    const ch = c.text.charCodeAt(c.at);
    if (ch === quote) { c.at++; return out; }
    if (ch === 92) {
      const escaped = escapeAt(c);
      if (escaped === undefined) return undefined;
      out += escaped;
      continue;
    }
    if (quote !== 96 && (ch === 10 || ch === 13)) return undefined;
    if (quote === 96 && ch === 36 && c.text.charCodeAt(c.at + 1) === 123) return undefined;
    if (quote === 96 && ch === 13) {
      out += "\n";
      c.at += c.text.charCodeAt(c.at + 1) === 10 ? 2 : 1;
      continue;
    }
    out += c.text.charAt(c.at);
    c.at++;
  }
  return undefined;
}

/** How many digits stand at the cursor, stepping over them. */
function digits(c: Cursor): number {
  const from = c.at;
  while (isDigit(c.text.charCodeAt(c.at))) c.at++;
  return c.at - from;
}

/** A decimal number, with a minus sign or none. The sign may stand apart from its digits, across
 *  spaces and comments, since the harness reads a minus over a number wherever the language does.
 *  Undefined for a leading plus sign, which the harness refuses, and for anything else that starts
 *  like a number, such as a hexadecimal or separated numeral or a BigInt. A `meta` has no use for
 *  those. */
function numeral(c: Cursor): number | undefined {
  const negative = c.text.charCodeAt(c.at) === 45;
  if (negative) c.at++;
  if (negative && !skip(c)) return undefined;
  const from = c.at;
  let count = digits(c);
  if (c.text.charCodeAt(c.at) === 46) { c.at++; count += digits(c); }
  if (count === 0) return undefined;
  const exponent = c.text.charCodeAt(c.at);
  if (exponent === 101 || exponent === 69) {
    c.at++;
    const power = c.text.charCodeAt(c.at);
    if (power === 45 || power === 43) c.at++;
    if (digits(c) === 0) return undefined;
  }
  if (isWord(c.text.charCodeAt(c.at))) return undefined;
  const size = Number(c.text.slice(from, c.at));
  return negative ? -size : size;
}

/** An object literal from its `{`. Keys are bare or quoted, each holds a literal, and a comma stands
 *  between entries and optionally after the last. A key written twice keeps its last value, as the
 *  language does. */
function table(c: Cursor, depth: number): Map<string, Literal> | undefined {
  const out = new Map<string, Literal>();
  c.at++;
  for (;;) {
    if (!skip(c)) return undefined;
    const ch = c.text.charCodeAt(c.at);
    if (ch === 125) { c.at++; return out; }
    const key = ch === 39 || ch === 34 ? quoted(c) : word(c) || undefined;
    if (key === undefined || !skip(c) || c.text.charCodeAt(c.at) !== 58) return undefined;
    c.at++;
    if (!skip(c)) return undefined;
    const held = value(c, depth);
    if (held === undefined || !skip(c)) return undefined;
    out.set(key, held);
    const after = c.text.charCodeAt(c.at);
    if (after === 44) c.at++;
    else if (after !== 125) return undefined;
  }
}

/** An array literal from its `[`, on the table's terms. A hole between two commas is not a value. */
function list(c: Cursor, depth: number): Literal[] | undefined {
  const out: Literal[] = [];
  c.at++;
  for (;;) {
    if (!skip(c)) return undefined;
    if (c.text.charCodeAt(c.at) === 93) { c.at++; return out; }
    const held = value(c, depth);
    if (held === undefined || !skip(c)) return undefined;
    out.push(held);
    const after = c.text.charCodeAt(c.at);
    if (after === 44) c.at++;
    else if (after !== 93) return undefined;
  }
}

/** The literal at the cursor, or undefined for anything that would have to be RUN to know: a name, a
 *  call, an arithmetic, a spread. That holds under a key the reader has no use for too. Where a
 *  computed value ends cannot be told without understanding it, so the reader cannot step over one. */
function value(c: Cursor, depth: number): Literal | undefined {
  const ch = c.text.charCodeAt(c.at);
  if (ch === 123) return depth < MAX_DEPTH ? table(c, depth + 1) : undefined;
  if (ch === 91) return depth < MAX_DEPTH ? list(c, depth + 1) : undefined;
  if (ch === 39 || ch === 34 || ch === 96) return quoted(c);
  if (isDigit(ch) || ch === 45 || ch === 46) return numeral(c);
  const named = word(c);
  return named === "true" ? true : named === "false" ? false : named === "null" ? null : undefined;
}

/** A field as the text it has to be. Trimmed, and "" for a value that is not a string. */
const textOf = (v: Literal | undefined): string => (typeof v === "string" ? v.trim() : "");

/** `meta.phases` as it is drawn. None where the script declares none, and null where it declares
 *  some the reader cannot give whole, such as a phase with no title or a detail that is not text. */
function phasesOf(declared: Literal | undefined): WorkflowPhase[] | null {
  if (declared === undefined) return [];
  if (!Array.isArray(declared)) return null;
  const out: WorkflowPhase[] = [];
  for (const phase of declared) {
    if (!(phase instanceof Map)) return null;
    const title = textOf(phase.get("title")), detail = phase.get("detail");
    if (title === "" || (detail !== undefined && typeof detail !== "string")) return null;
    out.push(detail !== undefined && detail.trim() !== "" ? { title, detail: detail.trim() } : { title });
  }
  return out;
}

/**
 * Whether the declaration ends where its literal closes, which is at `at` in the script.
 *
 * The literal is the whole of `meta` only when nothing goes on from its closing brace. A member
 * read off it, an operator and a second table, an index, or a call or a template on the next line
 * each make `meta` something other than the table just read, or a script the harness refuses. A
 * name taken from the table would then be one the harness never used. So this accepts the three
 * endings the harness's own reader accepts there: the script ends, or a semicolon follows, or a
 * line break was crossed and a bare word other than `in` and `instanceof` begins the next
 * statement. A line break inside a block comment counts, as it does in the language.
 *
 * That is narrower than the language. A next statement that begins after the line break with a
 * string, a number, a block, a sign or a name outside ASCII ends the declaration too, and reads as
 * null here.
 *
 * The tail is read from the script itself and not from the text cut at `META_LIMIT`. In the cut
 * text a literal that closes on the limit's last character seems to end the script, whatever
 * follows it. The tail has `TAIL_LIMIT` for its own bound, and one whose first token has not ended
 * by then is not read.
 */
function endsThere(script: string, at: number): boolean {
  const c: Cursor = { text: script.slice(at, at + TAIL_LIMIT), at: 0 };
  const whole = at + c.text.length === script.length;
  if (!skip(c)) return false;
  if (c.at >= c.text.length) return whole;
  if (c.text.charCodeAt(c.at) === 59) return true;
  let crossed = false;
  for (let i = 0; i < c.at && !crossed; i++) crossed = isLineEnd(c.text.charCodeAt(i));
  if (!crossed) return false;
  const next = word(c);
  if (c.at >= c.text.length && !whole) return false;
  return next !== "" && next !== "in" && next !== "instanceof";
}

/**
 * The `meta` a workflow script begins with, or null.
 *
 * It reads a script that opens, after whitespace and comments, with `export const meta =` and one
 * balanced object literal that the declaration ends on (`endsThere`). Strings may be single-, double-
 * or back-quoted, with escapes; keys are bare or quoted; trailing commas, comments, nested lists and
 * tables, and keys it has no use for are all fine.
 *
 * Null, which leaves the view as the script alone, when `meta` is not the first thing in the script,
 * when any value in the literal is computed rather than written out, when `name` or `description`
 * is missing or empty, when `phases` is declared and is not a list of titled phases, when the
 * literal has not closed within `META_LIMIT`, or when the declaration goes on past the literal.
 */
export function workflowMeta(script: string): WorkflowMeta | null {
  const c: Cursor = { text: script.length > META_LIMIT ? script.slice(0, META_LIMIT) : script, at: 0 };
  for (const expected of ["export", "const", "meta"]) if (!skip(c) || word(c) !== expected) return null;
  if (!skip(c) || c.text.charCodeAt(c.at) !== 61) return null;
  c.at++;
  if (!skip(c) || c.text.charCodeAt(c.at) !== 123) return null;
  const meta = table(c, 1);
  if (meta === undefined || !endsThere(script, c.at)) return null;
  const name = textOf(meta.get("name")), description = textOf(meta.get("description"));
  const phases = phasesOf(meta.get("phases"));
  if (name === "" || description === "" || phases === null) return null;
  return phases.length > 0 ? { name, description, phases } : { name, description };
}
