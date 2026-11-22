import { spawn } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  VIDEO_FRAME_AUDIO_LIMIT,
  VIDEO_FRAME_COUNT_LIMIT,
  VIDEO_FRAME_DURATION_LIMIT,
  VIDEO_FRAME_GRID_DIMENSION_LIMIT,
  VIDEO_FRAME_GRID_PIXEL_LIMIT,
  VIDEO_FRAME_JPEG_LIMIT,
  VIDEO_FRAME_RESPONSE_LIMIT,
  VIDEO_FRAME_SOURCE_DIMENSION_LIMIT,
  VIDEO_FRAME_SOURCE_PIXEL_LIMIT,
  videoFrameGridIndices,
  videoFrameGridOptionsSchema,
  videoFrameGridResultSchema,
} from "../../src/lib/video-frame-grid";

const probe = "/usr/bin/ffprobe";
const ffmpeg = "/usr/bin/ffmpeg";
const pixels = String(VIDEO_FRAME_SOURCE_PIXEL_LIMIT);
const timestampFont = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
const processOutputLimit = 512 * 1024;

function mediaProcess(
  directory: string,
  binary: typeof probe | typeof ffmpeg,
  args: string[],
  signal: AbortSignal,
  maxLines = Infinity,
) {
  signal.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: directory,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { LC_ALL: "C" },
    });
    const stop = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already stopped */
        }
      }
    };
    const chunks: Buffer[] = [];
    let bytes = 0;
    let lines = 0;
    let partialLine = false;
    let overflow = false;
    let decodeError = false;
    child.stderr.on("data", () => {
      decodeError = true;
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (overflow) return;
      bytes += chunk.length;
      // FFprobe 5 emits blank lines after decoder side data, including MP4 SEI metadata.
      let offset = 0;
      for (let newline = chunk.indexOf(10); newline !== -1; newline = chunk.indexOf(10, offset)) {
        if (partialLine || newline > offset) lines++;
        partialLine = false;
        offset = newline + 1;
      }
      if (offset < chunk.length) partialLine = true;
      if (bytes > processOutputLimit || lines > maxLines) {
        overflow = true;
        stop();
      } else {
        chunks.push(chunk);
      }
    });
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    child.once("error", (error) => {
      signal.removeEventListener("abort", stop);
      reject(error);
    });
    child.once("close", (code) => {
      signal.removeEventListener("abort", stop);
      if (signal.aborted) reject(signal.reason);
      else if (code !== 0 || overflow || decodeError)
        reject(new Error("Video could not be decoded."));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

/** WebM and Matroska use the same demuxer. Check the EBML header's DocType before decoding. */
function isWebM(bytes: Buffer) {
  if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x1a45dfa3) return false;
  let cursor = 4;
  function integer(keepMarker: boolean) {
    const first = bytes[cursor++];
    if (!first) throw new Error("Invalid EBML header.");
    const size = Math.clz32(first) - 23;
    let value = keepMarker ? first : first & (0xff >> size);
    for (let i = 1; i < size; i++) value = value * 256 + bytes[cursor++];
    if (!Number.isSafeInteger(value)) throw new Error("Invalid EBML header.");
    return value;
  }
  const size = integer(false);
  const end = cursor + size;
  if (end > Math.min(4096, bytes.length)) return false;
  while (cursor < end) {
    const id = integer(true);
    const length = integer(false);
    if (cursor + length > end) return false;
    if (id === 0x4282)
      return length === 4 && bytes.toString("ascii", cursor, cursor + length) === "webm";
    cursor += length;
  }
  return false;
}

function isMp4(bytes: Buffer) {
  const brand = /^(?:iso[0-9m]|mp4[12]|avc1|av01|dash|cmf[cs]|msd[hm]|M4V |MSNV)$/;
  for (let offset = 0; offset + 8 <= Math.min(65536, bytes.length);) {
    const boxSize = bytes.readUInt32BE(offset);
    const end = offset + boxSize;
    if (boxSize < 8 || end > Math.min(65536, bytes.length)) return false;
    const tag = bytes.toString("ascii", offset + 4, offset + 8);
    if (tag === "ftyp") {
      if (boxSize < 16 || boxSize % 4 !== 0) return false;
      if (brand.test(bytes.toString("ascii", offset + 8, offset + 12))) return true;
      for (let i = offset + 16; i < end; i += 4) {
        if (brand.test(bytes.toString("ascii", i, i + 4))) return true;
      }
      return false;
    }
    if (tag !== "free" && tag !== "wide" && tag !== "skip") return false;
    offset = end;
  }
  return false;
}

type ProbedStream = {
  codec_type?: string;
  width?: number;
  height?: number;
  coded_width?: number;
  coded_height?: number;
  time_base?: string;
  duration?: string;
  sample_aspect_ratio?: string;
  side_data_list?: { rotation?: number }[];
};

function validateDimensions(width: number, height: number) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > VIDEO_FRAME_SOURCE_DIMENSION_LIMIT ||
    height > VIDEO_FRAME_SOURCE_DIMENSION_LIMIT ||
    width * height > VIDEO_FRAME_SOURCE_PIXEL_LIMIT
  )
    throw new Error("Video dimensions exceed decoding limits.");
}

