import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { studioHyperframesComposition } from "../../src/lib/studio-hyperframes";
import {
  studioReelRequestSchema,
  STUDIO_REEL_INPUT_LIMIT,
  STUDIO_REEL_OUTPUT_LIMIT,
  STUDIO_REEL_TIMEOUT_MS,
  STUDIO_REEL_IMAGE_TYPES,
  STUDIO_REEL_VIDEO_TYPES,
  STUDIO_REEL_AUDIO_TYPES,
} from "../../src/lib/studio-reel-host";
import {
  VIDEO_FRAME_INPUT_LIMIT,
  videoFrameGridOptionsSchema,
} from "../../src/lib/video-frame-grid";
import { extractVideoFrameGrid } from "./frames";
import { sampleAvatarContentBounds, type AvatarContentBounds } from "./avatar-framing";

const multipartAllowance = 256 * 1024;

const extensions: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/mpeg": ".mp3",
};

function render(directory: string, binary: string, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const process = spawn(
      binary,
      ["render", "--output", "output.mp4", "--workers", "1", "--quality", "standard"],
      {
        cwd: directory,
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
        // No Bento sessions, service token, provider credentials or database access in the renderer.
        env: {
          PATH: globalThis.process.env.PATH,
          HOME: globalThis.process.env.HOME,
          XDG_CONFIG_HOME: globalThis.process.env.XDG_CONFIG_HOME,
          XDG_CACHE_HOME: globalThis.process.env.XDG_CACHE_HOME,
          HYPERFRAMES_CACHE_DIR: globalThis.process.env.HYPERFRAMES_CACHE_DIR,
          HYPERFRAMES_BROWSER_PATH: globalThis.process.env.HYPERFRAMES_BROWSER_PATH,
          HYPERFRAMES_CHROME_SANDBOX: "1",
          DO_NOT_TRACK: "1",
        },
      },
    );
    const abort = () => {
      if (process.pid)
        try {
          globalThis.process.kill(-process.pid, "SIGKILL");
        } catch {
          /* already stopped */
        }
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    process.once("error", (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    process.once("exit", (code) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(signal.reason);
      else if (code === 0) resolve();
      else reject(new Error("HyperFrames could not render this project."));
    });
  });
}

