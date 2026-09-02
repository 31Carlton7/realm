import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DataSheetGrid, type Column, type CellProps } from "react-datasheet-grid";
import type { Operation } from "react-datasheet-grid/dist/types";
import "react-datasheet-grid/dist/style.css";
import { columnCount, columnName, delimiterFor, parseSheet, serializeSheet, type Sheet } from "./csv-model";
import { evaluateSheet, isFormula } from "./formulas";

/**
 * The spreadsheet editor (Plan 17 W3): a DOM grid over the CSV model, formulas computed at display
 * time only. The FILE stays the document — formulas live in it as text, computed values never do.
 *
 * Cells show their computed value at rest and their raw text (the formula) while editing, which is
 * every spreadsheet's contract. Copy takes the raw text, so a copied formula pastes as a formula.
 *
 * Amendment to the plan recorded in the plan doc: the grid is `react-datasheet-grid`, not Glide —
 * Glide's peer set stops at React 18 (repo is on 19) and demands lodash + marked@4 (conflicting with
 * the repo's marked@18) + a carousel. Under the 2 MiB document ceiling the DOM grid's virtualization
 * is ample, and being DOM keeps it drivable by jsdom tests and the live check alike.
 */
export function SheetEditor({ path, text, onChange }: {
  path: string; text: string; onChange: (text: string) => void;
}) {
  const delimiter = delimiterFor(path);
  /** The last text this editor emitted — its own value coming back down must not re-parse (same
   *  echo-guard as RichTextEditor; re-parsing would discard every preserved row source). */
  const lastEmitted = useRef<string | null>(null);
  const [sheet, setSheet] = useState<Sheet>(() => parseSheet(text, delimiter));
  const lastText = useRef(text);
  if (text !== lastText.current) {
    lastText.current = text;
    if (text !== lastEmitted.current) setSheet(parseSheet(text, delimiter)); // external change (agent edit, take-theirs)
  }

  const computed = useMemo(() => evaluateSheet(sheet.rows), [sheet.rows]);
  /** Columns the user added beyond the widest row; they exist only in the view until typed into. */
  const [extraCols, setExtraCols] = useState(0);
  const cols = Math.max(columnCount(sheet), 1) + extraCols;
  const [active, setActive] = useState<{ row: number; col: number } | null>(null);

  const commit = useCallback((next: Sheet) => {
    setSheet(next);
    const out = serializeSheet(next);
    lastEmitted.current = out;
    lastText.current = out;
    onChange(out);
  }, [onChange]);

  const onGridChange = useCallback((value: string[][], operations: Operation[]) => {
    // Row sources follow the operations: an UPDATEd row keeps its source only if its cells are
    // actually identical (the grid reports whole ranges); CREATE inserts sourceless rows; DELETE
    // drops sources with their rows. This bookkeeping is the whole round-trip story — W2's WeakMap
    // trick, done positionally because rows are plain arrays.
    const rows = value.map((r) => [...r]);
    const rowSources = [...sheet.rowSources];
    for (const op of operations) {
      if (op.type === "UPDATE") {
        for (let i = op.fromRowIndex; i < op.toRowIndex; i++) {
          const oldRow = sheet.rows[i], newRow = rows[i];
          const same = !!oldRow && !!newRow && oldRow.length === newRow.length && oldRow.every((c, j) => c === newRow[j]);
          if (!same) rowSources[i] = null;
        }
      } else if (op.type === "CREATE") {
        rowSources.splice(op.fromRowIndex, 0, ...Array<null>(op.toRowIndex - op.fromRowIndex).fill(null));
      } else if (op.type === "DELETE") {
        rowSources.splice(op.fromRowIndex, op.toRowIndex - op.fromRowIndex);
      }
    }
    commit({ ...sheet, rows, rowSources: rowSources.slice(0, rows.length) });
  }, [sheet, commit]);

  const columns = useMemo<Partial<Column<string[], { ci: number }, string>>[]>(() =>
    Array.from({ length: cols }, (_v, ci) => ({
      id: String(ci),
      title: columnName(ci),
      component: CellView,
      columnData: { ci },
      basis: 96, grow: 1, shrink: 0, minWidth: 56,
      copyValue: ({ rowData }) => rowData[ci] ?? "",
      pasteValue: ({ rowData, value }) => {
        const next = [...rowData];
        while (next.length <= ci) next.push("");
        next[ci] = value;
        return next;
      },
      deleteValue: ({ rowData }) => {
        const next = [...rowData];
        if (ci < next.length) next[ci] = "";
        return next;
      },
      isCellEmpty: ({ rowData }) => !(rowData[ci] ?? "").length,
    })), [cols]);

  // The computed grid rides in via context-ish prop drilling: react-datasheet-grid recreates cell
  // components only when `columns` changes, so computed values are read through a ref the cells close
  // over — the grid re-renders cells on value/active changes and the ref is always current.
  computedRef.current = computed;

  // The grid sizes itself from a `height` PROP, not from CSS — left alone it renders a strip as
  // tall as its default and scrolls internally, hiding rows in a pane with hundreds of free pixels
  // (caught by the live check's screenshot). Measured from the wrapper the flex layout already sizes.
  const gridWrap = useRef<HTMLDivElement>(null);
  const [gridHeight, setGridHeight] = useState(400);
  useEffect(() => {
    const el = gridWrap.current; if (!el) return;
    const ro = new ResizeObserver(() => setGridHeight(Math.max(120, el.clientHeight)));
    ro.observe(el);
    setGridHeight(Math.max(120, el.clientHeight));
    return () => ro.disconnect();
  }, []);

  const activeRaw = active ? sheet.rows[active.row]?.[active.col] ?? "" : "";
  return (
    <div className="sheet-editor">
      <div className="sheet-formula-bar">
        <span className="sheet-cellref">{active ? `${columnName(active.col)}${active.row + 1}` : ""}</span>
        <span className="sheet-rawvalue" title={activeRaw}>{activeRaw}</span>
        <button className="sheet-addcol" title="Add column" onClick={() => setExtraCols((n) => n + 1)}>+ column</button>
      </div>
      <div className="sheet-grid" ref={gridWrap}>
        <DataSheetGrid<string[]>
          value={sheet.rows.length ? sheet.rows : [[""]]}
          onChange={onGridChange}
          columns={columns}
          createRow={() => []}
          height={gridHeight}
          onActiveCellChange={({ cell }) => setActive(cell ? { row: cell.row, col: typeof cell.col === "number" ? cell.col : Number(cell.col) } : null)}
        />
      </div>
    </div>
  );
}

