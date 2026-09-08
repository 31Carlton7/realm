import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Shrinking a third-party tool result on its way back through the gateway.
 *
 * The gateway is the only place in Realm that sees every MCP tool result before an agent does (see
 * `McpServerConfig`'s comment in `@realm/adapters`: since Plan 9 W3 an agent is handed ONE server,
 * the gateway, and the gateway is the only thing that dials third-party servers). That makes it the
 * one honest place to do this. The alternative — a compressing proxy in front of the model, which is
 * how the off-the-shelf tools do it — buys the same tokens by putting a rewriter in the model's
 * request path, where a regression is invisible from the session view and gets blamed on Realm.
 * Here, nothing between the agent and its provider changes: a tool result is a tool result, and the
 * only question is how many bytes it takes to say the same thing.
 *
 * Two transforms, tried in that order, cheapest-risk first:
 *
 *   1. **Minification** — lexical whitespace removal from valid JSON. Lossless, always safe, and the
 *      common case: an MCP server built on `json.dumps(obj, indent=2)` or `JSON.stringify(o,null,2)`
 *      spends a fifth of its payload on indentation.
 *   2. **Tabulation** — an array of uniform records becomes a tab-separated table, so a key set is
 *      paid for once instead of once per row. This is where the large wins are (a 40-row, 8-column
 *      result is mostly repeated key names) and it is the one that reshapes what the agent reads, so
 *      every guard below exists to make it refuse rather than guess.
 *
 * Applied ONLY to results that came back from a third-party server. Realm's own in-process providers
 * already choose their output shape and clip it (`tool-result.ts`); re-flowing their text would be
 * undoing a decision that was made deliberately one layer down.
 */

/**
 * Results below this are returned untouched.
 *
 * Not a performance floor — a per-cent saving on a 300-byte result is a rounding error against the
 * fixed cost of the tool call around it, and the transforms are not free of risk. Paying any risk for
 * a saving that small is the wrong trade; the payloads this module exists for are two orders of
 * magnitude larger.
 */
export const COMPRESS_MIN_BYTES = 2048;

/**
 * A candidate must be at least this much smaller than the original or the original wins.
 *
 * Every transform here costs something that does not show up in a byte count — minification costs a
 * human reading Activity a readable payload, tabulation costs the agent a shape it did not expect.
 * A 3% win does not cover that; 10% does.
 */
export const COMPRESS_MIN_GAIN = 0.1;

/**
 * Fewer rows than this and tabulation is not worth attempting.
 *
 * A table pays a fixed cost — the note line and the column header — to save one key set per row.
 * Below a handful of rows that trade is roughly break-even, and `COMPRESS_MIN_GAIN` would throw the
 * result away anyway; refusing here just says so earlier and keeps the reason legible.
 */
export const TABLE_MIN_ROWS = 5;

/** What a cell can hold. Anything else makes a row untabulatable — see `tableOf`. */
type Cell = string | number | boolean | null;
type CellType = "string" | "number" | "boolean";

export type CompressedText = { text: string; how: "json-minified" | "tabulated" };

/**
 * Strip insignificant whitespace from valid JSON, or `null` if `text` is not JSON.
 *
 * Lexical rather than `JSON.stringify(JSON.parse(text))` on purpose. Re-serialising is not lossless:
 * it renumbers (`1.0` → `1`, `1e3` → `1000`), it re-escapes (`"A"` → `"A"`), it reorders
 * integer-like keys, and — the one that actually corrupts data — it rounds any integer past 2^53, so
 * a payload of Discord snowflakes or Stripe ids comes back with different digits. Walking the string
 * and dropping whitespace outside string literals cannot do any of that: every byte that survives is
 * a byte the server sent.
 *
 * `JSON.parse` is still called, purely as the validator that earns the right to assume quotes are
 * balanced below.
 */
export function minifyJson(text: string): string | null {
  try {
    JSON.parse(text);
  } catch {
    return null;
  }
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") continue;
    out += ch;
  }
  return out;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A number is only tabulatable if `JSON.parse` gave back the number the source actually said.
 *
 * Non-integers are accepted as they are: a JSON float is a double to every JavaScript consumer of
 * this payload, including the agent, so nothing is lost here that was not already lost at the parse.
 * Integers are different — past `Number.MAX_SAFE_INTEGER` the parse silently changes the digits, and
 * a 19-digit id whose tail is wrong is worse than no compression at all. `Number.isFinite` catches
 * the other end (`1e400` parses to `Infinity`, which has no JSON spelling).
 */
const isFaithfulNumber = (n: number): boolean => Number.isFinite(n) && (!Number.isInteger(n) || Number.isSafeInteger(n));

const isCell = (v: unknown): v is Cell =>
  v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && isFaithfulNumber(v));

/**
 * The array this value's table would be built from, plus whatever else was wrapped around it.
 *
 * Two shapes, because they are the two an MCP server actually returns: a bare array, and the
 * envelope — `{"results": [...], "total": 240, "nextCursor": "…"}` — that anything paginated uses.
 * An envelope only qualifies with EXACTLY one array in it (with two, "the rows" is a guess) and with
 * every other field a primitive, which keeps `rest` small enough to reprint verbatim.
 */
function tabularSource(value: unknown): { label: string | null; rows: unknown[]; rest: Record<string, Cell> } | null {
  if (Array.isArray(value)) return { label: null, rows: value, rest: {} };
  if (!isPlainObject(value)) return null;
  let label: string | null = null;
  let rows: unknown[] | null = null;
  const rest: Record<string, Cell> = {};
  for (const [key, v] of Object.entries(value)) {
    if (Array.isArray(v)) {
      if (rows !== null) return null;
      label = key;
      rows = v;
      continue;
    }
    if (!isCell(v)) return null;
    rest[key] = v;
  }
  return rows === null ? null : { label, rows, rest };
}

