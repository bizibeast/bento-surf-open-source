import { readBoundedBytes } from "./media-stream";
import { inspectMp4Duration } from "./public-mp4";
import { publicSocialHttpsUrl, type PublicSocialPlatform } from "./public-social-url";

const MAX_REDIRECTS = 3;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const PROBE_BYTES = 64;
const MP4_METADATA_BYTES = 64 * 1024;
const SNIFF_BYTES = 16;
export const PUBLIC_SOCIAL_ATTEMPT_MS = 9_000;

export const publicMediaTypes = {
  "video/mp4": { extension: "mp4", kind: "video", pickerType: "video" },
  "image/jpeg": { extension: "jpg", kind: "image", pickerType: "photo" },
  "image/png": { extension: "png", kind: "image", pickerType: "photo" },
  "image/webp": { extension: "webp", kind: "image", pickerType: "photo" },
  "image/gif": { extension: "gif", kind: "image", pickerType: "gif" },
  "application/pdf": { extension: "pdf", kind: "document", pickerType: "document" },
} as const;

export type PublicMediaType = keyof typeof publicMediaTypes;
export type PublicAssetKind = (typeof publicMediaTypes)[PublicMediaType]["kind"];

export function isPublicMediaType(value: unknown): value is PublicMediaType {
  return typeof value === "string" && Object.hasOwn(publicMediaTypes, value);
}

type PublicSocialFailure =
  | "unavailable"
  | "missing"
  | "blocked"
  | "unsupported"
  | "stream_only"
  | "file_unavailable"
  | "too_long";

export class PublicSocialError extends Error {
  constructor(readonly reason: PublicSocialFailure) {
    super(reason);
  }
}

export class PublicMediaTooLarge extends Error {}

export function publicAssetUrl(
  platform: PublicSocialPlatform,
  kind: PublicAssetKind,
  value: unknown,
) {
  const url = publicSocialHttpsUrl(value);
  if (!url || url.hash) return null;
  const { hostname, pathname } = url;
  if (platform === "twitter") {
    if (kind === "video" && hostname === "video.twimg.com") return url;
    if (kind === "image" && hostname === "pbs.twimg.com" && pathname.startsWith("/media/"))
      return url;
  } else if (platform === "pinterest") {
    if (
      kind === "video" &&
      /^v\d{1,2}\.pinimg\.com$/u.test(hostname) &&
      pathname.startsWith("/videos/")
    )
      return url;
    if (kind === "image" && hostname === "i.pinimg.com") return url;
  } else if (hostname === "dms.licdn.com" || hostname === "media.licdn.com") {
    if (kind === "image" && pathname.startsWith("/dms/image/")) return url;
    if (kind === "document" && pathname.startsWith("/dms/document/")) return url;
    if (kind === "video" && /^\/(?:dms\/video|playlist\/vid)\//u.test(pathname)) return url;
  }
  return null;
}

export function discardPublicResponse(response: Response) {
  if (!response.bodyUsed) void response.body?.cancel().catch(() => undefined);
}

export class PublicSocialFetch {
  private reservedRequests = 0;

  constructor(
    private readonly signal: AbortSignal,
    private requestsRemaining: number,
  ) {}

  reserveRequests(count: number) {
    this.reservedRequests = count;
  }

  private async follow(
    source: URL,
    allowed: (url: URL) => boolean,
    headers: Record<string, string>,
    signal: AbortSignal,
    stopAt?: (url: URL) => boolean,
  ) {
    let target = source;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      signal.throwIfAborted();
      if (!allowed(target)) break;
      if (stopAt?.(target)) return target;
      if (this.requestsRemaining <= this.reservedRequests) break;
      this.requestsRemaining -= 1;
      const response = await fetch(target, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          ...headers,
        },
        method: "GET",
        redirect: "manual",
        signal,
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url: target };
      discardPublicResponse(response);
      const location = response.headers.get("location");
      if (!location || location.length > 2_048) break;
      const next = publicSocialHttpsUrl(new URL(location, target).href);
      if (!next) break;
      target = next;
    }
    throw new PublicSocialError("unavailable");
  }

  async get(
    source: URL,
    allowed: (url: URL) => boolean,
    headers: Record<string, string>,
    signal: AbortSignal,
  ) {
    const result = await this.follow(source, allowed, headers, signal);
    if (result instanceof URL) throw new PublicSocialError("unavailable");
    return result;
  }

  async redirectTarget(source: URL, allowed: (url: URL) => boolean, stopAt: (url: URL) => boolean) {
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(PUBLIC_SOCIAL_ATTEMPT_MS)]);
    const result = await this.follow(source, allowed, {}, signal, stopAt);
    if (result instanceof URL) return result;
    discardPublicResponse(result.response);
    if (result.response.status === 404 || result.response.status === 410)
      throw new PublicSocialError("missing");
    if ([401, 403, 429, 451].includes(result.response.status))
      throw new PublicSocialError("blocked");
    throw new PublicSocialError("unavailable");
  }

  async text(
    source: URL,
    allowed: (url: URL) => boolean,
    accept: string,
    headers?: Record<string, string>,
  ) {
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(PUBLIC_SOCIAL_ATTEMPT_MS)]);
    const { response, url } = await this.get(source, allowed, { accept, ...headers }, signal);
    try {
      if (response.status === 404 || response.status === 410)
        throw new PublicSocialError("missing");
      if ([401, 403, 429, 451].includes(response.status)) throw new PublicSocialError("blocked");
      if (!response.ok) throw new PublicSocialError("unavailable");
      const body = new TextDecoder().decode(await readBoundedBytes(response, MAX_METADATA_BYTES));
      return { body, url };
    } finally {
      discardPublicResponse(response);
    }
  }
}

