// @vitest-environment node
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hyperframesService } from "./service";
import { STUDIO_REEL_INPUT_LIMIT } from "../../src/lib/studio-reel-host";
import { videoFrameGridResultSchema } from "../../src/lib/video-frame-grid";

const exec = promisify(execFile);
const token = "test_renderer_token_12345678901234567890";
const handler = hyperframesService({ token, binary: "", gsap: "", font: "" });
const toolsAvailable = [
  "/usr/bin/ffmpeg",
  "/usr/bin/ffprobe",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
].every((path) => existsSync(path));
let directory: string;
let vfr: Uint8Array;
let portrait: Uint8Array;
let audible: Uint8Array;

async function generate(name: string, args: string[]) {
  const path = join(directory, name);
  await exec("ffmpeg", ["-nostdin", "-v", "error", "-y", ...args, path]);
  return new Uint8Array(await readFile(path));
}

function request(video: Uint8Array, options?: unknown, mime = "video/mp4", signal?: AbortSignal) {
  const form = new FormData();
  form.set("video", new File([new Uint8Array(video)], "untrusted name", { type: mime }));
  if (options !== undefined) form.set("options", JSON.stringify(options));
  return new Request("https://renderer.invalid/frames", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
    signal,
  });
}

async function result(video: Uint8Array, options?: unknown, mime?: string) {
  const response = await handler(request(video, options, mime));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/json");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const bytes = await response.text();
  expect(Number(response.headers.get("content-length"))).toBe(Buffer.byteLength(bytes));
  expect(Buffer.byteLength(bytes)).toBeLessThanOrEqual(12 * 1024 * 1024);
  return videoFrameGridResultSchema.parse(JSON.parse(bytes));
}

