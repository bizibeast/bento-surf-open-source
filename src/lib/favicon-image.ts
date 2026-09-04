import { dominantColorFromRgba, isUsefulBrandColor, parseCssRgb } from "./dominant-color";

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10] as const;

function u32(bytes: Uint8Array, offset: number) {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function paeth(a: number, b: number, c: number) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

async function inflateZlib(data: Uint8Array) {
  if (typeof DecompressionStream !== "function") return null;
  try {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    }).pipeThrough(
      new DecompressionStream("deflate") as unknown as TransformStream<Uint8Array, Uint8Array>,
    );
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

function looksLikePng(bytes: Uint8Array) {
  return PNG_SIG.every((b, i) => bytes[i] === b);
}

function pngBytesFromIco(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 22 || bytes[0] !== 0 || bytes[1] !== 0 || bytes[2] !== 1 || bytes[3] !== 0) {
    return null;
  }
  const count = bytes[4] | (bytes[5] << 8);
  let best: { size: number; offset: number } | null = null;
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16;
    if (entry + 16 > bytes.length) return null;
    const size =
      bytes[entry + 8] |
      (bytes[entry + 9] << 8) |
      (bytes[entry + 10] << 16) |
      (bytes[entry + 11] << 24);
    const offset =
      bytes[entry + 12] |
      (bytes[entry + 13] << 8) |
      (bytes[entry + 14] << 16) |
      (bytes[entry + 15] << 24);
    if (!best || size > best.size) best = { size, offset };
  }
  if (!best) return null;
  const slice = bytes.subarray(best.offset, best.offset + best.size);
  return looksLikePng(slice) ? slice : null;
}

async function decodePngRgba(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (!looksLikePng(bytes)) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const idats: Uint8Array[] = [];

  while (offset + 12 <= bytes.length) {
    const length = u32(bytes, offset);
    if (offset + 12 + length > bytes.length) return null;
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      if (data.length < 13) return null;
      width = u32(data, 0);
      height = u32(data, 4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[10] !== 0 || data[11] !== 0 || data[12] !== 0) return null;
      if (width < 1 || height < 1 || width > 512 || height > 512) return null;
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") transparency = data;
    else if (type === "IDAT") idats.push(data);
    else if (type === "IEND") break;
    offset += 12 + length;
  }

  if (!width || bitDepth !== 8 || ![0, 2, 3, 4, 6].includes(colorType)) return null;
  const table = colorType === 3 ? palette : null;
  if (colorType === 3 && !table) return null;

  const concatenated = new Uint8Array(idats.reduce((n, chunk) => n + chunk.length, 0));
  let cursor = 0;
  for (const chunk of idats) {
    concatenated.set(chunk, cursor);
    cursor += chunk.length;
  }
  const raw = await inflateZlib(concatenated);
  if (!raw) return null;

  const bpp = colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 4 ? 2 : 1;
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) return null;

  const recon = new Uint8Array(height * stride);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const row = recon.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? recon.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const encoded = raw[src++];
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = x >= bpp && prev ? prev[x - bpp] : 0;
      let value: number;
      if (filter === 0) value = encoded;
      else if (filter === 1) value = (encoded + a) & 255;
      else if (filter === 2) value = (encoded + b) & 255;
      else if (filter === 3) value = (encoded + ((a + b) >> 1)) & 255;
      else if (filter === 4) value = (encoded + paeth(a, b, c)) & 255;
      else return null;
      row[x] = value;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += 4) {
    if (colorType === 6) {
      rgba[j] = recon[i * 4];
      rgba[j + 1] = recon[i * 4 + 1];
      rgba[j + 2] = recon[i * 4 + 2];
      rgba[j + 3] = recon[i * 4 + 3];
    } else if (colorType === 2) {
      rgba[j] = recon[i * 3];
      rgba[j + 1] = recon[i * 3 + 1];
      rgba[j + 2] = recon[i * 3 + 2];
      rgba[j + 3] = 255;
    } else if (colorType === 3) {
      if (!table) return null;
      const index = recon[i];
      rgba[j] = table[index * 3] ?? 0;
      rgba[j + 1] = table[index * 3 + 1] ?? 0;
      rgba[j + 2] = table[index * 3 + 2] ?? 0;
      rgba[j + 3] = transparency && index < transparency.length ? transparency[index] : 255;
    } else if (colorType === 4) {
      rgba[j] = recon[i * 2];
      rgba[j + 1] = recon[i * 2];
      rgba[j + 2] = recon[i * 2];
      rgba[j + 3] = recon[i * 2 + 1];
    } else {
      rgba[j] = recon[i];
      rgba[j + 1] = recon[i];
      rgba[j + 2] = recon[i];
      rgba[j + 3] = 255;
    }
  }
  return rgba;
}

function ascii(bytes: Uint8Array) {
  return new TextDecoder("utf-8", { fatal: false }).decode(
    bytes.subarray(0, Math.min(bytes.length, 32_000)),
  );
}

function looksLikeSvg(bytes: Uint8Array) {
  const head = ascii(bytes.subarray(0, 256)).trimStart().toLowerCase();
  return head.startsWith("<svg") || head.startsWith("<?xml") || head.includes("<svg");
}

function accentFromSvg(text: string): string | null {
  const counts = new Map<string, number>();
  const patterns = [
    /(?:fill|stroke|stop-color)\s*[:=]\s*["']([^"']+)["']/gi,
    /(?:fill|stroke|stop-color)\s*[:=]\s*(#[0-9a-f]{3,8})/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const rgb = parseCssRgb(match[1]);
      if (!rgb) continue;
      const hex = `#${[rgb.r, rgb.g, rgb.b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
      if (!isUsefulBrandColor(hex)) continue;
      counts.set(hex, (counts.get(hex) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [color, n] of counts) {
    if (n > bestN) {
      best = color;
      bestN = n;
    }
  }
  return best;
}

export async function accentColorFromImageBytes(bytes: Uint8Array): Promise<string | null> {
  if (bytes.length < 8) return null;
  const png = looksLikePng(bytes) ? bytes : pngBytesFromIco(bytes);
  if (png) {
    const rgba = await decodePngRgba(png);
    return rgba ? dominantColorFromRgba(rgba) : null;
  }
  if (looksLikeSvg(bytes)) return accentFromSvg(ascii(bytes));
  return null;
}
