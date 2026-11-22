import { z } from "zod";

export const VIDEO_FRAME_INPUT_LIMIT = 24 * 1024 * 1024;
export const VIDEO_FRAME_RESPONSE_LIMIT = 12 * 1024 * 1024;
export const VIDEO_FRAME_JPEG_LIMIT = 4 * 1024 * 1024;
export const VIDEO_FRAME_AUDIO_LIMIT = 3 * 1024 * 1024;
export const VIDEO_FRAME_DURATION_LIMIT = 90;
export const VIDEO_FRAME_COUNT_LIMIT = 3600;
export const VIDEO_FRAME_SOURCE_DIMENSION_LIMIT = 4096;
export const VIDEO_FRAME_SOURCE_PIXEL_LIMIT = 16_000_000;
export const VIDEO_FRAME_GRID_DIMENSION_LIMIT = 8192;
export const VIDEO_FRAME_GRID_PIXEL_LIMIT = 40_000_000;
const OVERVIEW_LIMIT = 24;
const JPEG_HEADER_LIMIT = 64 * 1024;
const base64 = /^[A-Za-z0-9+/]+={0,2}$/;

export const videoFrameGridOptionsSchema = z
  .object({
    mode: z.enum(["overview", "all"]),
    includeAudio: z.boolean().optional(),
  })
  .strict();

export function videoFrameGridIndices(
  decodedCount: number,
  mode: z.infer<typeof videoFrameGridOptionsSchema>["mode"],
) {
  const count = mode === "all" ? decodedCount : Math.min(OVERVIEW_LIMIT, decodedCount);
  return Array.from({ length: count }, (_, index) =>
    count === 1 ? 0 : Math.round((index * (decodedCount - 1)) / (count - 1)),
  );
}

function mediaBase64(maxBytes: number) {
  return z
    .string()
    .min(4)
    .max(4 * Math.ceil(maxBytes / 3))
    .refine(
      (value) =>
        value.length % 4 === 0 && base64ByteLength(value) <= maxBytes && base64.test(value),
      "Invalid media encoding.",
    );
}

function base64ByteLength(value: string) {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

/** Validate the size-bearing header of the JPEG before the first entropy-coded scan. */
function matchesJpegGeometry(value: string, width: number, height: number) {
  if (!value.startsWith("/9j/") || value.length % 4 !== 0) return false;
  const prefix = value.slice(0, 4 * Math.ceil(JPEG_HEADER_LIMIT / 3));
  const suffix = value.slice(-8);
  if (!base64.test(prefix) || !base64.test(suffix) || !atob(suffix).endsWith("\xff\xd9"))
    return false;
  const header = atob(prefix);
  const uint16 = (offset: number) =>
    header.charCodeAt(offset) * 256 + header.charCodeAt(offset + 1);
  let components = 0;
  let quantization = false;
  let huffman = false;
  let offset = 2;

  while (offset + 3 < header.length) {
    if (header.charCodeAt(offset++) !== 0xff) return false;
    while (header.charCodeAt(offset) === 0xff) offset++;
    const marker = header.charCodeAt(offset++);
    const length = uint16(offset);
    const end = offset + length;
    if (!Number.isInteger(length) || length < 2 || end > header.length) return false;

    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      // JPEG frame header: precision, height, width, component count, and component entries.
      const count = header.charCodeAt(offset + 7);
      if (
        components > 0 ||
        count < 1 ||
        count > 4 ||
        length !== 8 + 3 * count ||
        header.charCodeAt(offset + 2) !== 8 ||
        uint16(offset + 3) !== height ||
        uint16(offset + 5) !== width
      )
        return false;
      components = count;
    } else if (marker === 0xda) {
      const scanComponents = header.charCodeAt(offset + 2);
      return (
        quantization &&
        huffman &&
        scanComponents >= 1 &&
        scanComponents <= components &&
        length === 6 + 2 * scanComponents &&
        end < base64ByteLength(value) - 2
      );
    } else if (marker === 0xdb) {
      if (length < 67) return false;
      quantization = true;
    } else if (marker === 0xc4) {
      if (length < 20) return false;
      huffman = true;
    } else if (marker !== 0xfe && marker !== 0xdd && (marker < 0xe0 || marker > 0xef)) {
      return false;
    }
    offset = end;
  }
  return false;
}

