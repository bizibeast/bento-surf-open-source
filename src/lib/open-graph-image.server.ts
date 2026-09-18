import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getPlan } from "./plan.server";
import { commerceEntitlement, planHasEntitlement } from "./plans";
import { safeMediaUrl } from "./safe-url";
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
import { publicProductUrl } from "./application-urls";
import type { CommerceProductKind } from "./commerce";

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

type PublicProfileData = PublicPagePreviewData & { notFound?: boolean; systemItems?: unknown[] };
type ProductPreviewData = {
  id: string;
  kind: CommerceProductKind;
  public_slug: string;
  cover_url: string | null;
  updated_at: string;
};

type OpenGraphDependencies = {
  loadProfile?: (
    username: string,
    pageSlug: string | null,
    requestHost?: string,
  ) => Promise<PublicProfileData | null>;
  loadProduct?: (creatorId: string, publicSlug: string) => Promise<ProductPreviewData | null>;
  productEntitled?: (creatorId: string, kind: CommerceProductKind) => Promise<boolean>;
};

type ParsedOpenGraphPath = {
  username: string;
  pageSlug: string | null;
  productSlug: string | null;
};

const RETRYABLE_BROWSER_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export function parseOpenGraphImagePath(pathname: string): ParsedOpenGraphPath | null {
  if (!pathname.startsWith(OPEN_GRAPH_IMAGE_PATH) || !pathname.endsWith(".jpg")) return null;
  const rawPath = pathname.slice(OPEN_GRAPH_IMAGE_PATH.length, -".jpg".length);
  const rawSegments = rawPath.split("/");
  if (rawSegments.length < 1 || rawSegments.length > 3) return null;

  let segments: string[];
  try {
    segments = rawSegments.map(decodeURIComponent);
  } catch {
    return null;
  }

  const [username, pageOrProducts, nestedSlug] = segments;
  if (!username || !/^[a-z0-9_]{3,24}$/.test(username)) return null;
  if (nestedSlug) {
    if (pageOrProducts !== "products" || !/^[a-z0-9-]{3,64}$/.test(nestedSlug)) return null;
    return { username, pageSlug: null, productSlug: nestedSlug };
  }
  if (pageOrProducts && !/^[a-z0-9-]{1,40}$/.test(pageOrProducts)) return null;
  return { username, pageSlug: pageOrProducts ?? null, productSlug: null };
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
  if (!latest) console.warn("[og] static fallback", { message, status });
  return latest ?? staticOpenGraphFallback(request);
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

async function productPreviewResponse(
  request: Request,
  env: OpenGraphEnvironment,
  parsed: ParsedOpenGraphPath,
  profile: PublicProfileData["profile"],
  product: ProductPreviewData,
) {
  const key = `og/product/${profile.id}/${product.id}/${product.updated_at}.jpg`;
  const stored = await storedImageResponse(request, env.MEDIA_BUCKET, key, "HIT");
  if (stored) return stored;
  if (!env.BROWSER) return staticOpenGraphFallback(request);

  const address = request.headers.get("cf-connecting-ip")?.trim() || "missing-cloudflare-ip";
  if (env.EXPENSIVE_API_RATE_LIMITER) {
    const limit = await env.EXPENSIVE_API_RATE_LIMITER.limit({
      key: `og:product:${product.id}:${address}`.slice(0, 512),
    });
    if (!limit.success) return staticOpenGraphFallback(request);
  }

  const pageUrl = publicProductUrl(
    profile.username,
    product.public_slug,
    new URL(request.url).origin,
  );
  const bytes = await renderPreview(
    env.BROWSER,
    {
      url: pageUrl,
      viewport: {
        width: OPEN_GRAPH_VIEWPORT_WIDTH,
        height: OPEN_GRAPH_VIEWPORT_HEIGHT,
        deviceScaleFactor: OPEN_GRAPH_IMAGE_SCALE,
      },
      gotoOptions: { waitUntil: "load", timeout: 30_000 },
      waitForSelector: { selector: "[data-product-website]", visible: true },
      cacheTTL: 0,
      screenshotOptions: {
        type: "jpeg",
        quality: 94,
        clip: {
          x: 0,
          y: 0,
          width: OPEN_GRAPH_VIEWPORT_WIDTH,
          height: OPEN_GRAPH_VIEWPORT_HEIGHT,
        },
      },
    } satisfies BrowserRunScreenshotOptions,
    parsed,
  );
  if (!bytes) return staticOpenGraphFallback(request);

  await env.MEDIA_BUCKET.put(key, bytes, {
    httpMetadata: { contentType: "image/jpeg", cacheControl: IMMUTABLE_CACHE_CONTROL },
    customMetadata: {
      userId: profile.id,
      username: profile.username,
      productId: product.id,
      version: product.updated_at,
      variant: "product",
    },
  });
  const headers = imageHeaders("MISS");
  headers.set("content-length", String(bytes.byteLength));
  return new Response(request.method === "HEAD" ? null : bytes, { headers });
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

async function renderOpenGraphImageRequest(
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
  const data = await loadProfile(
    parsed.username,
    parsed.productSlug ? null : parsed.pageSlug,
    url.host,
  );
  if (!data) return Response.json({ error: "Page not found" }, { status: 404 });
  if (parsed.productSlug) {
    const loadProduct =
      dependencies.loadProduct ??
      (async (creatorId: string, publicSlug: string) => {
        const { data: product, error } = await supabaseAdmin
          .from("commerce_products")
          .select("id,kind,public_slug,cover_url,updated_at")
          .eq("creator_id", creatorId)
          .eq("public_slug", publicSlug)
          .eq("status", "published")
          .maybeSingle();
        if (error) throw new Error("Product preview could not be loaded");
        return product as ProductPreviewData | null;
      });
    const product = await loadProduct(data.profile.id, parsed.productSlug);
    const entitled = product
      ? await (dependencies.productEntitled
          ? dependencies.productEntitled(data.profile.id, product.kind)
          : Promise.resolve(
              planHasEntitlement(await getPlan(data.profile.id), commerceEntitlement(product.kind)),
            ))
      : false;
    if (!product || !entitled) {
      return Response.json({ error: "Page not found" }, { status: 404 });
    }
    const cover = safeMediaUrl(product.cover_url);
    if (cover && /^https:\/\//.test(cover)) {
      return new Response(null, {
        status: 302,
        headers: { location: cover, "cache-control": "public, max-age=300" },
      });
    }
    return productPreviewResponse(request, env, parsed, data.profile, product);
  }
  if (data.notFound) {
    return Response.json({ error: "Page not found" }, { status: 404 });
  }

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
  const blockCount = data.blocks.length + (data.systemItems?.length || 0);
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
        blockCount > 0
          ? `[data-bento-public-block-grid-ready="true"][data-bento-public-block-count="${blockCount}"]`
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

export function staticOpenGraphFallback(request: Request) {
  return new Response(null, {
    status: 302,
    headers: {
      location: new URL("/branding/landing-og.jpg", request.url).toString(),
      "cache-control": "public, max-age=60",
      "x-bento-og": "FALLBACK",
    },
  });
}
export async function handleOpenGraphImageRequest(
  request: Request,
  env: OpenGraphEnvironment,
  dependencies: OpenGraphDependencies = {},
) {
  try {
    return await renderOpenGraphImageRequest(request, env, dependencies);
  } catch (error) {
    console.error("[og] preview failed", {
      path: new URL(request.url).pathname,
      message: error instanceof Error ? error.message : "Unknown preview error",
    });
    return staticOpenGraphFallback(request);
  }
}
