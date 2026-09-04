import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { accentColorFromImageBytes } from "./favicon-image";

function u32be(value: number) {
  return Uint8Array.of(
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  );
}

function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  out.set(u32be(data.length), 0);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  return out;
}

function zlib(data: Uint8Array) {
  return new Uint8Array(deflateSync(data));
}

function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const PNG_SIG = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

function encodePng(
  colorType: 3 | 6,
  width: number,
  height: number,
  payload: Uint8Array,
  extra: Uint8Array[] = [],
) {
  const bpp = colorType === 6 ? 4 : 1;
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw.set(payload.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  ihdr.set(u32be(width), 0);
  ihdr.set(u32be(height), 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return concat(
    PNG_SIG,
    chunk("IHDR", ihdr),
    ...extra,
    chunk("IDAT", zlib(raw)),
    chunk("IEND", new Uint8Array()),
  );
}

function wrapIco(png: Uint8Array) {
  const header = new Uint8Array(22);
  header[2] = 1;
  header[4] = 1;
  header[6] = 4;
  header[7] = 4;
  header[14] = png.length & 255;
  header[15] = (png.length >> 8) & 255;
  header[16] = (png.length >> 16) & 255;
  header[17] = (png.length >> 24) & 255;
  header[18] = 22;
  return concat(header, png);
}

describe("accentColorFromImageBytes", () => {
  it("reads an RGBA PNG and returns the majority brand colour", async () => {
    const pixels = new Uint8Array(8 * 8 * 4);
    for (let i = 0; i < 64; i++) {
      const orange = i < 50;
      pixels.set(orange ? [249, 157, 28, 255] : [255, 255, 255, 255], i * 4);
    }
    const png = encodePng(6, 8, 8, pixels);
    expect(await accentColorFromImageBytes(png)).toBe("#f99d1c");
  });

  it("reads an indexed PNG palette (typical favicon)", async () => {
    const plte = Uint8Array.of(255, 255, 255, 41, 101, 156);
    const indexes = Uint8Array.from({ length: 16 }, (_, i) => (i < 12 ? 1 : 0));
    const png = encodePng(3, 4, 4, indexes, [chunk("PLTE", plte)]);
    expect(await accentColorFromImageBytes(png)).toBe("#29659c");
  });

  it("unwraps a PNG stored inside an ICO", async () => {
    const pixels = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i++) pixels.set([41, 101, 156, 255], i * 4);
    const png = encodePng(6, 4, 4, pixels);
    expect(await accentColorFromImageBytes(wrapIco(png))).toBe("#29659c");
  });

  it("reads the most common fill from an SVG favicon", async () => {
    const svg = new TextEncoder().encode(
      `<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#ffffff"/><circle fill="#f99d1c"/><path fill="#f99d1c"/></svg>`,
    );
    expect(await accentColorFromImageBytes(svg)).toBe("#f99d1c");
  });
});
