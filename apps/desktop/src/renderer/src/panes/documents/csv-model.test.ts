import { describe, expect, it } from "vitest";
import { columnCount, columnName, delimiterFor, parseSheet, scanRecords, serializeField, serializeSheet } from "./csv-model";

const rt = (text: string, d: "," | "\t" = ",") => serializeSheet(parseSheet(text, d));

describe("round-trip preservation", () => {
  it("returns an untouched file byte-for-byte", () => {
    for (const csv of [
      "a,b,c\n1,2,3\n",
      'name,note\n"Smith, J","said ""hi"""\n',
      "a,b\n1\n1,2,3\n",                       // ragged
      "x\ty\n1\t2\n",                           // (as comma file: tabs are just text)
      "a,b,c",                                  // no trailing newline
      'q,"multi\nline",z\nnext,row,here\n',     // embedded newline in a quoted field
    ]) expect(rt(csv)).toBe(csv);
  });

  /** The reason rowSources exists: an author who quotes EVERY field keeps that style on every row
   *  the user did not touch, even though canonical serialization would strip the quotes. */
  it("keeps another author's quoting style on unedited rows", () => {
    const csv = '"a","b","c"\n"1","2","3"\n';
    const sheet = parseSheet(csv, ",");
    // What SheetEditor commits for an edited row: the new cells, and that row's source dropped.
    const edited = { ...sheet, rows: [sheet.rows[0]!, ["999", "2", "3"]], rowSources: [sheet.rowSources[0]!, null] };
    const out = serializeSheet(edited);
    expect(out).toBe('"a","b","c"\n999,2,3\n');  // row 0 verbatim; the EDITED row is canonical throughout
  });

  it("preserves CRLF on unedited rows", () => {
    const csv = "a,b\r\nc,d\r\n";
    // scanRecords strips the \r from each record's source and the sheet's `eol` puts it back.
    const sheet = parseSheet(csv, ",");
    expect(serializeSheet(sheet)).toBe(csv);
    expect(sheet.rows[0]).toEqual(["a", "b"]);
  });
});

describe("scanRecords", () => {
  it("respects quoted newlines", () => {
    expect(scanRecords('a,"x\ny",b\nc,d\n').records).toEqual(['a,"x\ny",b', "c,d"]);
  });
  it("handles escaped quotes inside quoted fields", () => {
    expect(scanRecords('"say ""hi""",b\nc,d\n').records).toEqual(['"say ""hi""",b', "c,d"]);
  });
  it("keeps a final unterminated record", () => {
    expect(scanRecords("a,b\nc,d").records).toEqual(["a,b", "c,d"]);
  });
});

describe("serializeSheet", () => {
  it("writes rows added past the edge canonically, blank rows included", () => {
    const sheet = parseSheet("a\n", ",");
    const bigger = { ...sheet, rows: [["a"], [], ["", "", "x"]], rowSources: [sheet.rowSources[0]!, null, null] };
    expect(serializeSheet(bigger)).toBe("a\n\n,,x\n");
  });
});

describe("serializeField", () => {
  it("quotes only when forced", () => {
    expect(serializeField("plain", ",")).toBe("plain");
    expect(serializeField("has,comma", ",")).toBe('"has,comma"');
    expect(serializeField('has"quote', ",")).toBe('"has""quote"');
    expect(serializeField("has\nnewline", ",")).toBe('"has\nnewline"');
    expect(serializeField("has,comma", "\t")).toBe("has,comma"); // not the delimiter in a TSV
  });
});

describe("shape helpers", () => {
  it("delimiter follows the extension, not content sniffing", () => {
    expect(delimiterFor("a.csv")).toBe(",");
    expect(delimiterFor("a.TSV")).toBe("\t");
  });
  it("column names run A..Z, AA..", () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnName))
      .toEqual(["A", "B", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
  });
  it("columnCount is the widest row, minimum one", () => {
    expect(columnCount(parseSheet("a\nb,c,d\n", ","))).toBe(3);
    expect(columnCount(parseSheet("", ","))).toBe(1);
  });
  it("an empty file parses to an empty grid and serializes back to empty", () => {
    expect(rt("")).toBe("");
  });
});

describe("malformed quoting", () => {
  it("still round-trips when scanner and parser happen to agree", () => {
    // A lone opening quote runs to EOF identically on both sides, so preservation holds and the
    // file survives byte-for-byte even though its quoting is broken.
    const bad = 'a,"b\nc,d\n';
    expect(rt(bad)).toBe(bad);
  });

  it("falls back to canonical for the whole file when scanner and parser disagree", () => {
    // Text after a closing quote: papaparse's recovery consumes the newline into one row, while the
    // quote-state scanner sees two records. (Found by probing; a lone opening quote does NOT diverge —
    // both sides read to EOF the same way.)
    const bad = '"a"x,b\nc,d\n';
    const sheet = parseSheet(bad, ",");
    // Whatever the parse produced, no row may claim original bytes it might not own.
    expect(sheet.rowSources.every((s) => s === null)).toBe(true);
  });
});