function validDuration(duration: number) {
  if (!Number.isFinite(duration) || duration < 0 || duration > VIDEO_FRAME_DURATION_LIMIT)
    throw new Error("Video duration exceeds decoding limits.");
  return duration;
}

function probeRatioParts(value: string | undefined, separator: string) {
  const parts = value?.split(separator) ?? [];
  const [numerator, denominator] = parts.map(Number);
  if (
    parts.length !== 2 ||
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    numerator <= 0 ||
    denominator <= 0
  )
    throw new Error("Invalid video time base or aspect ratio.");
  return [numerator, denominator] as const;
}

function sampleAspectRatio(value: string | undefined | null) {
  if (!value || value === "N/A" || value === "0:1") return 1;
  const [numerator, denominator] = probeRatioParts(value, ":");
  return numerator / denominator;
}

async function probeVideo(directory: string, input: string[], source: string, signal: AbortSignal) {
  const result: { streams?: ProbedStream[]; format?: { duration?: string } } = JSON.parse(
    await mediaProcess(
      directory,
      probe,
      [
        ...input,
        "-show_entries",
        "format=duration:stream=codec_type,width,height,coded_width,coded_height,time_base,duration,sample_aspect_ratio:stream_side_data=rotation",
        "-of",
        "json",
        source,
      ],
      signal,
    ),
  );
  const video = result.streams?.find((stream) => stream.codec_type === "video");
  if (!video?.width || !video.height) throw new Error("No video stream.");
  validateDimensions(video.width, video.height);
  if (video.coded_width && video.coded_height)
    validateDimensions(video.coded_width, video.coded_height);

  let durationSeconds = 0;
  for (const duration of [result.format?.duration, video.duration]) {
    if (duration && duration !== "N/A")
      durationSeconds = Math.max(durationSeconds, validDuration(Number(duration)));
  }

  const [timeNumerator, timeDenominator] = probeRatioParts(video.time_base, "/");
  const seconds = (ticks: number) => validDuration((ticks * timeNumerator) / timeDenominator);
  const sar = sampleAspectRatio(video.sample_aspect_ratio);
  const rotation =
    video.side_data_list?.find((sideData) => sideData.rotation !== undefined)?.rotation ?? 0;
  if (!Number.isInteger(rotation) || rotation % 90 !== 0)
    throw new Error("Unsupported video rotation.");
  const sourceAspect = (video.width * sar) / video.height;
  const aspect = rotation % 180 === 0 ? sourceAspect : 1 / sourceAspect;

  const decoded = await mediaProcess(
    directory,
    probe,
    [
      ...input,
      "-select_streams",
      "v:0",
      "-show_entries",
      "frame=best_effort_timestamp,width,height,pix_fmt,duration,pkt_duration,sample_aspect_ratio",
      "-of",
      "compact=p=0:nk=0",
      source,
    ],
    signal,
    VIDEO_FRAME_COUNT_LIMIT,
  );
  const lines = decoded.split("\n").filter(Boolean);
  if (lines.length === 0 || lines.length > VIDEO_FRAME_COUNT_LIMIT)
    throw new Error("Video frame count exceeds decoding limits.");

  let firstPts = NaN;
  let previousPts = -Infinity;
  let firstPixelFormat: string | null = null;
  const frames = lines.map((line, index) => {
    const fields = new URLSearchParams(line.replaceAll("|", "&"));
    const width = Number(fields.get("width"));
    const height = Number(fields.get("height"));
    validateDimensions(width, height);
    const frameSar = sampleAspectRatio(
      fields.get("sample_aspect_ratio") ?? video.sample_aspect_ratio,
    );
    if (width !== video.width || height !== video.height || frameSar !== sar)
      throw new Error("Video dimensions change during decoding.");
    const pixelFormat = fields.get("pix_fmt");
    if (!pixelFormat || (firstPixelFormat !== null && firstPixelFormat !== pixelFormat))
      throw new Error("Video pixel format changes during decoding.");
    firstPixelFormat ??= pixelFormat;
    const rawPts = fields.get("best_effort_timestamp");
    const pts = Number(rawPts);
    if (!rawPts || !Number.isSafeInteger(pts) || pts < previousPts)
      throw new Error("Invalid video frame timestamp.");
    if (index === 0) firstPts = pts;
    if (!Number.isSafeInteger(pts - firstPts)) throw new Error("Invalid video frame timestamp.");
    previousPts = pts;
    const timestampSeconds = seconds(pts - firstPts);
    const rawDuration = fields.get("duration") ?? fields.get("pkt_duration");
    const frameDuration = rawDuration && rawDuration !== "N/A" ? Number(rawDuration) : 0;
    if (!Number.isSafeInteger(frameDuration) || frameDuration < 0)
      throw new Error("Invalid video frame duration.");
    const frameEnd = seconds(pts - firstPts + frameDuration);
    durationSeconds = Math.max(durationSeconds, frameEnd);
    return { index, timestampSeconds, pts };
  });
  return {
    frames,
    durationSeconds,
    aspect,
    hasAudio: result.streams?.some((stream) => stream.codec_type === "audio") ?? false,
  };
}