/**
 * The columns and cells of a table, or `null` if these rows are not uniformly tabular.
 *
 * Cells are written bare — `Ada`, not `"Ada"` — because the quotes are a third of what tabulation is
 * trying to save. Bare cells are only unambiguous if the reader can tell a string from a number from
 * a boolean without them, so the column header carries the type and every guard here exists to make
 * that header true:
 *
 *   - identical key sets, so the header describes every row;
 *   - primitives only, because a nested object has no cell-sized spelling;
 *   - ONE type per column, so `true` in a `string` column is impossible by construction;
 *   - no tab, newline or carriage return in any string, since those are the delimiters;
 *   - no empty string in a column that also holds nulls, which is the one remaining pair a bare cell
 *     could not tell apart (an empty cell means null, and only null).
 *
 * Every one of these refuses instead of guessing. Refusing costs the caller a fallback to
 * minification, which is always available and always lossless.
 */
function tableOf(rows: unknown[]): { header: string[]; cells: string[][] } | null {
  if (rows.length < TABLE_MIN_ROWS) return null;
  const first = rows[0];
  if (!isPlainObject(first)) return null;
  const columns = Object.keys(first);
  if (columns.length === 0) return null;

  const types = new Map<string, CellType>();
  const hasNull = new Set<string>();
  const hasEmpty = new Set<string>();
  const values: Cell[][] = [];

  for (const row of rows) {
    if (!isPlainObject(row)) return null;
    if (Object.keys(row).length !== columns.length) return null;
    const cells: Cell[] = [];
    for (const column of columns) {
      if (!(column in row)) return null;
      const v = row[column];
      if (!isCell(v)) return null;
      if (v === null) hasNull.add(column);
      else {
        const type = typeof v as CellType;
        const seen = types.get(column);
        if (seen !== undefined && seen !== type) return null;
        types.set(column, type);
        if (typeof v === "string") {
          if (v === "") hasEmpty.add(column);
          if (v.includes("\t") || v.includes("\n") || v.includes("\r")) return null;
        }
      }
      cells.push(v);
    }
    values.push(cells);
  }
  for (const column of columns) {
    // An all-null column has no type to declare, and no information to carry either.
    if (!types.has(column)) return null;
    if (hasNull.has(column) && hasEmpty.has(column)) return null;
  }

  return {
    header: columns.map((c) => `${c}(${types.get(c)})`),
    cells: values.map((row) => row.map((v) => (v === null ? "" : typeof v === "string" ? v : String(v)))),
  };
}

/**
 * Render a value as a tab-separated table, or `null` if it is not one.
 *
 * The note line is the price of the reshape and is deliberately paid in full: the agent is told what
 * it is looking at, how many rows there are, and what an empty cell means, in the same `mcp:` voice
 * the gateway uses for everything else it says on its own behalf.
 */
export function tabulate(value: unknown): string | null {
  const source = tabularSource(value);
  if (source === null) return null;
  const table = tableOf(source.rows);
  if (table === null) return null;

  const what = source.label === null ? `${source.rows.length} rows` : `"${source.label}": ${source.rows.length} rows`;
  const rest = Object.keys(source.rest).length > 0 ? ` Other fields: ${JSON.stringify(source.rest)}` : "";
  const note = `mcp: ${what} as a tab-separated table; an empty cell is null.${rest}`;
  return [note, table.header.join("\t"), ...table.cells.map((r) => r.join("\t"))].join("\n");
}

/**
 * The smallest faithful spelling of `text`, or `null` to leave it exactly as it came.
 *
 * `null` is the answer for everything that is not JSON — prose, logs, HTML, a diff — which is most of
 * what flows through here. That is the intended outcome, not a gap: a transform that cannot prove it
 * preserved the payload has no business running on it, and the byte floor and gain floor both refuse
 * in the same direction.
 */
export function compressText(text: string): CompressedText | null {
  if (text.length < COMPRESS_MIN_BYTES) return null;
  const minified = minifyJson(text);
  if (minified === null) return null;

  let best: CompressedText = { text: minified, how: "json-minified" };
  // `minifyJson` already proved this parses; the tree is only used to look for a table, and every
  // value that reaches a cell has been through `isCell`'s faithfulness check.
  const table = tabulate(JSON.parse(text));
  if (table !== null && table.length < best.text.length) best = { text: table, how: "tabulated" };

  return best.text.length <= text.length * (1 - COMPRESS_MIN_GAIN) ? best : null;
}

/**
 * Compress the text blocks of a tool result.
 *
 * A result nothing could be done to is returned by IDENTITY, so a caller can tell the two apart
 * without comparing payloads. Non-text content (images, resources) is passed through untouched — it
 * is not text, and re-encoding a base64 blob is not this module's business.
 *
 * `isError` results are exempt on principle rather than by size. An error is a message addressed to
 * whoever has to act on it, and the gateway already reprints those verbatim everywhere else it
 * handles them; a failure is the last place to start reflowing what the server said.
 */
export function compressToolResult(result: CallToolResult): CallToolResult {
  if (result.isError === true) return result;
  let changed = false;
  const content = result.content.map((block) => {
    if (block.type !== "text" || typeof block.text !== "string") return block;
    const compressed = compressText(block.text);
    if (compressed === null) return block;
    changed = true;
    return { ...block, text: compressed.text };
  });
  return changed ? { ...result, content } : result;
}
