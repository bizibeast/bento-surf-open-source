import { RequestHttpError, enforceTurnstileRequest } from "./request-security.server";
import { BACKGROUND_REMOVAL_API_PATH } from "./free-image-tools";

export { BACKGROUND_REMOVAL_API_PATH } from "./free-image-tools";
export const MAX_BACKGROUND_REMOVAL_BYTES = 20 * 1024 * 1024;

type RateLimitBinding = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

type BackgroundRemovalEnv = {
  APP_ENV?: string;
  FREE_TOOLS_MEDIA_RATE_LIMITER?: RateLimitBinding;
  IMAGES?: ImagesBinding;
  TURNSTILE_VERIFIER_URL?: string;
};

function jsonError(message: string, status: number) {
  const headers = new Headers({ "cache-control": "private, no-store" });
  if (status === 429) headers.set("retry-after", "60");
  return Response.json({ error: message }, { status, headers });
}

function isProductionLike(env: BackgroundRemovalEnv) {
  return env.APP_ENV === "production" || env.APP_ENV === "staging";
}

export async function handleBackgroundRemovalRequest(
  request: Request,
  env: BackgroundRemovalEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== BACKGROUND_REMOVAL_API_PATH) return null;
  if (request.method !== "POST") {
    const headers = new Headers({ allow: "POST", "cache-control": "private, no-store" });
    return Response.json({ error: "Method not allowed" }, { status: 405, headers });
  }
  if (request.headers.get("origin") !== url.origin) {
    return jsonError("Cross-origin image uploads are not allowed", 403);
  }

  const contentType = request.headers.get("content-type")?.split(";", 1)[0].toLowerCase();
  if (!contentType || !["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
    return jsonError("Upload a JPG, PNG, or WebP image", 415);
  }
  const declaredSize = Number(request.headers.get("x-bento-file-size"));
  if (!Number.isSafeInteger(declaredSize) || declaredSize <= 0) {
    return jsonError("The uploaded file size could not be verified", 400);
  }
  if (declaredSize > MAX_BACKGROUND_REMOVAL_BYTES) {
    return jsonError("Images must be 20 MB or smaller", 413);
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) !== declaredSize) {
    return jsonError("The uploaded file size could not be verified", 400);
  }
  if (!request.body) return jsonError("Choose a non-empty image", 400);

  const limiter = env.FREE_TOOLS_MEDIA_RATE_LIMITER;
  if (!limiter && isProductionLike(env)) {
    return jsonError("Background removal is temporarily unavailable", 503);
  }
  if (limiter) {
    try {
      const address = request.headers.get("cf-connecting-ip")?.trim() || "missing-cloudflare-ip";
      if (
        !(await limiter.limit({ key: `free-tool-background:${address}`.slice(0, 512) })).success
      ) {
        return jsonError("Too many image requests. Please wait a minute.", 429);
      }
    } catch {
      return jsonError("Background removal is temporarily unavailable", 503);
    }
  }

  try {
    await enforceTurnstileRequest(request, env);
  } catch (error) {
    return error instanceof RequestHttpError
      ? jsonError(error.message, error.statusCode)
      : jsonError("Security verification is temporarily unavailable.", 503);
  }
  if (!env.IMAGES) return jsonError("Background removal is temporarily unavailable", 503);

  try {
    const transformed = await env.IMAGES.input(request.body)
      .transform({ segment: "foreground" })
      .output({ format: "image/png" });
    const response = transformed.response();
    const headers = new Headers(response.headers);
    headers.set("cache-control", "private, no-store");
    headers.set("content-disposition", 'attachment; filename="bento-background-removed.png"');
    headers.set("content-type", "image/png");
    headers.set("vary", "origin");
    return new Response(response.body, { status: response.status, headers });
  } catch {
    return jsonError("The image background could not be removed. Try another image.", 502);
  }
}
