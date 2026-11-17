import decode, { init } from "@jsquash/webp/decode.js";
import wasm from "@jsquash/webp/codec/dec/webp_dec.wasm?module";
import { PNG } from "pngjs";

let decodingReady: Promise<void> | undefined;

export async function studioWebpToPng(source: ArrayBuffer) {
  decodingReady ??= init(wasm);
  await decodingReady;
  const image = await decode(source);
  const scale = Math.min(1, 1400 / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const png = new PNG({ width, height });
  const data = png.data;
  for (let y = 0; y < height; y++) {
    const row = Math.floor((y * image.height) / height) * image.width;
    for (let x = 0; x < width; x++) {
      const pixel = (row + Math.floor((x * image.width) / width)) * 4;
      const offset = (y * width + x) * 4;
      data[offset] = image.data[pixel];
      data[offset + 1] = image.data[pixel + 1];
      data[offset + 2] = image.data[pixel + 2];
      data[offset + 3] = image.data[pixel + 3];
    }
  }
  return PNG.sync.write(png, { deflateLevel: 3 });
}