/** Read by CellView on every render; set by SheetEditor before returning. A ref rather than context
 *  because the grid memoizes aggressively and the cells re-render exactly when the value changes. */
const computedRef = { current: [] as string[][] };

function CellView({ rowData, rowIndex, columnData, focus, setRowData }: CellProps<string[], { ci: number }>) {
  const { ci } = columnData;
  const raw = rowData[ci] ?? "";
  const shown = isFormula(raw) ? computedRef.current[rowIndex]?.[ci] ?? "…" : raw;
  if (!focus) {
    return (
      <span className="sheet-cell" data-formula={isFormula(raw) || undefined}
        data-error={shown.startsWith("#") && isFormula(raw) ? true : undefined}>{shown}</span>
    );
  }
  // Controlled, committing on EVERY keystroke — the grid library's own textColumn pattern. Two
  // earlier versions of this input were wrong in ways only the live check caught:
  //  - commit-on-blur lost edits: the grid exits edit mode on an outside click by UNMOUNTING the
  //    input, and React fires no blur on unmount, so the typed text vanished;
  //  - an Enter handler calling stopEditing double-advanced: the grid's own document-level keydown
  //    listener ALSO processes Enter while editing, so the active cell stepped twice — off the end
  //    of the data — and the grid scrolled a phantom selection into view, hiding row 1.
  // The grid owns Enter/Escape/Tab during editing; this input only owns its text.
  return (
    <input
      className="sheet-cell-input"
      autoFocus
      value={raw}
      onChange={(e) => {
        const next = [...rowData];
        while (next.length <= ci) next.push("");
        next[ci] = e.target.value;
        setRowData(next);
      }}
    />
  );
}
