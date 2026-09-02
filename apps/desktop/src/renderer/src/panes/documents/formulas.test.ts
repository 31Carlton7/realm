import { describe, expect, it } from "vitest";
import { CYCLE_ERROR, coerce, display, evaluateSheet, isFormula } from "./formulas";

const grid = (text: string) => text.trim().split("\n").map((l) => l.split(","));

describe("evaluateSheet", () => {
  it("passes raw cells through and computes formulas", () => {
    const out = evaluateSheet(grid("1,2,=A1+B1"));
    expect(out).toEqual([["1", "2", "3"]]);
  });

  it("evaluates ranges and common functions", () => {
    expect(evaluateSheet(grid("1,2,3,=SUM(A1:C1)"))[0]![3]).toBe("6");
    expect(evaluateSheet(grid("4,9,=AVERAGE(A1:B1)"))[0]![2]).toBe("6.5");
    // Built as arrays, not via grid(): these formulas contain commas, which the helper would split.
    expect(evaluateSheet([["a", "b", "=CONCATENATE(A1,B1)"]])[0]![2]).toBe("ab");
    expect(evaluateSheet([["5", '=IF(A1>3,"big","small")']])[0]![1]).toBe("big");
  });

  it("follows chains of formulas", () => {
    const out = evaluateSheet(grid("2,=A1*2,=B1*2,=C1*2"));
    expect(out[0]).toEqual(["2", "4", "8", "16"]);
  });

  it("references down rows too", () => {
    const out = evaluateSheet([["10"], ["20"], ["=SUM(A1:A2)"]]);
    expect(out[2]![0]).toBe("30");
  });

  it("shows evaluation errors as their spreadsheet names", () => {
    expect(evaluateSheet(grid("=1/0"))[0]![0]).toBe("#DIV/0!");
  });

  it("shows a thrown parse failure as an error, not a crash", () => {
    expect(evaluateSheet(grid("=NOSUCHFN(1)"))[0]![0]).toMatch(/^#/);
    expect(evaluateSheet(grid("=+++"))[0]![0]).toMatch(/^#/);
  });

  /** Every member of a cycle shows #CYCLE!, not just the cell that happened to close the loop —
   *  and evaluation terminates (the memo is the proof; an unmarked member would recurse forever). */
  it("marks every cell in a cycle", () => {
    const out = evaluateSheet(grid("=B1,=A1"));
    expect(out[0]).toEqual([CYCLE_ERROR, CYCLE_ERROR]);
  });

  it("marks a self-reference", () => {
    expect(evaluateSheet(grid("=A1"))[0]![0]).toBe(CYCLE_ERROR);
  });

  it("a cell FEEDING a cycle shows the cycle poisoning its arithmetic, but a clean cell is untouched", () => {
    // C1 depends on the A1/B1 cycle; D1 is independent.
    const out = evaluateSheet(grid("=B1,=A1,=A1+1,=2*3"));
    expect(out[0]![0]).toBe(CYCLE_ERROR);
    expect(out[0]![1]).toBe(CYCLE_ERROR);
    expect(out[0]![2]).toMatch(/^#/); // poisoned — an error, whichever name it surfaces under
    expect(out[0]![3]).toBe("6");     // and the clean one is exactly right
  });

  it("treats blank referenced cells as empty, not as errors", () => {
    expect(evaluateSheet(grid("=SUM(A2:C2)\n,,"))[0]![0]).toBe("0");
  });

  it("does not mutate the input grid", () => {
    const g = grid("1,=A1");
    evaluateSheet(g);
    expect(g[0]![1]).toBe("=A1");
  });
});

describe("coerce", () => {
  it("numbers, booleans, strings, blanks", () => {
    expect(coerce("42")).toBe(42);
    expect(coerce("-3.5")).toBe(-3.5);
    expect(coerce("1e3")).toBe(1000);
    expect(coerce("TRUE")).toBe(true);
    expect(coerce("false")).toBe(false);
    expect(coerce("hello")).toBe("hello");
    expect(coerce("")).toBeNull();
    expect(coerce(undefined)).toBeNull();
    // Number-ish but not a number: must stay text.
    expect(coerce("3.1.4")).toBe("3.1.4");
    expect(coerce("007 Bond")).toBe("007 Bond");
  });
});

describe("display", () => {
  it("rounds float noise but keeps real precision", () => {
    expect(display(0.1 + 0.2)).toBe("0.3");
    expect(display(6.5)).toBe("6.5");
    expect(display(true)).toBe("TRUE");
    expect(display(null)).toBe("");
  });
});

it("isFormula is the single gate", () => {
  expect(isFormula("=SUM(A1)")).toBe(true);
  expect(isFormula(" =x")).toBe(false); // leading space means text, as in every spreadsheet
  expect(isFormula("")).toBe(false);
  expect(isFormula(undefined)).toBe(false);
});