function frameGridGeometry(count: number, displayAspect: number, overview: boolean) {
  // Cap extreme cell aspect ratios. Video still fits entirely within each cell.
  const aspect = Math.min(4, Math.max(0.25, displayAspect));
  const columns = Math.min(count, Math.ceil(Math.sqrt(count / aspect)));
  const rows = Math.ceil(count / columns);
  const longestSide = overview ? 480 : 256;
  const heightLimit = Math.min(
    VIDEO_FRAME_GRID_DIMENSION_LIMIT / rows,
    VIDEO_FRAME_GRID_DIMENSION_LIMIT / columns / aspect,
    Math.sqrt(VIDEO_FRAME_GRID_PIXEL_LIMIT / (rows * columns * aspect)),
    longestSide / Math.max(1, aspect),
  );
  const cellWidth = 2 * Math.floor((heightLimit * aspect) / 2);
  const cellHeight = 2 * Math.floor(heightLimit / 2);
  const imageWidth =
    2 * Math.max(1, Math.floor(Math.min(cellWidth, cellHeight * displayAspect) / 2));
  const imageHeight =
    2 * Math.max(1, Math.floor(Math.min(cellHeight, cellWidth / displayAspect) / 2));
  return {
    columns,
    rows,
    cellWidth,
    cellHeight,
    width: columns * cellWidth,
    height: rows * cellHeight,
    imageWidth,
    imageHeight,
  };
}

