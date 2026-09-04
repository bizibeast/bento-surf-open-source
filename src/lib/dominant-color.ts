/** Pick the most common chromatic colour from RGBA pixels (favicon → bento card). */

export function parseCssRgb(value: string): { r: number; g: number; b: number } | null {
  const color = value.trim();
  const short = /^#([0-9a-f]{3})$/i.exec(color);
  if (short) {
    const [r, g, b] = [...short[1]].map((c) => parseInt(c + c, 16));
    return { r, g, b };
  }
  const long = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(color);
  if (long) {
    const hex = long[1];
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i.exec(color);
  if (!rgb) return null;
  const r = Number(rgb[1]),
    g = Number(rgb[2]),
    b = Number(rgb[3]);
  if ([r, g, b].some((n) => n > 255)) return null;
  return { r, g, b };
}

function chroma(r: number, g: number, b: number) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;
  const lum = (r + g + b) / 3;
  return { sat, lum };
}

/** White/black/grey theme-colors are not a brand tint for a bento card. */
export function isUsefulBrandColor(value: string | null | undefined) {
  if (!value) return false;
  const rgb = parseCssRgb(value);
  if (!rgb) return false;
  const { sat, lum } = chroma(rgb.r, rgb.g, rgb.b);
  return sat >= 0.18 && lum >= 28 && lum <= 240;
}

function rgbHex(r: number, g: number, b: number) {
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Histogram of opaque, saturated pixels. Skips the white/transparent padding
 * most favicons have so a logo's actual ink wins.
 */
export function dominantColorFromRgba(data: ArrayLike<number>): string | null {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  let fallbackN = 0,
    fallbackR = 0,
    fallbackG = 0,
    fallbackB = 0;

  for (let i = 0; i + 3 < data.length; i += 4) {
    const r = data[i],
      g = data[i + 1],
      b = data[i + 2],
      a = data[i + 3];
    if (a < 200) continue;
    const { sat, lum } = chroma(r, g, b);
    if (lum < 245) {
      fallbackN++;
      fallbackR += r;
      fallbackG += g;
      fallbackB += b;
    }
    if (sat < 0.18 || lum < 28 || lum > 240) continue;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bucket.n++;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    buckets.set(key, bucket);
  }

  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const bucket of buckets.values()) {
    if (!best || bucket.n > best.n) best = bucket;
  }
  if (best) {
    return rgbHex(
      Math.round(best.r / best.n),
      Math.round(best.g / best.n),
      Math.round(best.b / best.n),
    );
  }
  if (fallbackN === 0) return null;
  return rgbHex(
    Math.round(fallbackR / fallbackN),
    Math.round(fallbackG / fallbackN),
    Math.round(fallbackB / fallbackN),
  );
}
