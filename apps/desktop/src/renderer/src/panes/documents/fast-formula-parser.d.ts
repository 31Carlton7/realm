/** Minimal surface of fast-formula-parser@1.0.19 (no published types). Shapes verified by probing the
 *  real library: 1-based coordinates, FormulaError values carry `_error`, parse failures throw. */
declare module "fast-formula-parser" {
  export type CellRef = { sheet: string; row: number; col: number };
  export type RangeRef = { sheet: string; from: { row: number; col: number }; to: { row: number; col: number } };
  export type CellValue = string | number | boolean | null | { _error: string };
  export default class FormulaParser {
    constructor(config?: {
      onCell?: (ref: CellRef) => CellValue;
      onRange?: (ref: RangeRef) => CellValue[][];
      functions?: Record<string, (...args: unknown[]) => unknown>;
    });
    parse(formula: string, position: CellRef): CellValue;
  }
}
