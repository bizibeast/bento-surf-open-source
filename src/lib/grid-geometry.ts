import type { LayoutItem } from "react-grid-layout/legacy";

export const GRID_COLS_DESKTOP = 8;
export const GRID_COLS_PHONE = 4;
export const GRID_MARGIN = 12;
export const GRID_PHONE_BREAKPOINT = 640;

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

function clampGridItem(item: LayoutItem, cols: number): LayoutItem {
  const w = Math.min(Math.max(item.w, 1), Math.min(GRID_COLS_PHONE, cols));
  const h = Math.max(item.h, 1);
  const x = Math.min(Math.max(item.x, 0), Math.max(0, cols - w));
  return { ...item, x, w, h };
}

function overlaps(a: LayoutItem, b: LayoutItem): boolean {
  return a.i !== b.i && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function resolveGridOverlaps(
  items: readonly LayoutItem[],
  cols: number,
  pinnedId?: string,
): LayoutItem[] {
  const clamped = items.map((item) => clampGridItem(item, cols));
  const placedItems = clamped.filter(({ y }) => Number.isFinite(y) && y < 9_999);
  let nextRow = nextEmptyGridRow(placedItems);
  const ordered = [...clamped].sort((a, b) => {
    if (a.i === pinnedId) return -1;
    if (b.i === pinnedId) return 1;
    const aRow = Number.isFinite(a.y) && a.y < 9_999 ? a.y : Infinity;
    const bRow = Number.isFinite(b.y) && b.y < 9_999 ? b.y : Infinity;
    return aRow - bRow || a.x - b.x || a.i.localeCompare(b.i);
  });
  const placed: LayoutItem[] = [];
  for (const item of ordered) {
    const unplaced = !Number.isFinite(item.y) || item.y >= 9_999;
    const next = { ...item, y: unplaced ? nextRow : Math.max(0, item.y) };
    let collision = placed.find((other) => overlaps(next, other));
    while (collision) {
      next.y = collision.y + collision.h;
      collision = placed.find((other) => overlaps(next, other));
    }
    placed.push(next);
    nextRow = Math.max(nextRow, next.y + next.h);
  }
  const byId = new Map(placed.map((item) => [item.i, item]));
  return clamped.map((item) => byId.get(item.i) ?? item);
}

// Greedy first-fit packing: place items left-to-right, top-to-bottom with no gaps.
function packLayout(items: Array<{ i: string; w: number; h: number }>, cols: number): LayoutItem[] {
  const occupied = new Set<string>();
  const key = (x: number, y: number) => `${x},${y}`;
  const isFree = (x: number, y: number, w: number, h: number) => {
    for (let dy = 0; dy < h; dy++)
      for (let dx = 0; dx < w; dx++) if (occupied.has(key(x + dx, y + dy))) return false;
    return true;
  };
  const occupy = (x: number, y: number, w: number, h: number) => {
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) occupied.add(key(x + dx, y + dy));
  };
  const placed: LayoutItem[] = [];
  for (const it of items) {
    const w = Math.min(Math.max(it.w, 1), cols);
    const h = Math.max(it.h, 1);
    let done = false;
    for (let y = 0; !done; y++) {
      for (let x = 0; x <= cols - w; x++) {
        if (isFree(x, y, w, h)) {
          placed.push({ i: it.i, x, y, w, h });
          occupy(x, y, w, h);
          done = true;
          break;
        }
      }
    }
  }
  return placed;
}

export function mobileGridLayout(desktopLayout: readonly LayoutItem[]) {
  const ordered = [...desktopLayout].sort(
    (a, b) => a.y - b.y || a.x - b.x || a.i.localeCompare(b.i),
  );
  return packLayout(ordered, GRID_COLS_PHONE);
}