const jpg = [255, 216, 255];
const png = [137, 80, 78, 71, 13, 10, 26, 10];
const ascii = new TextDecoder();

function sniffPublicMedia(bytes: Uint8Array): PublicMediaType | null {
  if (jpg.every((byte, index) => bytes[index] === byte)) return "image/jpeg";
  if (png.every((byte, index) => bytes[index] === byte)) return "image/png";
  const text = ascii.decode(bytes);
  if (/^GIF8[79]a/u.test(text)) return "image/gif";
  const type = ascii.decode(bytes.subarray(8, 12));
  if (text.startsWith("RIFF") && type === "WEBP") return "image/webp";
  if (/^%PDF-[12]\.\d/u.test(text)) return "application/pdf";
  if (
    bytes.length >= 16 &&
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0) >= 16 &&
    ascii.decode(bytes.subarray(4, 8)) === "ftyp" &&
    /^(?:iso[m2-9]|mp4[12]|avc1|dash|M4V |MSNV)$/u.test(type)
  )
    return "video/mp4";
  return null;
}

function declaredBodyLength(response: Response) {
  const raw = response.headers.get("content-length");
  if (raw === null) return null;
  const size = Number(raw);
  if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(size)) throw new PublicMediaTooLarge();
  return size;
}

type ByteRange = { start: number; end: number };

function validateMediaLength(response: Response, maxBytes: number, requestedRange?: ByteRange) {
  const length = declaredBodyLength(response);
  if (length !== null && length > maxBytes) throw new PublicMediaTooLarge();
  if (response.status !== 206) return { length, total: length, rangeLength: null };
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(response.headers.get("content-range") ?? "");
  if (!range || !requestedRange) throw new PublicSocialError("file_unavailable");
  const [, rawStart, rawEnd, rawTotal] = range;
  const start = Number(rawStart);
  const end = Number(rawEnd);
  const total = Number(rawTotal);
  if (total > maxBytes) throw new PublicMediaTooLarge();
  const rangeLength = end - start + 1;
  if (
    start !== requestedRange.start ||
    end > requestedRange.end ||
    end < start ||
    total <= end ||
    (length !== null && length !== rangeLength)
  )
    throw new PublicSocialError("file_unavailable");
  return { length, total, rangeLength };
}

/** Read a short prefix and replay it to the stream when serving a verified download. */
async function inspectMediaBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  prefixLimit: number,
) {
  if (!response.body) throw new PublicSocialError("unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const prefix = new Uint8Array(prefixLimit);
  let prefixLength = 0;
  let bytesRead = 0;
  const abort = () => void reader.cancel(signal.reason).catch(() => undefined);
  signal.addEventListener("abort", abort, { once: true });
  const finish = () => signal.removeEventListener("abort", abort);
  try {
    signal.throwIfAborted();
    while (prefixLength < prefix.length) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (!value.byteLength) continue;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw new PublicMediaTooLarge();
      chunks.push(value);
      const part = value.subarray(0, prefix.length - prefixLength);
      prefix.set(part, prefixLength);
      prefixLength += part.length;
    }
    const contentType = sniffPublicMedia(prefix.subarray(0, Math.min(prefixLength, SNIFF_BYTES)));
    if (!contentType) throw new PublicSocialError("unsupported");
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          signal.throwIfAborted();
          const chunk = chunks.shift();
          if (chunk) {
            controller.enqueue(chunk);
            return;
          }
          const { done, value } = await reader.read();
          signal.throwIfAborted();
          if (done) {
            finish();
            controller.close();
          } else {
            controller.enqueue(value);
          }
        } catch (error) {
          finish();
          void reader.cancel(error).catch(() => undefined);
          controller.error(error);
        }
      },
      cancel(reason) {
        finish();
        return reader.cancel(reason);
      },
    });
    return { contentType, body, prefix: prefix.subarray(0, prefixLength) };
  } catch (error) {
    finish();
    void reader.cancel(error).catch(() => undefined);
    throw error;
  }
}

