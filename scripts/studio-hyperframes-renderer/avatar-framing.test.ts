// @vitest-environment node
import { describe, expect, it } from "vitest";
import { detectAvatarContentBounds } from "./avatar-framing";

function frame(top = 55, bottom = 105, padding = 247) {
  const pixels = new Uint8Array(90 * 160 * 3).fill(padding);
  for (let y = top; y < bottom; y++)
    for (let x = 0; x < 90; x++) {
      const at = (y * 90 + x) * 3;
      pixels[at] = (x * 7 + y) % 200;
      pixels[at + 1] = (x * 3 + y * 2) % 180;
      pixels[at + 2] = 75;
    }
  return pixels;
}
describe("avatar content framing", () => {
  it("identifies baked light or dark portrait letterboxing from consistent samples", () => {
    expect(detectAvatarContentBounds([frame(), frame(), frame()])).toEqual({
      top: 55 / 160,
      bottom: 105 / 160,
    });
    expect(detectAvatarContentBounds([frame(40, 120, 0), frame(40, 120, 0)])).toEqual({
      top: 0.25,
      bottom: 0.75,
    });
  });
  it("leaves full-height, flat, changing or one-sided content alone", () => {
    for (const samples of [
      [frame(0, 160), frame(0, 160)],
      [new Uint8Array(90 * 160 * 3).fill(247), new Uint8Array(90 * 160 * 3).fill(247)],
      [frame(), frame(20, 140)],
      [frame(0, 100), frame(0, 100)],
    ])
      expect(detectAvatarContentBounds(samples)).toBeNull();
  });
});
