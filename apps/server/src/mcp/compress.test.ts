import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { COMPRESS_MIN_BYTES, compressText, compressToolResult, minifyJson, tabulate } from "./compress";

/** A pretty-printed payload of `rows` uniform records — the shape this module exists for. */
const people = (rows: number): unknown[] =>
  Array.from({ length: rows }, (_, i) => ({ id: i + 1, name: `person-${i}`, active: i % 2 === 0, team: "platform" }));

const pretty = (v: unknown): string => JSON.stringify(v, null, 2);

describe("minifyJson", () => {
  it("drops whitespace between tokens", () => {
    expect(minifyJson('{\n  "a": 1,\n  "b": [1, 2]\n}')).toBe('{"a":1,"b":[1,2]}');
  });

  it("keeps whitespace INSIDE a string, which is payload rather than formatting", () => {
    expect(minifyJson('{"a": "two  spaces\\n"}')).toBe('{"a":"two  spaces\\n"}');
  });

  it("keeps an integer too large for a double byte-for-byte", () => {
    // The reason this is a lexical strip and not `JSON.stringify(JSON.parse(text))`: re-serialising
    // answers 12345678901234567000, which is a different id than the server sent.
    expect(minifyJson('{"id": 12345678901234567890}')).toBe('{"id":12345678901234567890}');
  });

  it("keeps a number's original spelling", () => {
    expect(minifyJson('{"a": 1.0, "b": 1e3}')).toBe('{"a":1.0,"b":1e3}');
  });

  it("keeps an escape sequence rather than resolving it", () => {
    expect(minifyJson('{"a": "\\u0041"}')).toBe('{"a":"\\u0041"}');
  });

  it("does not mistake an escaped quote for the end of a string", () => {
    expect(minifyJson('{"a": "he said \\" then  stopped"}')).toBe('{"a":"he said \\" then  stopped"}');
  });

  it("does not mistake an escaped backslash for an escape of the quote after it", () => {
    expect(minifyJson('{"a": "back\\\\", "b": 1}')).toBe('{"a":"back\\\\","b":1}');
  });

  it("answers null for anything that is not JSON", () => {
    expect(minifyJson("not json at all")).toBeNull();
    expect(minifyJson('{"a": 1,}')).toBeNull();
  });
});

describe("tabulate", () => {
  it("turns an array of uniform records into a typed, tab-separated table", () => {
    const out = tabulate(people(5))!;
    const lines = out.split("\n");
    expect(lines[0]).toBe("mcp: 5 rows as a tab-separated table; an empty cell is null.");
    expect(lines[1]).toBe("id(number)\tname(string)\tactive(boolean)\tteam(string)");
    expect(lines[2]).toBe("1\tperson-0\ttrue\tplatform");
  });

  it("names the array and reprints the envelope's other fields", () => {
    const out = tabulate({ total: 240, nextCursor: "abc", results: people(5) })!;
    expect(out.split("\n")[0]).toBe(
      'mcp: "results": 5 rows as a tab-separated table; an empty cell is null. Other fields: {"total":240,"nextCursor":"abc"}',
    );
  });

  it("writes null as an empty cell", () => {
    const rows = people(5).map((r, i) => ({ ...(r as object), team: i === 0 ? null : "platform" }));
    expect(tabulate(rows)!.split("\n")[2]).toBe("1\tperson-0\ttrue\t");
  });

  it("refuses below the row floor, where the header costs more than the keys save", () => {
    expect(tabulate(people(4))).toBeNull();
  });

  it("refuses rows whose key sets differ", () => {
    const rows = people(5);
    (rows[3] as Record<string, unknown>).extra = 1;
    expect(tabulate(rows)).toBeNull();
  });

  it("refuses a row with a key the first row did not have, even at the same width", () => {
    const rows = people(5) as Record<string, unknown>[];
    delete rows[3]!.team;
    rows[3]!.squad = "platform";
    expect(tabulate(rows)).toBeNull();
  });

  it("refuses a nested value, which has no cell-sized spelling", () => {
    const rows = people(5) as Record<string, unknown>[];
    rows[2]!.team = { name: "platform" };
    expect(tabulate(rows)).toBeNull();
  });

  it("refuses a column that holds two types, which would make a bare cell ambiguous", () => {
    const rows = people(5) as Record<string, unknown>[];
    rows[2]!.team = true;
    expect(tabulate(rows)).toBeNull();
  });

  it("refuses a string containing the delimiter", () => {
    for (const bad of ["a\tb", "a\nb", "a\rb"]) {
      const rows = people(5) as Record<string, unknown>[];
      rows[1]!.team = bad;
      expect(tabulate(rows), bad).toBeNull();
    }
  });

  it("refuses a column that holds both null and the empty string — an empty cell can only mean one", () => {
    const rows = people(5) as Record<string, unknown>[];
    rows[1]!.team = null;
    rows[2]!.team = "";
    expect(tabulate(rows)).toBeNull();
  });

  it("refuses an all-null column, which has no type to declare", () => {
    const rows = people(5).map((r) => ({ ...(r as object), team: null }));
    expect(tabulate(rows)).toBeNull();
  });

  it("refuses an integer past the safe range, whose digits the parse already changed", () => {
    const rows = people(5) as Record<string, unknown>[];
    rows[1]!.id = 12345678901234567890;
    expect(tabulate(rows)).toBeNull();
  });

  it("accepts a fractional number, which was a double to every reader of this payload already", () => {
    const rows = people(5) as Record<string, unknown>[];
    rows[1]!.id = 1.5;
    expect(tabulate(rows)!.split("\n")[3]).toBe("1.5\tperson-1\tfalse\tplatform");
  });

  it("refuses an envelope with two arrays, where 'the rows' would be a guess", () => {
    expect(tabulate({ results: people(5), errors: [] })).toBeNull();
  });

  it("refuses an envelope whose other fields are not primitives", () => {
    expect(tabulate({ results: people(5), page: { size: 20 } })).toBeNull();
  });
});

