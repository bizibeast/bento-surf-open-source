import { MEDIA_DOWNLOAD_MAX_BYTES } from "./media-tools";
import { readBoundedBytes } from "./media-stream";
import { youtubeVideoIdFromUrl } from "./social-embeds";

export const BASIC_MEDIA_PATH = "/basic-media";
const MAX_BYTES = MEDIA_DOWNLOAD_MAX_BYTES;
const LIFETIME_SECONDS = 90;
export type BasicMediaBindings = {
  BASIC_MEDIA_RESOLVER?: { fetch(request: Request): Promise<Response> };
  BASIC_MEDIA_TOKEN?: string;
  RESOLVER_SHARED_SECRET?: string;
};

export function isBasicMediaSource(value: unknown) {
  if (typeof value !== "string") return false;
  if (youtubeVideoIdFromUrl(value)) return true;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      ((["www.tiktok.com", "tiktok.com", "m.tiktok.com"].includes(url.hostname) &&
        /^\/@[A-Za-z0-9._-]{1,64}\/video\/\d{8,24}\/?$/u.test(url.pathname)) ||
        (["vm.tiktok.com", "vt.tiktok.com"].includes(url.hostname) &&
          /^\/[A-Za-z0-9_-]{5,64}\/?$/u.test(url.pathname)))
    );
  } catch {
    return false;
  }
}
function configured(env: BasicMediaBindings) {
  return Boolean(
    env.BASIC_MEDIA_RESOLVER &&
    env.BASIC_MEDIA_TOKEN &&
    env.BASIC_MEDIA_TOKEN.length >= 32 &&
    env.RESOLVER_SHARED_SECRET &&
    env.RESOLVER_SHARED_SECRET.length >= 32,
  );
}
function error(code: string) {
  return { status: "error", error: { code } };
}
function same(left: string, right: string) {
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++)
    diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  return diff === 0;
}
async function sign(secret: string, payload: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const result = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
  );
  return btoa(String.fromCharCode(...result))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}
function signaturePayload(id: string, filename: string, expiry: string) {
  return `basic-media\n${id}\n${filename}\n${expiry}`;
}
function validFilename(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:youtube-[A-Za-z0-9_-]{11}|tiktok-\d{8,24})\.(?:mp4|mp3)$/u.test(value)
  );
}

/** Only the private service binding can resolve. No generic URL proxy or credentials in links. */
export async function resolveBasicMedia(
  body: Record<string, unknown>,
  env: BasicMediaBindings,
  origin: string,
  signal: AbortSignal,
) {
  if (!configured(env) || !isBasicMediaSource(body.url)) return null;
  try {
    const response = await env.BASIC_MEDIA_RESOLVER!.fetch(
      new Request("https://basic-media.internal/resolve", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.BASIC_MEDIA_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          url: body.url,
          downloadMode: body.downloadMode,
          videoQuality: body.videoQuality,
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(50_000)]),
      }),
    );
    const data = JSON.parse(new TextDecoder().decode(await readBoundedBytes(response, 4096)));
    if (!response.ok) {
      const code =
        typeof data?.code === "string" && /^error\.api\.[a-z_.]{1,80}$/u.test(data.code)
          ? data.code
          : "error.api.fetch.fail";
      return error(code);
    }
    if (
      !/^[a-f0-9]{32}$/u.test(data?.id) ||
      !validFilename(data.filename) ||
      data.contentType !== (data.filename.endsWith(".mp3") ? "audio/mpeg" : "video/mp4") ||
      data.filename.endsWith(".mp3") !== (body.downloadMode === "audio")
    )
      return error("error.api.fetch.fail");
    const expiry = String(Math.floor(Date.now() / 1000) + LIFETIME_SECONDS);
    const url = new URL(BASIC_MEDIA_PATH, origin);
    url.search = new URLSearchParams({
      id: data.id,
      bento_filename: data.filename,
      expires: expiry,
      signature: await sign(
        env.RESOLVER_SHARED_SECRET!,
        signaturePayload(data.id, data.filename, expiry),
      ),
    }).toString();
    return { status: "tunnel", url: url.toString(), filename: data.filename };
  } catch {
    return error("error.api.fetch.fail");
  }
}

