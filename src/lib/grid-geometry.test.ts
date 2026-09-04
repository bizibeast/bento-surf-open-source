import { describe, expect, it } from "vitest";
import { nextEmptyGridRow, roundedGridRect } from "./grid-geometry";

describe("nextEmptyGridRow", () => {
  it("appends below the lowest tile instead of backfilling an earlier gap", () => {
    expect(
      nextEmptyGridRow([
        { y: 0, h: 2 },
        { y: 0, h: 1 },
        { y: 3, h: 2 },
      ]),
    ).toBe(5);
  });

  it("starts an empty layout at row zero", () => {
    expect(nextEmptyGridRow([])).toBe(0);
  });

  it("uses safe dimensions for incomplete stored layout data", () => {
    expect(
      nextEmptyGridRow([
        { y: null, h: null },
        { y: 2, h: 3 },
      ]),
    ).toBe(5);
  });
});

describe("roundedGridRect", () => {
  it("matches react-grid-layout rounding when cells are fractional", () => {
    const first = roundedGridRect({ x: 0, y: 0, w: 1, h: 1, cellSize: 71.5, gap: 12 });
    const second = roundedGridRect({ x: 1, y: 0, w: 1, h: 1, cellSize: 71.5, gap: 12 });
    const wide = roundedGridRect({ x: 0, y: 2, w: 4, h: 2, cellSize: 71.5, gap: 12 });

    expect(first).toEqual({ left: 12, top: 12, width: 72, height: 72 });
    expect(second).toEqual({ left: 96, top: 12, width: 71, height: 72 });
    expect(wide).toEqual({ left: 12, top: 179, width: 322, height: 155 });
  });
});