export async function openPublicMedia(
  client: PublicSocialFetch,
  platform: PublicSocialPlatform,
  kind: PublicAssetKind,
  source: URL,
  maxBytes: number,
  signal: AbortSignal,
  probe: boolean,
  inspectDuration = false,
) {
  const probeSize = inspectDuration ? MP4_METADATA_BYTES : PROBE_BYTES;
  const probeRange = probe ? { start: 0, end: probeSize - 1 } : undefined;
  const { response } = await client.get(
    source,
    (url) => Boolean(publicAssetUrl(platform, kind, url.href)),
    {
      accept: kind === "document" ? "application/pdf, */*;q=0.8" : `${kind}/*, */*;q=0.8`,
      ...(probeRange ? { range: `bytes=0-${probeRange.end}` } : {}),
    },
    signal,
  );
  try {
    if (response.status !== 200 && !(probe && response.status === 206)) {
      throw new PublicSocialError("file_unavailable");
    }
    const { length, total, rangeLength } = validateMediaLength(response, maxBytes, probeRange);
    const contentEncoded = response.headers.has("content-encoding");
    if (inspectDuration && contentEncoded && response.status === 206) {
      throw new PublicSocialError("file_unavailable");
    }
    const declared =
      response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
    if (
      declared &&
      declared !== "application/octet-stream" &&
      (!isPublicMediaType(declared) || publicMediaTypes[declared].kind !== kind)
    )
      throw new PublicSocialError("unsupported");

    const media = await inspectMediaBody(
      response,
      rangeLength ?? maxBytes,
      signal,
      inspectDuration ? (rangeLength ?? probeSize) : SNIFF_BYTES,
    );
    if (inspectDuration && rangeLength !== null && media.prefix.length !== rangeLength) {
      void media.body.cancel().catch(() => undefined);
      throw new PublicSocialError("file_unavailable");
    }
    if (publicMediaTypes[media.contentType].kind !== kind) {
      void media.body.cancel().catch(() => undefined);
      throw new PublicSocialError("unsupported");
    }
    return {
      ...media,
      totalLength: contentEncoded ? null : total,
      contentLength: response.status === 200 && !contentEncoded ? length : null,
    };
  } finally {
    discardPublicResponse(response);
  }
}

export async function publicMp4Duration(
  client: PublicSocialFetch,
  platform: PublicSocialPlatform,
  source: URL,
  firstBytes: Uint8Array,
  length: number | null,
  maxBytes: number,
  signal: AbortSignal,
) {
  let bytes = firstBytes;
  let offset = 0;
  let fileLength = length ?? maxBytes;
  for (let range = 0; range <= 2; range += 1) {
    const result = inspectMp4Duration(bytes, offset, fileLength);
    if (!result) break;
    if ("seconds" in result) return result.seconds;
    if (range === 2 || result.next >= fileLength) break;

    offset = result.next;
    const rangeEnd = Math.min(offset + MP4_METADATA_BYTES, fileLength) - 1;
    const { response } = await client.get(
      source,
      (url) => Boolean(publicAssetUrl(platform, "video", url.href)),
      { accept: "video/mp4, */*;q=0.8", range: `bytes=${offset}-${rangeEnd}` },
      signal,
    );
    try {
      if (response.status !== 206 || response.headers.has("content-encoding")) break;
      const checked = validateMediaLength(response, maxBytes, { start: offset, end: rangeEnd });
      if (checked.total === null || (length !== null && checked.total !== length)) break;
      fileLength = checked.total;
      length = fileLength;
      bytes = await readBoundedBytes(response, MP4_METADATA_BYTES);
      if (bytes.length !== checked.rangeLength) break;
    } finally {
      discardPublicResponse(response);
    }
  }
  throw new PublicSocialError("file_unavailable");
}