describe("compressText", () => {
  it("leaves a payload under the byte floor exactly as it came", () => {
    const small = pretty(people(5));
    expect(small.length).toBeLessThan(COMPRESS_MIN_BYTES);
    expect(compressText(small)).toBeNull();
  });

  it("minifies pretty-printed JSON it cannot tabulate", () => {
    // Nested values rule out a table, so minification is the whole win — and it is a real one.
    const text = pretty({ items: Array.from({ length: 60 }, (_, i) => ({ id: i, meta: { tag: `t${i}` } })) });
    const out = compressText(text)!;
    expect(out.how).toBe("json-minified");
    expect(JSON.parse(out.text)).toEqual(JSON.parse(text));
    expect(out.text.length).toBeLessThan(text.length * 0.75);
  });

  it("prefers the table when it beats minification", () => {
    const text = pretty(people(60));
    const out = compressText(text)!;
    expect(out.how).toBe("tabulated");
    expect(out.text.length).toBeLessThan(minifyJson(text)!.length);
  });

  it("keeps every row and value the table claims to carry", () => {
    const text = pretty(people(60));
    const lines = compressText(text)!.text.split("\n");
    expect(lines.length).toBe(62); // note + header + 60 rows
    expect(lines.at(-1)).toBe("60\tperson-59\tfalse\tplatform");
  });

  it("answers null when the best candidate is not meaningfully smaller", () => {
    // Already compact and already large: there is no whitespace to take and no table to find.
    const text = JSON.stringify({ blob: "x".repeat(COMPRESS_MIN_BYTES) });
    expect(compressText(text)).toBeNull();
  });

  it("answers null for a large payload that is not JSON", () => {
    expect(compressText("log line\n".repeat(500))).toBeNull();
  });
});

describe("compressToolResult", () => {
  const textResult = (text: string, isError = false): CallToolResult => ({ content: [{ type: "text", text }], isError });

  it("compresses a text block in place, leaving the rest of the result alone", () => {
    const text = pretty(people(60));
    const result = compressToolResult(textResult(text));
    expect((result.content[0] as { text: string }).text.length).toBeLessThan(text.length);
    expect(result.isError).toBe(false);
  });

  it("returns the ORIGINAL object when nothing could be done, so a caller can tell by identity", () => {
    const original = textResult("plain prose, nothing to take");
    expect(compressToolResult(original)).toBe(original);
  });

  it("leaves an error result verbatim however large it is", () => {
    const original = textResult(pretty(people(60)), true);
    expect(compressToolResult(original)).toBe(original);
  });

  it("passes non-text content through untouched", () => {
    const image = { type: "image" as const, data: "AAAA".repeat(2000), mimeType: "image/png" };
    const original: CallToolResult = { content: [image], isError: false };
    expect(compressToolResult(original)).toBe(original);
  });

  it("compresses only the blocks it can, leaving the rest in place", () => {
    const original: CallToolResult = {
      content: [{ type: "text", text: "a short note" }, { type: "text", text: pretty(people(60)) }],
      isError: false,
    };
    const result = compressToolResult(original);
    expect((result.content[0] as { text: string }).text).toBe("a short note");
    expect((result.content[1] as { text: string }).text.startsWith("mcp: 60 rows")).toBe(true);
  });
});