export async function tunnelBasicMedia(
  request: Request,
  env: BasicMediaBindings,
  rateLimit: () => Promise<Response | null>,
) {
  const json = (message: string, status: number) =>
    Response.json(
      { error: message },
      { status, headers: { "cache-control": "private, no-store" } },
    );
  if (request.method !== "GET" && request.method !== "HEAD") return json("Method not allowed", 405);
  const url = new URL(request.url);
  const id = url.searchParams.get("id") || "";
  const filename = url.searchParams.get("bento_filename") || "";
  const expiry = url.searchParams.get("expires") || "";
  const signature = url.searchParams.get("signature") || "";
  const now = Math.floor(Date.now() / 1000);
  if (
    !configured(env) ||
    !/^[a-f0-9]{32}$/u.test(id) ||
    !validFilename(filename) ||
    !/^\d{10}$/u.test(expiry) ||
    Number(expiry) < now ||
    Number(expiry) > now + LIFETIME_SECONDS ||
    !/^[A-Za-z0-9_-]{43}$/u.test(signature) ||
    ["id", "bento_filename", "expires", "signature"].some(
      (k) => url.searchParams.getAll(k).length !== 1,
    ) ||
    !same(
      signature,
      await sign(env.RESOLVER_SHARED_SECRET!, signaturePayload(id, filename, expiry)),
    )
  )
    return json("This download link expired", 404);
  const denied = await rateLimit();
  if (denied) return denied;
  const type = filename.endsWith(".mp3") ? "audio/mpeg" : "video/mp4";
  const headers = {
    "content-type": type,
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  };
  // Browser probes must not start another billed stream or consume the single execution slot.
  if (request.method === "HEAD") return new Response(null, { headers });
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30 * 60_000)]);
  try {
    const response = await env.BASIC_MEDIA_RESOLVER!.fetch(
      new Request(`https://basic-media.internal/stream/${id}`, {
        headers: { authorization: `Bearer ${env.BASIC_MEDIA_TOKEN}` },
        signal,
      }),
    );
    if (!response.ok || !response.body || response.headers.get("content-type") !== type) {
      let code: string | undefined;
      try {
        const payload = JSON.parse(
          new TextDecoder().decode(await readBoundedBytes(response, 4096)),
        );
        if (typeof payload?.code === "string") code = payload.code;
      } catch {
        await response.body?.cancel().catch(() => undefined);
      }
      if (code === "error.api.tiktok.blocked") {
        return json(
          "TikTok did not allow this download. Try another public post or use the original file.",
          422,
        );
      }
      return json(
        response.status === 429
          ? "The media service is busy. Please try again later."
          : "This download is unavailable. Please resolve the link again.",
        response.status === 429 ? 429 : 502,
      );
    }
    const reader = response.body.getReader();
    const abort = () => {
      void reader.cancel(signal.reason).catch(() => undefined);
    };
    signal.addEventListener("abort", abort, { once: true });
    let size = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          signal.throwIfAborted();
          const next = await reader.read();
          signal.throwIfAborted();
          if (next.done) {
            signal.removeEventListener("abort", abort);
            controller.close();
            return;
          }
          size += next.value.byteLength;
          if (size > MAX_BYTES) throw new Error("Media byte ceiling");
          controller.enqueue(next.value);
        } catch (error) {
          signal.removeEventListener("abort", abort);
          await reader.cancel().catch(() => undefined);
          controller.error(error);
        }
      },
      async cancel(reason) {
        signal.removeEventListener("abort", abort);
        await reader.cancel(reason);
      },
    });
    return new Response(stream, { headers });
  } catch {
    return json("This download is unavailable. Please resolve the link again.", 502);
  }
}
