import { loadPublicProfileByUsername } from "./profile.functions";
import {
  OPEN_GRAPH_IMAGE_SCALE,
  OPEN_GRAPH_IMAGE_VERSION,
  OPEN_GRAPH_VIEWPORT_HEIGHT,
  OPEN_GRAPH_VIEWPORT_WIDTH,
  publicPageCanonicalUrl,
  publicPageOpenGraphImageUrl,
  publicPagePreviewVersion,
  publicPageSlug,
  type PublicPagePreviewData,
} from "./open-graph";
import { readResponseBytes, readResponseText } from "./request-security.server";

export const OPEN_GRAPH_IMAGE_PATH = "/api/og/";

const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const MIN_SCREENSHOT_BYTES = 1_024;
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const STALE_CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=86400";

type ScreenshotBrowser = {
  quickAction(action: "screenshot", options: BrowserRunScreenshotOptions): Promise<Response>;
};

type OpenGraphEnvironment = Pick<Env, "MEDIA_BUCKET"> & {
  BROWSER: ScreenshotBrowser;
  EXPENSIVE_API_RATE_LIMITER?: {
    limit(options: { key: string }): Promise<{ success: boolean }>;
  };
};

type PublicProfileData = PublicPagePreviewData & { notFound?: boolean };

type OpenGraphDependencies = {
  loadProfile?: (username: string, pageSlug: string | null) => Promise<PublicProfileData | null>;
};

type ParsedOpenGraphPath = {
  username: string;
  pageSlug: string | null;
};

const RETRYABLE_BROWSER_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export function parseOpenGraphImagePath(pathname: string): ParsedOpenGraphPath | null {
  if (!pathname.startsWith(OPEN_GRAPH_IMAGE_PATH) || !pathname.endsWith(".jpg")) return null;
  const rawPath = pathname.slice(OPEN_GRAPH_IMAGE_PATH.length, -".jpg".length);
  const rawSegments = rawPath.split("/");
  if (rawSegments.length < 1 || rawSegments.length > 2) return null;

  let segments: string[];
  try {
    segments = rawSegments.map(decodeURIComponent);
  } catch {
    return null;
  }

  const [username, pageSlug] = segments;
  if (!username || !/^[a-z0-9_]{3,24}$/.test(username)) return null;
  if (pageSlug && !/^[a-z0-9-]{1,40}$/.test(pageSlug)) return null;
  return { username, pageSlug: pageSlug ?? null };
}

function previewObjectPrefix(data: PublicPagePreviewData) {
  return `og/${OPEN_GRAPH_IMAGE_VERSION}/${data.profile.id}/${data.activePageId ?? "main"}`;
}

function previewObjectKey(data: PublicPagePreviewData, version: string) {
  return `${previewObjectPrefix(data)}/shared-${version}.jpg`;
}

function latestObjectKey(data: PublicPagePreviewData) {
  return `${previewObjectPrefix(data)}/latest-shared.jpg`;
}

function imageHeaders(
  cacheStatus: "HIT" | "MISS" | "STALE",
  cacheControl = IMMUTABLE_CACHE_CONTROL,
) {
  return new Headers({
    "access-control-allow-origin": "*",
    "cache-control": cacheControl,
    "content-type": "image/jpeg",
    "cross-origin-resource-policy": "cross-origin",
    "x-bento-og": cacheStatus,
    "x-content-type-options": "nosniff",
  });
}

async function storedImageResponse(
  request: Request,
  bucket: R2Bucket,
  key: string,
  cacheStatus: "HIT" | "STALE",
) {
  if (request.method === "HEAD") {
    const object = await bucket.head(key);
    if (!object) return null;
    const headers = imageHeaders(
      cacheStatus,
      cacheStatus === "STALE" ? STALE_CACHE_CONTROL : IMMUTABLE_CACHE_CONTROL,
    );
    headers.set("etag", object.httpEtag);
    headers.set("content-length", String(object.size));
    return new Response(null, { headers });
  }

  const object = await bucket.get(key);
  if (!object) return null;
  const headers = imageHeaders(
    cacheStatus,
    cacheStatus === "STALE" ? STALE_CACHE_CONTROL : IMMUTABLE_CACHE_CONTROL,
  );
  headers.set("etag", object.httpEtag);
  headers.set("content-length", String(object.size));
  return new Response(object.body, { headers });
}

async function latestOrError(
  request: Request,
  bucket: R2Bucket,
  data: PublicPagePreviewData,
  message: string,
  status: number,
) {
  const latest = await storedImageResponse(request, bucket, latestObjectKey(data), "STALE");
  return latest ?? Response.json({ error: message }, { status });
}

function generationRateLimitKey(request: Request, data: PublicPagePreviewData) {
  const clientIp = request.headers.get("cf-connecting-ip")?.trim() || "missing-cloudflare-ip";
  return `og:${data.profile.id}:${clientIp}`.slice(0, 512);
}

