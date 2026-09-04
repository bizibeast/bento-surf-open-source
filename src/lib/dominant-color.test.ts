import { describe, expect, it } from "vitest";
import { dominantColorFromRgba, isUsefulBrandColor, parseCssRgb } from "./dominant-color";

function rgbaFrom(pixels: Array<[number, number, number, number]>) {
  const data = new Uint8Array(pixels.length * 4);
  pixels.forEach(([r, g, b, a], i) => {
    data.set([r, g, b, a], i * 4);
  });
  return data;
}

describe("dominantColorFromRgba", () => {
  it("picks the most common chromatic colour, not a single saturated speck", () => {
    const pixels: Array<[number, number, number, number]> = [];
    for (let i = 0; i < 40; i++) pixels.push([249, 157, 28, 255]);
    for (let i = 0; i < 8; i++) pixels.push([255, 255, 255, 255]);
    pixels.push([255, 0, 0, 255]);
    expect(dominantColorFromRgba(rgbaFrom(pixels))).toBe("#f99d1c");
  });

  it("ignores transparent and near-white padding", () => {
    const pixels: Array<[number, number, number, number]> = [
      [255, 255, 255, 255],
      [0, 0, 0, 0],
      [41, 101, 156, 255],
      [41, 101, 156, 255],
      [41, 102, 157, 255],
    ];
    expect(dominantColorFromRgba(rgbaFrom(pixels))).toBe("#29659c");
  });

  it("falls back to the average opaque ink when the icon is greyscale", () => {
    expect(
      dominantColorFromRgba(
        rgbaFrom([
          [255, 255, 255, 255],
          [40, 40, 40, 255],
          [40, 40, 40, 255],
        ]),
      ),
    ).toBe("#282828");
  });
});

describe("isUsefulBrandColor", () => {
  it("rejects white, black, and grey theme-colors", () => {
    expect(isUsefulBrandColor("#ffffff")).toBe(false);
    expect(isUsefulBrandColor("#000")).toBe(false);
    expect(isUsefulBrandColor("rgb(128, 128, 128)")).toBe(false);
  });

  it("keeps saturated brand colours", () => {
    expect(isUsefulBrandColor("#3478f6")).toBe(true);
    expect(isUsefulBrandColor("#f99d1c")).toBe(true);
    expect(parseCssRgb("#f99d1c")).toEqual({ r: 249, g: 157, b: 28 });
  });
});
