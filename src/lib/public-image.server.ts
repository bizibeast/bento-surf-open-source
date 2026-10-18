import { reserveProviderUsage } from "./provider-budget.server";
import { readResponseBytes } from "./request-security.server";

const MAX_BYTES = 8 * 1024 * 1024;
const PUBLIC_OBJECT = /^\/storage\/v1\/object\/public\/[a-z0-9][a-z0-9._/-]*$/i;

function sourceUrl(request: Request) {
  const src = new URL(request.url).searchParams.get("src") || "";
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".supabase.co") ||
    !PUBLIC_OBJECT.test(url.pathname) ||
    url.pathname.includes("..") ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  return url;
}

export async function handleAvatarImageRequest(
  request: Request,
  env: { IMAGES?: ImagesBinding } | undefined,
) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405 });
  }
  if (!env?.IMAGES) return new Response("Not found", { status: 404 });
  const source = sourceUrl(request);
  const width = Number(new URL(request.url).searchParams.get("w"));
  if (!source || width !== 512) return new Response("Not found", { status: 404 });

  const cache = typeof caches === "undefined" ? null : await caches.open("bento-avatar-v1");
  const cacheKey = new Request(request.url, { method: "GET" });
  const cached = await cache?.match(cacheKey);
  if (cached) {
    return request.method === "HEAD"
      ? new Response(null, { status: cached.status, headers: cached.headers })
      : cached;
  }

  const upstream = await fetch(source, { redirect: "manual" });
  if (!upstream.ok) {
    await upstream.body?.cancel();
    return new Response("Not found", { status: 404 });
  }
  const type = upstream.headers.get("content-type")?.split(";")[0] || "";
  if (!/^image\/(?:png|jpeg|webp)$/i.test(type)) {
    await upstream.body?.cancel();
    return new Response("Not found", { status: 404 });
  }

  try {
    const bytes = await readResponseBytes(upstream, MAX_BYTES);
    await reserveProviderUsage("image_transformations");
    const transformed = await env.IMAGES.input(new Response(bytes).body!)
      .transform({ width: 512, fit: "scale-down" })
      .output({ format: "image/webp", quality: 82 });
    const transformedResponse = transformed.response();
    if (!transformedResponse.ok || !transformedResponse.body)
      throw new Error("Image resize failed");
    const headers = new Headers({
      "content-type": "image/webp",
      "cache-control": "public, max-age=86400, stale-while-revalidate=604800",
    });
    const response = new Response(request.method === "HEAD" ? null : transformedResponse.body, {
      headers,
    });
    if (cache && request.method === "GET") {
      await cache.put(cacheKey, response.clone()).catch(() => {});
    }
    return response;
  } catch (error) {
    console.warn("[avatar-image] resize failed", error);
    return new Response("Not found", { status: 404 });
  }
}