async function renderPreview(
  browser: ScreenshotBrowser,
  options: BrowserRunScreenshotOptions,
  parsed: ParsedOpenGraphPath,
) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await browser.quickAction("screenshot", options);
    if (response.ok) {
      const bytes = await readResponseBytes(response, MAX_SCREENSHOT_BYTES).catch(() => null);
      if (bytes && isCompleteJpeg(bytes)) return bytes;
    }

    const detail = response.ok ? "" : await readResponseText(response, 16 * 1024).catch(() => "");
    console.error(
      JSON.stringify({
        event: response.ok ? "open_graph_screenshot_incomplete" : "open_graph_render_failed",
        attempt,
        status: response.status,
        username: parsed.username,
        pageSlug: parsed.pageSlug,
        detail: response.ok ? undefined : detail.slice(0, 2_000),
      }),
    );
    if (!response.ok && !RETRYABLE_BROWSER_STATUSES.has(response.status)) break;
  }
  return null;
}

function isCompleteJpeg(bytes: Uint8Array) {
  return (
    bytes.byteLength >= MIN_SCREENSHOT_BYTES &&
    bytes.byteLength <= MAX_SCREENSHOT_BYTES &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[bytes.byteLength - 2] === 0xff &&
    bytes[bytes.byteLength - 1] === 0xd9
  );
}

export async function handleOpenGraphImageRequest(
  request: Request,
  env: OpenGraphEnvironment,
  dependencies: OpenGraphDependencies = {},
) {
  const url = new URL(request.url);
  const parsed = parseOpenGraphImagePath(url.pathname);
  if (!parsed) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const loadProfile = dependencies.loadProfile ?? loadPublicProfileByUsername;
  const data = await loadProfile(parsed.username, parsed.pageSlug);
  if (!data || data.notFound) return Response.json({ error: "Page not found" }, { status: 404 });

  const version = publicPagePreviewVersion(data);
  if (url.searchParams.get("v") !== version) {
    return new Response(null, {
      status: 302,
      headers: {
        "cache-control": STALE_CACHE_CONTROL,
        location: publicPageOpenGraphImageUrl(data, url.origin),
      },
    });
  }

  const key = previewObjectKey(data, version);
  const stored = await storedImageResponse(request, env.MEDIA_BUCKET, key, "HIT");
  if (stored) return stored;

  const limiter = env.EXPENSIVE_API_RATE_LIMITER;
  if (limiter) {
    const limit = await limiter.limit({ key: generationRateLimitKey(request, data) });
    if (!limit.success) {
      return latestOrError(request, env.MEDIA_BUCKET, data, "Preview generation is busy", 429);
    }
  }

  if (!env.BROWSER) {
    return latestOrError(
      request,
      env.MEDIA_BUCKET,
      data,
      "Preview rendering is not configured",
      503,
    );
  }

  const pageUrl = new URL(publicPageCanonicalUrl(data, url.origin));
  pageUrl.searchParams.set("__bento_preview", version);
  const screenshotOptions = {
    url: pageUrl.toString(),
    viewport: {
      width: OPEN_GRAPH_VIEWPORT_WIDTH,
      height: OPEN_GRAPH_VIEWPORT_HEIGHT,
      deviceScaleFactor: OPEN_GRAPH_IMAGE_SCALE,
    },
    // Public Surfs can contain maps, embeds, and analytics requests that intentionally stay
    // active. Waiting for network idle makes otherwise-ready pages time out, so use the Bento
    // grid readiness marker below as the authoritative capture gate.
    // The readiness marker is deliberately client-only, so this cannot pass on
    // the server-rendered shell before hydration and the first real paint.
    gotoOptions: { waitUntil: "load", timeout: 30_000 },
    waitForSelector: {
      selector:
        data.blocks.length > 0
          ? `[data-bento-public-block-grid-ready="true"][data-bento-public-block-count="${data.blocks.length}"]`
          : '[data-bento-public-page="true"]',
      visible: true,
      timeout: 20_000,
    },
    // Give remote images, custom fonts, and the final grid layout time to paint after the
    // readiness marker appears. Explore and social crawlers share this exact same capture.
    waitForTimeout: 2_500,
    actionTimeout: 30_000,
    cacheTTL: 0,
    rejectResourceTypes: ["media"],
    screenshotOptions: {
      type: "jpeg",
      quality: 94,
      fullPage: false,
      clip: {
        x: 0,
        y: 0,
        width: OPEN_GRAPH_VIEWPORT_WIDTH,
        height: OPEN_GRAPH_VIEWPORT_HEIGHT,
      },
    },
  } satisfies BrowserRunScreenshotOptions;
  const bytes = await renderPreview(env.BROWSER, screenshotOptions, parsed);

  if (!bytes) {
    return latestOrError(request, env.MEDIA_BUCKET, data, "Preview rendering failed", 502);
  }

  const metadata = {
    httpMetadata: { contentType: "image/jpeg", cacheControl: IMMUTABLE_CACHE_CONTROL },
    customMetadata: {
      userId: data.profile.id,
      username: data.profile.username,
      pageSlug: publicPageSlug(data) ?? "main",
      version,
      variant: "shared",
    },
  } satisfies R2PutOptions;
  await Promise.all([
    env.MEDIA_BUCKET.put(key, bytes, metadata),
    env.MEDIA_BUCKET.put(latestObjectKey(data), bytes, metadata),
  ]);

  const headers = imageHeaders("MISS");
  headers.set("content-length", String(bytes.byteLength));
  return new Response(request.method === "HEAD" ? null : bytes, { headers });
}