export async function extractVideoFrameGrid(
  directory: string,
  file: File,
  options: ReturnType<typeof videoFrameGridOptionsSchema.parse>,
  signal: AbortSignal,
) {
  const bytes = Buffer.from(await file.arrayBuffer());
  const webm = isWebM(bytes);
  if (!webm && !isMp4(bytes)) throw new Error("Unsupported video format.");
  const source = webm ? "input.webm" : "input.mp4";
  const input = [
    "-v",
    "error",
    "-protocol_whitelist",
    "file",
    "-format_whitelist",
    webm ? "matroska,webm" : "mov",
    "-threads",
    "1",
    "-max_pixels",
    pixels,
    "-max_alloc",
    "268435456",
    // WebM supplies packet timing. FFmpeg 8's optional Opus parser can emit false errors.
    ...(webm
      ? ["-fflags", "+noparse+nofillin"]
      : ["-enable_drefs", "0", "-use_absolute_path", "0"]),
  ];
  signal.throwIfAborted();
  await writeFile(join(directory, source), bytes, { signal });
  const { frames, durationSeconds, aspect, hasAudio } = await probeVideo(
    directory,
    input,
    source,
    signal,
  );
  const indices = videoFrameGridIndices(frames.length, options.mode);
  const selected = indices.map((index) => frames[index]);
  const overview = options.mode === "overview";
  const { imageWidth, imageHeight, ...geometry } = frameGridGeometry(
    selected.length,
    aspect,
    overview,
  );
  const { cellWidth, cellHeight, columns, rows } = geometry;
  const fontSize = Math.min(19, Math.floor((cellWidth - 6) / 6), Math.floor(cellHeight / 4));
  const filters = [
    ...(overview && selected.length < frames.length
      ? [`select='${indices.map((index) => `eq(n,${index})`).join("+")}'`]
      : []),
    "metadata=mode=add:key=bento.frame:value=1",
    "metadata=mode=print:key=bento.frame:file='pipe\\:1'",
    "setpts=PTS-STARTPTS",
    `scale=${imageWidth}:${imageHeight}`,
    "setsar=1",
    `pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2:black`,
    `drawtext=fontfile=${timestampFont}:text='%{pts}':box=1:boxcolor=black@0.75:fontcolor=white:fontsize=${fontSize}:x=3:y=h-th-3`,
    `tile=${columns}x${rows}:color=black`,
  ];
  const observed = await mediaProcess(
    directory,
    ffmpeg,
    [
      "-nostdin",
      "-xerror",
      "-copyts",
      "-filter_threads",
      "1",
      ...input,
      "-i",
      source,
      "-map",
      "0:v:0",
      "-map_metadata",
      "-1",
      "-vf",
      filters.join(","),
      "-fps_mode",
      "passthrough",
      "-frames:v",
      "1",
      "-c:v",
      "mjpeg",
      "-threads",
      "1",
      "-q:v",
      "7",
      "-y",
      "grid.jpg",
    ],
    signal,
  );
  // An uninterrupted filter graph keeps the counter increasing through the final tile.
  const observedFrames = Array.from(observed.matchAll(/^frame:\s*(\d+)\s+pts:\s*(-?\d+)\s+/gm));
  if (
    observedFrames.length !== selected.length ||
    observedFrames.some(
      ([, counter, pts], index) => Number(counter) !== index || Number(pts) !== selected[index].pts,
    )
  )
    throw new Error("Decoded frames changed while building the grid.");

  let jpegPath = join(directory, "grid.jpg");
  if ((await stat(jpegPath)).size > VIDEO_FRAME_JPEG_LIMIT) {
    await mediaProcess(
      directory,
      ffmpeg,
      [
        "-nostdin",
        "-v",
        "error",
        "-xerror",
        "-protocol_whitelist",
        "file",
        "-threads",
        "1",
        "-max_pixels",
        String(VIDEO_FRAME_GRID_PIXEL_LIMIT),
        "-i",
        "grid.jpg",
        "-frames:v",
        "1",
        "-c:v",
        "mjpeg",
        "-threads",
        "1",
        "-q:v",
        "25",
        "-y",
        "smaller.jpg",
      ],
      signal,
    );
    jpegPath = join(directory, "smaller.jpg");
  }
  if ((await stat(jpegPath)).size > VIDEO_FRAME_JPEG_LIMIT)
    throw new Error("Frame grid exceeds the JPEG limit.");
  const jpegBase64 = (await readFile(jpegPath, { signal })).toString("base64");

  let audio: { mimeType: "audio/wav"; base64: string } | undefined;
  if (options.includeAudio && hasAudio) {
    await mediaProcess(
      directory,
      ffmpeg,
      [
        "-nostdin",
        "-xerror",
        "-filter_threads",
        "1",
        ...input,
        "-i",
        source,
        "-map",
        "0:a:0",
        "-map_metadata",
        "-1",
        "-bitexact",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-t",
        String(VIDEO_FRAME_DURATION_LIMIT),
        "-y",
        "audio.wav",
      ],
      signal,
    );
    const output = join(directory, "audio.wav");
    if ((await stat(output)).size > VIDEO_FRAME_AUDIO_LIMIT)
      throw new Error("Audio exceeds the WAV limit.");
    audio = {
      mimeType: "audio/wav",
      base64: (await readFile(output, { signal })).toString("base64"),
    };
  }

  const result = videoFrameGridResultSchema.parse({
    mode: options.mode,
    decodedFrameCount: frames.length,
    includedFrameCount: selected.length,
    durationSeconds,
    ...geometry,
    frames: selected.map(({ index, timestampSeconds }) => ({ index, timestampSeconds })),
    jpegBase64,
    audio,
  });
  const body = JSON.stringify(result);
  const length = Buffer.byteLength(body);
  if (length > VIDEO_FRAME_RESPONSE_LIMIT)
    throw new Error("Frame grid exceeds the response limit.");
  return new Response(body, {
    headers: {
      "content-type": "application/json",
      "content-length": String(length),
      "cache-control": "no-store",
    },
  });
}
