export type GridRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type GridRowItem = {
  y?: number | null;
  h?: number | null;
};

/**
 * Returns the first completely empty row below every existing tile.
 *
 * New blocks deliberately append here instead of filling an earlier visual
 * gap, which keeps the creator's existing layout stable and predictable.
 */
export function nextEmptyGridRow(items: readonly GridRowItem[]): number {
  return items.reduce((nextRow, item) => {
    const y =
      typeof item.y === "number" && Number.isFinite(item.y) ? Math.max(0, Math.floor(item.y)) : 0;
    const h =
      typeof item.h === "number" && Number.isFinite(item.h) ? Math.max(1, Math.floor(item.h)) : 1;
    return Math.max(nextRow, y + h);
  }, 0);
}

/**
 * Matches react-grid-layout's pixel rounding for a settled grid item.
 * Keeping this shared geometry on the public page prevents half-pixel drift
 * from the editor when the calculated cell size is fractional.
 */
export function roundedGridRect({
  x,
  y,
  w,
  h,
  cellSize,
  gap,
  padding = gap,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  cellSize: number;
  gap: number;
  padding?: number;
}): GridRect {
  const step = cellSize + gap;
  const left = Math.round(step * x + padding);
  const top = Math.round(step * y + padding);
  const nextLeft = Math.round(step * (x + w) + padding);
  const nextTop = Math.round(step * (y + h) + padding);

  return {
    left,
    top,
    width: nextLeft - left - gap,
    height: nextTop - top - gap,
  };
}
