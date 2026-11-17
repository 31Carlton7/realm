import { Fragment, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

/** How many rows a long list in Settings shows before its "Show all". */
export const FOLDED_ROWS = 3;

/** The columns a grid is laid out in now. An `auto-fill` template resolves to every track that fits,
 *  filled or not, so this is the row's width in items whatever the list holds. A list that is not a
 *  grid, or a page with no layout (a test), is one column. */
function useColumns(list: RefObject<HTMLElement | null>): number {
  const [columns, setColumns] = useState(1);
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const read = () => {
      const tracks = getComputedStyle(el).gridTemplateColumns;
      setColumns(!tracks || tracks === "none" ? 1 : tracks.split(" ").length);
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [list]);
  return columns;
}

/**
 * A long list of choices in Settings: its first three rows, then "Show all <n>", which opens the rest
 * in place under them and closes again on "Show fewer". The chosen item is always in those first three
 * rows while the list is folded (a choice past them takes the last place there), and the order holds
 * still while it is open, so a pick never moves a tile out from under the pointer.
 *
 * `listClass` is the list's own layout (a grid or a column), drawn twice: the rows shown and the rows
 * folded, so the two line up. With a `label` the list is a fieldset of radios named by it.
 */
export function FoldedList<T>({ items, keyOf, chosen, render, listClass, label }: {
  items: readonly T[]; keyOf: (item: T) => string; chosen: string | null; render: (item: T) => ReactNode;
  listClass: string; label?: string;
}) {
  const shownList = useRef<HTMLDivElement>(null);
  const columns = useColumns(shownList);
  const [open, setOpen] = useState(false);
  const [openedOn, setOpenedOn] = useState(chosen);
  const pinned = open ? openedOn : chosen;
  const shownCount = columns * FOLDED_ROWS;
  const at = items.findIndex((item) => keyOf(item) === pinned);
  const ordered = at < shownCount ? items
    : [...items.slice(0, shownCount - 1), items[at]!, ...items.slice(shownCount - 1, at), ...items.slice(at + 1)];
  const shown = ordered.slice(0, shownCount);
  const folded = ordered.slice(shownCount);
  const drawn = (list: readonly T[]) => list.map((item) => <Fragment key={keyOf(item)}>{render(item)}</Fragment>);
  const Group = label ? "fieldset" : "div";
  return (
    <div className="fold">
      <Group className="fold-group" aria-label={label}>
        <div ref={shownList} className={listClass}>{drawn(shown)}</div>
        {folded.length > 0 && (
          <div className="fold-rest" data-open={open || undefined} inert={!open}>
            <div className="fold-clip"><div className={listClass}>{drawn(folded)}</div></div>
          </div>
        )}
      </Group>
      {folded.length > 0 && (
        <button type="button" className="btn-quiet fold-more" aria-expanded={open}
          onClick={() => { if (!open) setOpenedOn(chosen); setOpen(!open); }}>
          {open ? "Show fewer" : `Show all ${items.length}`}
        </button>
      )}
    </div>
  );
}