function isPcmWave(value: string) {
  if (!/^[A-Za-z0-9+/]{60}/.test(value)) return false;
  const header = atob(value.slice(0, 60));
  const data = new DataView(Uint8Array.from(header, (character) => character.charCodeAt(0)).buffer);
  const byteLength = base64ByteLength(value);
  const dataLength = data.getUint32(40, true);
  return (
    header.startsWith("RIFF") &&
    data.getUint32(4, true) + 8 === byteLength &&
    header.slice(8, 16) === "WAVEfmt " &&
    data.getUint32(16, true) === 16 &&
    data.getUint16(20, true) === 1 &&
    data.getUint16(22, true) === 1 &&
    data.getUint32(24, true) === 16000 &&
    data.getUint32(28, true) === 32000 &&
    data.getUint16(32, true) === 2 &&
    data.getUint16(34, true) === 16 &&
    header.slice(36, 40) === "data" &&
    dataLength + 44 === byteLength &&
    dataLength % 2 === 0 &&
    dataLength <= VIDEO_FRAME_DURATION_LIMIT * 32000
  );
}

const dimension = z.number().int().min(1).max(VIDEO_FRAME_GRID_DIMENSION_LIMIT);
const timestamp = z.number().min(0).max(VIDEO_FRAME_DURATION_LIMIT);

export const videoFrameGridResultSchema = z
  .object({
    mode: videoFrameGridOptionsSchema.shape.mode,
    decodedFrameCount: z.number().int().min(1).max(VIDEO_FRAME_COUNT_LIMIT),
    includedFrameCount: z.number().int().min(1).max(VIDEO_FRAME_COUNT_LIMIT),
    durationSeconds: timestamp,
    width: dimension,
    height: dimension,
    columns: z.number().int().min(1).max(VIDEO_FRAME_COUNT_LIMIT),
    rows: z.number().int().min(1).max(VIDEO_FRAME_COUNT_LIMIT),
    cellWidth: dimension,
    cellHeight: dimension,
    frames: z
      .array(
        z
          .object({
            index: z
              .number()
              .int()
              .min(0)
              .max(VIDEO_FRAME_COUNT_LIMIT - 1),
            timestampSeconds: timestamp,
          })
          .strict(),
      )
      .min(1)
      .max(VIDEO_FRAME_COUNT_LIMIT),
    jpegBase64: mediaBase64(VIDEO_FRAME_JPEG_LIMIT),
    audio: z
      .object({
        mimeType: z.literal("audio/wav"),
        base64: mediaBase64(VIDEO_FRAME_AUDIO_LIMIT).refine(
          isPcmWave,
          "Expected mono 16 kHz PCM WAV.",
        ),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((grid) => matchesJpegGeometry(grid.jpegBase64, grid.width, grid.height), {
    path: ["jpegBase64"],
    message: "JPEG dimensions must match the frame grid.",
  })
  .refine((grid) => {
    if (
      !Number.isInteger(grid.decodedFrameCount) ||
      grid.decodedFrameCount < 1 ||
      grid.decodedFrameCount > VIDEO_FRAME_COUNT_LIMIT
    )
      return false;
    const indices = videoFrameGridIndices(grid.decodedFrameCount, grid.mode);
    return (
      grid.includedFrameCount === indices.length &&
      grid.frames.length === indices.length &&
      grid.frames[0]?.timestampSeconds === 0 &&
      grid.columns <= grid.includedFrameCount &&
      grid.rows === Math.ceil(grid.includedFrameCount / grid.columns) &&
      grid.width === grid.columns * grid.cellWidth &&
      grid.height === grid.rows * grid.cellHeight &&
      grid.width * grid.height <= VIDEO_FRAME_GRID_PIXEL_LIMIT &&
      grid.frames.every(
        (frame, index) =>
          frame.index === indices[index] &&
          frame.timestampSeconds <= grid.durationSeconds &&
          (index === 0 || frame.timestampSeconds >= grid.frames[index - 1].timestampSeconds),
      )
    );
  }, "Frame metadata does not match the grid.");

export type VideoFrameGridResult = z.infer<typeof videoFrameGridResultSchema>;
