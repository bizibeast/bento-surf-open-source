import { execFile } from "node:child_process";
import { promisify } from "node:util";

const width = 90,
  height = 160,
  frameSize = width * height * 3;
export type AvatarContentBounds = { top: number; bottom: number };

/** Only remove matching, stable, uniform bands on BOTH edges, never a bright scene. */
export function detectAvatarContentBounds(frames: Uint8Array[]): AvatarContentBounds | null {
  if (frames.length < 2 || frames.some((f) => f.length !== frameSize)) return null;
  const bounds: { top: number; bottom: number }[] = [];
  for (const pixels of frames) {
    const background = [pixels[0], pixels[1], pixels[2]];
    const uniform = (row: number) => {
      for (let x = 0; x < width; x++)
        for (let c = 0; c < 3; c++)
          if (Math.abs(pixels[(row * width + x) * 3 + c] - background[c]) > 14) return false;
      return true;
    };
    let top = 0,
      bottom = height;
    while (top < height && uniform(top)) top++;
    while (bottom > top && uniform(bottom - 1)) bottom--;
    if (
      top < 12 ||
      height - bottom < 12 ||
      bottom - top < height * 0.24 ||
      bottom - top > height * 0.8
    )
      return null;
    bounds.push({ top, bottom });
  }
  const top = Math.min(...bounds.map((b) => b.top));
  const bottom = Math.max(...bounds.map((b) => b.bottom));
  if (bounds.some((b) => Math.abs(b.top - top) > 2 || Math.abs(b.bottom - bottom) > 2)) return null;
  return { top: top / height, bottom: bottom / height };
}

/** Small offline samples; no network, secrets, model code, or changes to original assets. */
export async function sampleAvatarContentBounds(file: string, signal: AbortSignal) {
  const { stdout } = await promisify(execFile)(
    "ffmpeg",
    [
      "-v",
      "error",
      "-ss",
      "0.1",
      "-i",
      file,
      "-vf",
      "fps=1,scale=90:160:flags=area,format=rgb24",
      "-frames:v",
      "3",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    {
      encoding: "buffer",
      maxBuffer: frameSize * 3 + 1024,
      timeout: 8000,
      signal,
      env: { PATH: process.env.PATH },
    },
  );
  const frames: Uint8Array[] = [];
  for (let at = 0; at + frameSize <= stdout.length; at += frameSize)
    frames.push(stdout.subarray(at, at + frameSize));
  const bounds = detectAvatarContentBounds(frames);
  // Area downscaling mixes the first content row with the padding. Trim one
  // sampled row inward so that a pale band is not magnified by portrait cover.
  return bounds && bounds.bottom - bounds.top >= 0.26
    ? { top: bounds.top + 1 / height, bottom: bounds.bottom - 1 / height }
    : bounds;
}
