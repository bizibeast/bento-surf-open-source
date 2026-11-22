import { chromium, type LaunchOptions, type Route } from "@playwright/test";
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  STUDIO_REEL_IMAGE_TYPES,
  STUDIO_REEL_INPUT_LIMIT,
  STUDIO_REEL_OUTPUT_LIMIT,
  STUDIO_REEL_TIMEOUT_MS,
  STUDIO_REEL_VIDEO_TYPES,
  studioReelRequestSchema,
  type StudioReelRequest,
} from "../../src/lib/studio-reel-host";

const origin = "https://studio-render.invalid";
const renderPath = "/render";

function fulfillAsset(route: Route, asset: { bytes: Buffer; mime: string }) {
  const { bytes, mime } = asset;
  const headers = { "accept-ranges": "bytes", "content-type": mime };
  const range = route.request().headers().range;
  if (route.request().method() === "HEAD") {
    return route.fulfill({
      status: 200,
      headers: { ...headers, "content-length": String(bytes.length) },
    });
  }
  if (!range) return route.fulfill({ status: 200, headers, body: bytes });
  const bounds = /^bytes=(\d+)-(\d*)$/.exec(range);
  const start = Number(bounds?.[1]);
  const end = Math.min(bytes.length - 1, bounds?.[2] ? Number(bounds[2]) : bytes.length - 1);
  if (!bounds || !Number.isSafeInteger(start) || start > end) {
    return route.fulfill({ status: 416, headers: { "content-range": `bytes */${bytes.length}` } });
  }
  return route.fulfill({
    status: 206,
    headers: {
      ...headers,
      "content-range": `bytes ${start}-${end}/${bytes.length}`,
      "content-length": String(end - start + 1),
    },
    body: bytes.subarray(start, end + 1),
  });
}

export async function renderHostedReel(
  input: StudioReelRequest,
  assets: Map<string, { bytes: Buffer; mime: string }>,
  script: Buffer,
  signal: AbortSignal,
  options: LaunchOptions,
) {
  signal.throwIfAborted();
  const browser = await chromium.launch({ chromiumSandbox: true, ...options, timeout: 15_000 });
  const abort = () => void browser.close().catch(() => undefined);
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    await context.route("**/*", (route) => {
      const target = new URL(route.request().url());
      if (target.origin !== origin || !["GET", "HEAD"].includes(route.request().method())) {
        return route.abort();
      }
      if (target.pathname === "/")
        return route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><meta charset="utf-8"><script src="/reel.js"></script>',
        });
      if (target.pathname === "/reel.js")
        return route.fulfill({ contentType: "text/javascript", body: script });
      const asset = target.pathname.startsWith("/media/") && assets.get(target.pathname.slice(7));
      return asset ? fulfillAsset(route, asset) : route.fulfill({ status: 404 });
    });
    await page.goto(origin, { timeout: 15_000 });
    const output = await page.evaluate((value) => {
      const entry = globalThis as typeof globalThis & {
        BentoStudioReel: { render(input: StudioReelRequest): Promise<string> };
      };
      return entry.BentoStudioReel.render(value);
    }, input);
    const bytes = Buffer.from(output, "base64");
    if (bytes.length === 0 || bytes.length > STUDIO_REEL_OUTPUT_LIMIT)
      throw new Error("Unexpected Reel size.");
    return bytes;
  } finally {
    signal.removeEventListener("abort", abort);
    await browser.close().catch(() => undefined);
  }
}

export function studioReelService(token: string, script: Buffer, options: LaunchOptions = {}) {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token))
    throw new Error("Configure a renderer service token.");
  const authorization = Buffer.from(`Bearer ${token}`);
  let rendering = false;
  return async (request: Request) => {
    if (new URL(request.url).pathname !== renderPath || request.method !== "POST")
      return new Response(null, { status: 404 });
    const provided = Buffer.from(request.headers.get("authorization") || "");
    if (authorization.length !== provided.length || !timingSafeEqual(authorization, provided))
      return new Response(null, { status: 401 });
    if (rendering) return new Response(null, { status: 503 });
    const declared = Number(request.headers.get("content-length"));
    if (declared > STUDIO_REEL_INPUT_LIMIT + 256 * 1024) return new Response(null, { status: 413 });
    rendering = true;
    try {
      const form = await request.formData();
      const details = form.get("document");
      if (typeof details !== "string" || details.length > 65_536)
        throw new Error("Invalid Studio project.");
      const input = studioReelRequestSchema.parse(JSON.parse(details));
      const assets = new Map<string, { bytes: Buffer; mime: string }>();
      let total = 0;
      for (const { id, kind } of input.assets) {
        const value = form.get(id);
        const mime = kind === "image" ? STUDIO_REEL_IMAGE_TYPES : STUDIO_REEL_VIDEO_TYPES;
        if (!(value instanceof File) || assets.has(id) || !mime.includes(value.type))
          throw new Error("Invalid Studio media.");
        total += value.size;
        if (total > STUDIO_REEL_INPUT_LIMIT) return new Response(null, { status: 413 });
        assets.set(id, { bytes: Buffer.from(await value.arrayBuffer()), mime: value.type });
      }
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(STUDIO_REEL_TIMEOUT_MS)]);
      const video = await renderHostedReel(input, assets, script, signal, options);
      return new Response(new Uint8Array(video), {
        headers: { "content-type": "video/mp4", "content-length": String(video.length) },
      });
    } catch {
      return new Response(null, { status: 422 });
    } finally {
      rendering = false;
    }
  };
}

if (import.meta.main) {
  const script = await readFile("dist/studio-reel-renderer/reel.js");
  const fetch = studioReelService(process.env.STUDIO_REEL_RENDERER_TOKEN || "", script, {
    channel: process.env.STUDIO_REEL_BROWSER_CHANNEL || undefined,
  });
  Bun.serve({
    hostname: process.env.STUDIO_REEL_RENDERER_HOST || "127.0.0.1",
    port: Number(process.env.PORT || 8789),
    idleTimeout: 125,
    maxRequestBodySize: STUDIO_REEL_INPUT_LIMIT + 256 * 1024,
    fetch,
  });
}
