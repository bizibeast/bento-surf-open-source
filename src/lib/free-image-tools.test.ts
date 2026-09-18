import { describe, expect, it } from "vitest";
import { containDestinationRect, coverSourceRect } from "./free-image-tools";

describe("free image geometry", () => {
  it("center-crops landscape images without stretching", () => {
    expect(coverSourceRect(2000, 1000, 1080, 1080)).toEqual({
      x: 500,
      y: 0,
      width: 1000,
      height: 1000,
    });
  });

  it("letterboxes portrait images at their original aspect ratio", () => {
    expect(containDestinationRect(1000, 2000, 1000, 1000)).toEqual({
      x: 250,
      y: 0,
      width: 500,
      height: 1000,
    });
  });
});