/** Private endpoints for Studio exports and decoded reference frames. */
export function hyperframesService(configuration: {
  token: string;
  binary: string;
  gsap: string;
  font: string;
}) {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(configuration.token))
    throw new Error("Configure a renderer service token.");
  const expected = Buffer.from(`Bearer ${configuration.token}`);
  let busy = false;
  return async (request: Request) => {
    const path = new URL(request.url).pathname;
    if ((path !== "/render" && path !== "/frames") || request.method !== "POST")
      return new Response(null, { status: 404 });
    const authorization = Buffer.from(request.headers.get("authorization") ?? "");
    if (authorization.length !== expected.length || !timingSafeEqual(expected, authorization))
      return new Response(null, { status: 401 });
    if (busy) return new Response(null, { status: 503 });
    const inputLimit =
      (path === "/frames" ? VIDEO_FRAME_INPUT_LIMIT : STUDIO_REEL_INPUT_LIMIT) + multipartAllowance;
    if (Number(request.headers.get("content-length")) > inputLimit)
      return new Response(null, { status: 413 });
    busy = true;
    let directory: string | undefined;
    try {
      // Bound slow/chunked uploads as well as declared lengths before parsing multipart data.
      const reader = request.body?.getReader();
      if (!reader) return new Response(null, { status: 422 });
      const chunks: Uint8Array[] = [];
      let received = 0;
      const abort = () => {
        void reader.cancel().catch(() => undefined);
      };
      const ingestion = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
      ingestion.addEventListener("abort", abort, { once: true });
      try {
        while (true) {
          ingestion.throwIfAborted();
          const next = await reader.read();
          ingestion.throwIfAborted();
          if (next.done) break;
          received += next.value.byteLength;
          if (received > inputLimit) {
            await reader.cancel();
            return new Response(null, { status: 413 });
          }
          chunks.push(next.value);
        }
      } finally {
        ingestion.removeEventListener("abort", abort);
      }
      const form = await new Response(new Blob(chunks as BlobPart[]), {
        headers: { "content-type": request.headers.get("content-type") || "" },
      }).formData();
      if (path === "/frames") {
        const video = form.get("video");
        if (!(video instanceof File) || !video.size) return new Response(null, { status: 422 });
        if (video.size > VIDEO_FRAME_INPUT_LIMIT) return new Response(null, { status: 413 });
        const rawOptions = form.get("options");
        if (rawOptions !== null && (typeof rawOptions !== "string" || rawOptions.length > 256))
          return new Response(null, { status: 422 });
        const options = videoFrameGridOptionsSchema.parse(
          rawOptions === null ? { mode: "overview" } : JSON.parse(rawOptions),
        );
        directory = await mkdtemp(join(tmpdir(), "bento-hyperframes-"));
        return await extractVideoFrameGrid(
          directory,
          video,
          options,
          AbortSignal.any([request.signal, AbortSignal.timeout(90_000)]),
        );
      }
      const document = form.get("document");
      if (typeof document !== "string" || document.length > 65_536)
        return new Response(null, { status: 422 });
      const input = studioReelRequestSchema.parse(JSON.parse(document));
      directory = await mkdtemp(join(tmpdir(), "bento-hyperframes-"));
      await mkdir(join(directory, "assets"));
      const assetExtensions: Record<string, string> = {};
      const avatarBounds: Record<string, AvatarContentBounds> = {};
      const execution = AbortSignal.any([
        request.signal,
        AbortSignal.timeout(STUDIO_REEL_TIMEOUT_MS),
      ]);
      const avatarIds = new Set(
        input.document.scenes.filter((s) => s.kind === "avatar").map((s) => s.mediaId),
      );
      let size = 0;
      for (const asset of input.assets) {
        const file = form.get(asset.id);
        const allowed =
          asset.kind === "image"
            ? STUDIO_REEL_IMAGE_TYPES
            : asset.kind === "audio"
              ? STUDIO_REEL_AUDIO_TYPES
              : STUDIO_REEL_VIDEO_TYPES;
        if (!(file instanceof File) || !allowed.includes(file.type) || assetExtensions[asset.id])
          throw new Error("Unsupported scene asset.");
        size += file.size;
        if (size > STUDIO_REEL_INPUT_LIMIT) return new Response(null, { status: 413 });
        assetExtensions[asset.id] = extensions[file.type];
        await writeFile(
          join(directory, "assets", asset.id + extensions[file.type]),
          new Uint8Array(await file.arrayBuffer()),
        );
        if (avatarIds.has(asset.id)) {
          const bounds = await sampleAvatarContentBounds(
            join(directory, "assets", asset.id + extensions[file.type]),
            execution,
          );
          if (bounds) avatarBounds[asset.id] = bounds;
        }
      }
      await writeFile(
        join(directory, "index.html"),
        studioHyperframesComposition(input, assetExtensions, avatarBounds),
      );
      await copyFile(configuration.gsap, join(directory, "gsap.min.js"));
      await copyFile(configuration.font, join(directory, "Inter.ttf"));
      await render(directory, configuration.binary, execution);
      const output = join(directory, "output.mp4");
      if ((await stat(output)).size > STUDIO_REEL_OUTPUT_LIMIT)
        throw new Error("Export exceeds the current Studio limit.");
      const bytes = await readFile(output);
      if (bytes.toString("ascii", 4, 8) !== "ftyp") throw new Error("Invalid MP4 output.");
      return new Response(bytes, {
        headers: { "content-type": "video/mp4", "content-length": String(bytes.length) },
      });
    } catch {
      return new Response(null, { status: 422 });
    } finally {
      if (directory) await rm(directory, { force: true, recursive: true });
      busy = false;
    }
  };
}

if (import.meta.main) {
  const handler = hyperframesService({
    token: process.env.STUDIO_REEL_RENDERER_TOKEN || "",
    binary: process.env.HYPERFRAMES_BINARY || "/opt/hyperframes/node_modules/.bin/hyperframes",
    gsap: process.env.HYPERFRAMES_GSAP || "/opt/hyperframes/node_modules/gsap/dist/gsap.min.js",
    font: process.env.HYPERFRAMES_FONT || "src/assets/carousel/Inter.ttf",
  });
  Bun.serve({
    hostname: process.env.STUDIO_REEL_RENDERER_HOST || "127.0.0.1",
    port: Number(process.env.PORT || 8789),
    idleTimeout: 255,
    maxRequestBodySize:
      Math.max(STUDIO_REEL_INPUT_LIMIT, VIDEO_FRAME_INPUT_LIMIT) + multipartAllowance,
    fetch(request, server) {
      // The handler enforces its own deadlines. Disable Bun's idle timer for these requests.
      server.timeout(request, 0);
      return handler(request);
    },
  });
}
