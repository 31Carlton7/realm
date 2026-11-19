/**
 * The tile an arrow key moves to in a grid, the way Finder's do: across a row, and up or down to the
 * tile in the nearest column. Asked of the layout rather than computed from a column count, because
 * the count changes with the pane and a run of files ends mid-row. Null when nothing lies that way —
 * the grid's edge, where the caller decides what the key does next.
 */
export function tileToward(key: string, from: HTMLElement, tiles: readonly HTMLElement[]): HTMLElement | null {
  const dir = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, [number, number]>)[key];
  if (!dir) return null;
  const at = from.getBoundingClientRect();
  const [dx, dy] = dir;
  let best: HTMLElement | null = null;
  let bestCost = Infinity;
  for (const t of tiles) {
    if (t === from) continue;
    const r = t.getBoundingClientRect();
    const ox = r.left - at.left, oy = r.top - at.top;
    // Only tiles that lie in the arrow's direction; a row is one band of tops, a column of lefts.
    if (dx !== 0 && (Math.abs(oy) > at.height / 2 || Math.sign(ox) !== dx)) continue;
    if (dy !== 0 && (Math.abs(oy) < at.height / 2 || Math.sign(oy) !== dy)) continue;
    const cost = dx !== 0 ? Math.abs(ox) : Math.abs(oy) * 4 + Math.abs(ox);
    if (cost < bestCost) { bestCost = cost; best = t; }
  }
  return best;
}