describe.skipIf(!toolsAvailable)("private frame grids with real FFmpeg media", () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "benny-frames-test-"));
    vfr = await generate("variable.mp4", [
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x96:rate=30000/1001",
      "-vf",
      "select=not(eq(mod(n\\,5)\\,1))",
      "-fps_mode",
      "passthrough",
      "-frames:v",
      "48",
      "-c:v",
      "libx264",
      "-threads",
      "1",
    ]);
    const { stdout: help } = await exec("ffmpeg", ["-hide_banner", "-h", "long"]);
    const variablePath = join(directory, "variable.mp4");
    portrait = await generate(
      "rotated.mp4",
      help.includes("-display_rotation")
        ? ["-display_rotation", "90", "-i", variablePath, "-c", "copy"]
        : ["-i", variablePath, "-c", "copy", "-metadata:s:v:0", "rotate=90"],
    );
    audible = await generate("audible.webm", [
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=96x160:rate=4",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=44100",
      "-t",
      "1",
      "-c:v",
      "libvpx",
      "-threads",
      "1",
      "-c:a",
      "libopus",
    ]);
  }, 20_000);

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("includes every decoded frame at a variable, noninteger rate", async () => {
    const grid = await result(vfr, { mode: "all", includeAudio: true });
    expect(grid.mode).toBe("all");
    expect(grid.decodedFrameCount).toBe(48);
    expect(grid.includedFrameCount).toBe(48);
    expect(grid.frames.map(({ index }: { index: number }) => index)).toEqual(
      Array.from({ length: 48 }, (_, index) => index),
    );
    expect(grid.frames[0].timestampSeconds).toBe(0);
    expect(grid.frames[1].timestampSeconds).toBeCloseTo((2 * 1001) / 30000, 5);
    expect(grid.frames[2].timestampSeconds).toBeCloseTo((3 * 1001) / 30000, 5);
    expect(grid.frames[47].timestampSeconds).toBeCloseTo((59 * 1001) / 30000, 5);
    expect(grid.audio).toBeUndefined();
    const jpeg = Buffer.from(grid.jpegBase64, "base64");
    expect(jpeg.subarray(0, 3)).toEqual(Buffer.from([255, 216, 255]));
    expect(jpeg.byteLength).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(grid.width * grid.height).toBeLessThanOrEqual(40_000_000);
  });

  it("rejects a decoded pixel-format change at constant geometry", async () => {
    const segments = await Promise.all(
      [
        ["red", "yuv420p"],
        ["blue", "yuv444p"],
      ].map(([color, format]) =>
        generate(`${color}.h264`, [
          "-f",
          "lavfi",
          "-i",
          `color=c=${color}:size=160x96:rate=4`,
          "-frames:v",
          "4",
          "-c:v",
          "libx264",
          "-threads",
          "1",
          "-preset",
          "ultrafast",
          "-pix_fmt",
          format,
        ]),
      ),
    );
    const combined = join(directory, "format-change.h264");
    await writeFile(combined, Buffer.concat(segments));
    const changed = await generate("format-change.mp4", [
      "-fflags",
      "+genpts",
      "-r",
      "4",
      "-f",
      "h264",
      "-i",
      combined,
      "-c:v",
      "copy",
    ]);
    const { stdout } = await exec("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "frame=width,height,pix_fmt",
      "-of",
      "compact=p=0:nk=0",
      join(directory, "format-change.mp4"),
    ]);
    expect(stdout.match(/width=160\|height=96\|pix_fmt=yuv420p/g)).toHaveLength(4);
    expect(stdout.match(/width=160\|height=96\|pix_fmt=yuv444p/g)).toHaveLength(4);
    expect((await handler(request(changed, { mode: "all" }))).status).toBe(422);
    expect((await handler(request(changed))).status).toBe(422);
  });

  it("defaults to 24 evenly spaced actual frame indices, including the final frame", async () => {
    const all = await result(vfr, { mode: "all" });
    const grid = await result(vfr);
    expect(grid.mode).toBe("overview");
    expect(grid.decodedFrameCount).toBe(48);
    expect(grid.includedFrameCount).toBe(24);
    expect(grid.frames).toEqual(
      Array.from({ length: 24 }, (_, index) => all.frames[Math.round((index * 47) / 23)]),
    );
  });

  it("validates the encoded JPEG header and scan against the declared grid dimensions", async () => {
    const grid = await result(vfr, { mode: "all" });
    expect(videoFrameGridResultSchema.safeParse({ ...grid, jpegBase64: "/9j/2Q==" }).success).toBe(
      false,
    );
    expect(
      videoFrameGridResultSchema.safeParse({
        ...grid,
        width: grid.width + grid.columns,
        cellWidth: grid.cellWidth + 1,
      }).success,
    ).toBe(false);

    const jpeg = Buffer.from(grid.jpegBase64, "base64");
    const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
    const sos = jpeg.indexOf(Buffer.from([0xff, 0xda]));
    expect(sof).toBeGreaterThan(1);
    expect(sos).toBeGreaterThan(sof);
    const oversize = Buffer.from(jpeg);
    oversize.writeUInt16BE(8193, sof + 7);
    const malformedHeader = Buffer.from(jpeg);
    malformedHeader.writeUInt16BE(0xffff, sof + 2);
    const noScan = Buffer.concat([jpeg.subarray(0, sos), jpeg.subarray(-2)]);
    for (const bytes of [oversize, malformedHeader, noScan]) {
      expect(
        videoFrameGridResultSchema.safeParse({ ...grid, jpegBase64: bytes.toString("base64") })
          .success,
      ).toBe(false);
    }
  });

  it("handles display rotation and puts blank tiles after the final frame", async () => {
    const grid = await result(portrait, { mode: "all" });
    expect(grid.cellHeight).toBeGreaterThan(grid.cellWidth);
    expect(grid.width).toBe(grid.columns * grid.cellWidth);
    expect(grid.height).toBe(grid.rows * grid.cellHeight);
    expect(grid.columns * grid.rows).toBeGreaterThan(grid.includedFrameCount);
    const jpegPath = join(directory, "portrait-grid.jpg");
    await writeFile(jpegPath, Buffer.from(grid.jpegBase64, "base64"));
    const { stdout } = await exec("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=s=x:p=0",
      jpegPath,
    ]);
    expect(stdout.trim()).toBe(`${grid.width}x${grid.height}`);
    const { stdout: pixel } = await exec(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        jpegPath,
        "-vf",
        `crop=2:2:${grid.width - 8}:${grid.height - 8},format=rgb24`,
        "-f",
        "rawvideo",
        "-threads",
        "1",
        "-",
      ],
      { encoding: "buffer" },
    );
    expect(Math.max(...pixel)).toBeLessThan(12);
  });

  it("includes a mono 16 kHz PCM WAV only on request", async () => {
    const silent = await result(audible, { mode: "overview", includeAudio: false }, "video/webm");
    expect(silent.audio).toBeUndefined();
    const spoken = await result(audible, { mode: "overview", includeAudio: true }, "video/webm");
    expect(spoken.frames).toHaveLength(4);
    expect(spoken.audio?.mimeType).toBe("audio/wav");
    const bytes = Buffer.from(spoken.audio!.base64, "base64");
    expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
    expect(bytes.toString("ascii", 8, 12)).toBe("WAVE");
    expect(bytes.readUInt16LE(20)).toBe(1);
    expect(bytes.readUInt16LE(22)).toBe(1);
    expect(bytes.readUInt32LE(24)).toBe(16000);
    expect(bytes.readUInt16LE(34)).toBe(16);
    expect(bytes.length).toBeGreaterThan(30000);
    expect(bytes.length).toBeLessThanOrEqual(3 * 1024 * 1024);
  });

  it("rejects invalid bytes, an unsupported container and unknown options", async () => {
    const invalid = new Uint8Array([1, 2, 3, 4]);
    const mkv = await generate("wrong-container.mkv", [
      "-i",
      join(directory, "audible.webm"),
      "-c",
      "copy",
    ]);
    expect((await handler(request(invalid))).status).toBe(422);
    expect((await handler(request(vfr, { mode: "all", extra: "unsupported" }))).status).toBe(422);
    expect((await handler(request(vfr, null))).status).toBe(422);
    expect((await handler(request(invalid, undefined, "text/plain"))).status).toBe(422);
    expect((await handler(request(mkv, undefined, "video/webm"))).status).toBe(422);
  });

  it("uses the bytes to identify a video regardless of filename or multipart MIME", async () => {
    const grid = await result(vfr, { mode: "overview" }, "application/octet-stream");
    expect(grid.decodedFrameCount).toBe(48);
  });

  it("rejects 91 seconds, 3601 decoded frames, and video beyond the pixel limits", async () => {
    const [long, many, wide, large] = await Promise.all([
      generate("long.mp4", [
        "-f",
        "lavfi",
        "-i",
        "color=size=16x16:rate=1",
        "-t",
        "91",
        "-threads",
        "1",
      ]),
      generate("many.mp4", [
        "-f",
        "lavfi",
        "-i",
        "color=size=16x16:rate=120",
        "-frames:v",
        "3601",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-threads",
        "1",
      ]),
      generate("wide.mp4", [
        "-f",
        "lavfi",
        "-i",
        "color=size=4100x24",
        "-frames:v",
        "1",
        "-threads",
        "1",
      ]),
      generate("large.mp4", [
        "-f",
        "lavfi",
        "-i",
        "color=size=4050x4050",
        "-frames:v",
        "1",
        "-threads",
        "1",
      ]),
    ]);
    for (const video of [long, many, wide, large]) {
      expect((await handler(request(video, { mode: "all" }))).status).toBe(422);
    }
    expect((await handler(request(many))).status).toBe(422);
  }, 20_000);

  it("includes all 3600 frames at the supported limit", async () => {
    const limit = await generate("limit.mp4", [
      "-f",
      "lavfi",
      "-i",
      "color=size=16x16:rate=40",
      "-frames:v",
      "3600",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-threads",
      "1",
    ]);
    const grid = await result(limit, { mode: "all" });
    expect(grid.decodedFrameCount).toBe(3600);
    expect(grid.includedFrameCount).toBe(3600);
    expect(grid.durationSeconds).toBe(90);
    expect(grid.frames.at(-1)).toEqual({ index: 3599, timestampSeconds: 89.975 });
    expect(
      videoFrameGridResultSchema.safeParse({ ...grid, decodedFrameCount: 10 ** 10 }).success,
    ).toBe(false);
  }, 20_000);

  it("gates paths, methods, authorization and uploaded byte counts", async () => {
    expect((await handler(new Request("https://renderer.invalid/frames"))).status).toBe(404);
    expect(
      (await handler(new Request("https://renderer.invalid/other", { method: "POST" }))).status,
    ).toBe(404);
    const unauthorized = request(vfr);
    unauthorized.headers.delete("authorization");
    unauthorized.headers.set("content-length", "99999999");
    expect((await handler(unauthorized)).status).toBe(401);
    const oversized = request(vfr);
    oversized.headers.set("content-length", "99999999");
    expect((await handler(oversized)).status).toBe(413);
    expect((await handler(request(new Uint8Array(STUDIO_REEL_INPUT_LIMIT + 1)))).status).toBe(413);
    const malformed = new Request("https://renderer.invalid/frames", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: "malformed",
    });
    expect((await handler(malformed)).status).toBe(422);
  });

  it("shares the execution slot with /render and releases a cancelled frame upload", async () => {
    const controller = new AbortController();
    const slow = new Request("https://renderer.invalid/frames", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: new ReadableStream({
        pull() {
          /* waits for cancellation */
        },
      }),
      signal: controller.signal,
      duplex: "half",
    } as RequestInit);
    const active = handler(slow);
    expect((await handler(request(vfr))).status).toBe(503);
    expect(
      (
        await handler(
          new Request("https://renderer.invalid/render", {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
            body: "competing",
          }),
        )
      ).status,
    ).toBe(503);
    controller.abort();
    expect((await active).status).toBe(422);
    expect((await handler(request(vfr))).status).toBe(200);
  });
});
