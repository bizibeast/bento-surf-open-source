import { imageUploadMaxDimension, isAnimatedImage } from "./image-upload";
import { reserveProviderUsage } from "./provider-budget.server";
import {
  resolveWorkspace,
  verifyWorkspaceCookie,
  workspaceCookieSigningKey,
  WORKSPACE_COOKIE,
} from "./workspace-session.server";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { getPlan, getStorageAllowanceMb } from "./plan.server";
import { captureServerEvent } from "./posthog.server";
import { planName, uploadLimitMb, type PlanId } from "./plans";
import { readRequestText, RequestBodyTooLargeError } from "./request-security.server";
import { adjustCachedR2UserStorageBytes, cachedR2UserStorageBytes } from "./r2-usage-cache.server";

export const R2_BUCKET_NAME = "bento-surf-media";
export const MEDIA_CDN_PATH = "/cdn/";

const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const MULTIPART_PART_BYTES = 8 * 1024 * 1024;
const MAX_MULTIPART_COMPLETE_BODY_BYTES = 64 * 1024;
const MAX_STORAGE_DELETE_BODY_BYTES = 128 * 1024;
const MAX_STORAGE_PAGE_OBJECTS = 100;
const SIGNATURE_PEEK_BYTES = 512;
const UPLOAD_KINDS = [
  "avatar",
  "image",
  "video",
  "audio",
  "file",
  "cover",
  "product_file",
  "agent_file",
] as const;

export type UploadKind = (typeof UPLOAD_KINDS)[number];

type StorageEnv = Pick<Env, "MEDIA_BUCKET"> & {
  IMAGES?: ImagesBinding;
  APP_ENV?: string;
  UPLOAD_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
};
type StorageContext = Pick<ExecutionContext, "waitUntil">;

type StorageDependencies = {
  authenticate?: (request: Request, env: StorageEnv) => Promise<string>;
  getPlan?: (userId: string) => Promise<PlanId>;
  getStorageAllowanceMb?: (userId: string) => Promise<number>;
  /** @deprecated Test compatibility; new callers should provide getPlan. */
  isPro?: (userId: string) => Promise<boolean>;
};

declare global {
  // Nitro places the active Cloudflare binding object here before it dispatches
  // the request to TanStack Start. It contains environment bindings, not
  // request-specific user data.
  var __env__: Env | undefined;
}

function jsonError(message: string, status: number) {
  const headers = new Headers({ "cache-control": "no-store" });
  if (status === 401) headers.set("www-authenticate", "Bearer");
  if (status === 429) headers.set("retry-after", "60");
  return Response.json({ error: message }, { status, headers });
}

function isUploadKind(value: string | null): value is UploadKind {
  return UPLOAD_KINDS.includes(value as UploadKind);
}

export function sanitizeFileExtension(value: string | null) {
  const extension = (value ?? "").toLowerCase();
  return /^[a-z0-9]{1,5}$/.test(extension) ? extension : null;
}

export function validateMediaObjectKey(value: string) {
  if (!value || value.startsWith("/") || value.includes("..") || value.includes("\0")) {
    return null;
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || !/^[a-zA-Z0-9._-]+$/.test(part))) return null;
  return parts.join("/");
}

function sanitizeOriginalFilename(value: string | null) {
  if (!value) return null;
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Plain header values remain valid when they contain a literal percent sign.
  }
  const sanitized = [...decoded.normalize("NFKC")]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && code !== 127 && character !== "/" && character !== "\\";
    })
    .slice(0, 180)
    .join("")
    .replace(/^\.+/, "")
    .trim();
  return sanitized || null;
}

export function mediaObjectUrl(key: string, origin = process.env.VITE_PUBLIC_URL) {
  const safeKey = validateMediaObjectKey(key);
  if (!safeKey) throw new Error("Invalid media object key");
  const base = (origin || "http://localhost:8080").replace(/\/$/, "");
  return `${base}${MEDIA_CDN_PATH}${safeKey
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
}

export function getMediaBucket() {
  const bucket = globalThis.__env__?.MEDIA_BUCKET;
  if (!bucket) throw new Error("Cloudflare R2 is not configured");
  return bucket;
}

export async function authenticateUpload(request: Request, _env: StorageEnv) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) throw new Error("Unauthorized");
  const token = authorization.slice("Bearer ".length).trim();
  if (!token) throw new Error("Unauthorized");

  const supabaseUrl = process.env.SUPABASE_URL;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !publishableKey) throw new Error("Supabase authentication is not configured");
  const supabase = createClient<Database>(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, storage: undefined },
  });
  const { data, error } = await supabase.auth.getClaims(token);
  const userId = data?.claims?.sub;
  if (error || typeof userId !== "string" || !userId) throw new Error("Unauthorized");
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${WORKSPACE_COOKIE}=`))
    ?.slice(WORKSPACE_COOKIE.length + 1);
  const selected = cookie ? await verifyWorkspaceCookie(cookie, workspaceCookieSigningKey()) : null;
  const workspace = await resolveWorkspace(userId, selected);
  return workspace.workspaceId;
}

const ACTIVE_CONTENT_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "application/javascript",
  "text/javascript",
  "image/svg+xml",
  "application/xml",
  "text/xml",
]);

const IMAGE_EXTENSIONS: Record<string, ReadonlySet<string>> = {
  "image/jpeg": new Set(["jpg", "jpeg", "jfif"]),
  "image/png": new Set(["png"]),
  "image/webp": new Set(["webp"]),
  "image/gif": new Set(["gif"]),
  "image/avif": new Set(["avif"]),
};

const ACTIVE_FILE_EXTENSIONS = new Set([
  "html",
  "htm",
  "xhtml",
  "svg",
  "xml",
  "js",
  "mjs",
  "cjs",
  "php",
]);

const EXECUTABLE_FILE_EXTENSIONS = new Set([
  "apk",
  "app",
  "application",
  "appref-ms",
  "appx",
  "appxbundle",
  "bash",
  "bat",
  "bin",
  "cgi",
  "chm",
  "class",
  "cmd",
  "com",
  "command",
  "cpl",
  "deb",
  "desktop",
  "dll",
  "dmg",
  "docm",
  "elf",
  "exe",
  "fish",
  "gadget",
  "hta",
  "inf",
  "ins",
  "ipa",
  "iso",
  "jar",
  "jse",
  "ksh",
  "lnk",
  "msc",
  "msi",
  "msix",
  "msp",
  "mst",
  "ocx",
  "pkg",
  "pl",
  "pif",
  "ps1",
  "psd1",
  "psm1",
  "py",
  "pyc",
  "pyo",
  "rb",
  "reg",
  "rpm",
  "run",
  "sct",
  "scr",
  "sh",
  "shb",
  "sys",
  "url",
  "vb",
  "vbe",
  "vbs",
  "wasm",
  "ws",
  "wsc",
  "wsf",
  "wsh",
  "xlsm",
  "xll",
  "pptm",
  "zsh",
]);

type FileSignature =
  | "7z"
  | "avif"
  | "gif"
  | "gzip"
  | "iso-bmff"
  | "jpeg"
  | "mp3"
  | "pdf"
  | "png"
  | "rar"
  | "wav"
  | "webm"
  | "webp"
  | "zip";

const SIGNATURE_BY_CONTENT_TYPE: Record<string, FileSignature> = {
  "application/epub+zip": "zip",
  "application/gzip": "gzip",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "zip",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "zip",
  "application/vnd.rar": "rar",
  "application/x-7z-compressed": "7z",
  "application/x-gzip": "gzip",
  "application/x-rar-compressed": "rar",
  "application/x-zip-compressed": "zip",
  "application/zip": "zip",
  "audio/mp4": "iso-bmff",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "audio/x-wav": "wav",
  "image/avif": "avif",
  "image/gif": "gif",
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "iso-bmff",
  "video/quicktime": "iso-bmff",
  "video/webm": "webm",
};

const SIGNATURE_BY_EXTENSION: Record<string, FileSignature> = {
  "7z": "7z",
  avif: "avif",
  docx: "zip",
  epub: "zip",
  gif: "gif",
  gz: "gzip",
  jpeg: "jpeg",
  jfif: "jpeg",
  jpg: "jpeg",
  m4a: "iso-bmff",
  m4v: "iso-bmff",
  mov: "iso-bmff",
  mp3: "mp3",
  mp4: "iso-bmff",
  pdf: "pdf",
  png: "png",
  pptx: "zip",
  rar: "rar",
  wav: "wav",
  webm: "webm",
  webp: "webp",
  xlsx: "zip",
  zip: "zip",
};

function hasBytes(bytes: Uint8Array, expected: readonly number[], offset = 0) {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function hasAscii(bytes: Uint8Array, expected: string, offset = 0) {
  return hasBytes(
    bytes,
    [...expected].map((value) => value.charCodeAt(0)),
    offset,
  );
}

function matchesFileSignature(bytes: Uint8Array, signature: FileSignature) {
  switch (signature) {
    case "7z":
      return hasBytes(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
    case "avif":
      return (
        hasAscii(bytes, "ftyp", 4) && (hasAscii(bytes, "avif", 8) || hasAscii(bytes, "avis", 8))
      );
    case "gif":
      return hasAscii(bytes, "GIF87a") || hasAscii(bytes, "GIF89a");
    case "gzip":
      return hasBytes(bytes, [0x1f, 0x8b]);
    case "iso-bmff":
      return hasAscii(bytes, "ftyp", 4);
    case "jpeg":
      return hasBytes(bytes, [0xff, 0xd8, 0xff]);
    case "mp3":
      return hasAscii(bytes, "ID3") || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
    case "pdf":
      return hasAscii(bytes, "%PDF-");
    case "png":
      return hasBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "rar":
      return hasAscii(bytes, "Rar!\u001a\u0007");
    case "wav":
      return hasAscii(bytes, "RIFF") && hasAscii(bytes, "WAVE", 8);
    case "webm":
      return hasBytes(bytes, [0x1a, 0x45, 0xdf, 0xa3]);
    case "webp":
      return hasAscii(bytes, "RIFF") && hasAscii(bytes, "WEBP", 8);
    case "zip":
      return (
        hasBytes(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
        hasBytes(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
        hasBytes(bytes, [0x50, 0x4b, 0x07, 0x08])
      );
  }
}

function isExecutableOrActiveContent(bytes: Uint8Array) {
  const executableMagic = [
    [0x4d, 0x5a],
    [0x7f, 0x45, 0x4c, 0x46],
    [0xfe, 0xed, 0xfa, 0xce],
    [0xce, 0xfa, 0xed, 0xfe],
    [0xfe, 0xed, 0xfa, 0xcf],
    [0xcf, 0xfa, 0xed, 0xfe],
    [0xca, 0xfe, 0xba, 0xbe],
    [0xbe, 0xba, 0xfe, 0xca],
  ];
  if (executableMagic.some((magic) => hasBytes(bytes, magic))) return true;

  const text = new TextDecoder()
    .decode(bytes)
    .replace(/^\uFEFF/, "")
    .trimStart()
    .toLowerCase();
  return ["#!", "<!doctype html", "<html", "<script", "<?php", "<?xml", "<svg"].some((prefix) =>
    text.startsWith(prefix),
  );
}

function hasValidFileSignature(bytes: Uint8Array, contentType: string, extension: string) {
  if (isExecutableOrActiveContent(bytes)) return false;
  const typeSignature = SIGNATURE_BY_CONTENT_TYPE[contentType];
  const extensionSignature = SIGNATURE_BY_EXTENSION[extension];
  if (typeSignature && extensionSignature && typeSignature !== extensionSignature) return false;
  const expected = typeSignature || extensionSignature;
  return !expected || matchesFileSignature(bytes, expected);
}

async function inspectUploadBody(
  body: ReadableStream<Uint8Array>,
  contentType: string,
  extension: string,
) {
  const [inspection, upload] = body.tee();
  const reader = inspection.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < SIGNATURE_PEEK_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, SIGNATURE_PEEK_BYTES - total);
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (hasValidFileSignature(bytes, contentType, extension)) return upload;
  await upload.cancel().catch(() => undefined);
  return null;
}

function validateContentType(kind: UploadKind, value: string | null, extension: string) {
  let contentType = (value || "application/octet-stream").split(";", 1)[0].toLowerCase();
  if (
    (kind === "video" || kind === "audio") &&
    (contentType === "application/octet-stream" || !contentType)
  ) {
    if (kind === "video") {
      if (extension === "mov") contentType = "video/quicktime";
      else if (extension === "webm") contentType = "video/webm";
      else if (["mp4", "m4v", "mpeg", "mpg"].includes(extension)) contentType = "video/mp4";
    }
    if (kind === "audio") {
      if (extension === "mp3") contentType = "audio/mpeg";
      else if (extension === "wav") contentType = "audio/wav";
      else if (extension === "m4a") contentType = "audio/mp4";
    }
  }
  if (
    ACTIVE_CONTENT_TYPES.has(contentType) ||
    ACTIVE_FILE_EXTENSIONS.has(extension) ||
    EXECUTABLE_FILE_EXTENSIONS.has(extension)
  ) {
    return null;
  }
  if (
    kind === "agent_file" &&
    !(
      (extension === "pdf" && contentType === "application/pdf") ||
      (["txt", "md", "csv"].includes(extension) &&
        ["text/plain", "text/markdown", "text/csv", "application/octet-stream"].includes(
          contentType,
        ))
    )
  )
    return null;
  if (kind === "avatar" || kind === "image" || kind === "cover") {
    if (!IMAGE_EXTENSIONS[contentType]?.has(extension)) return null;
  }
  if (kind === "video" && !contentType.startsWith("video/")) return null;
  if (kind === "audio" && !contentType.startsWith("audio/")) return null;
  return contentType;
}

function guardedUploadBody(
  body: ReadableStream<Uint8Array>,
  declaredSize: number,
  maxBytes: number,
) {
  let seen = 0;
  let reason: "too-large" | "size-mismatch" | null = null;
  const stream = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) {
          reason = "too-large";
          controller.error(new Error("Upload exceeds the allowed size"));
          return;
        }
        if (seen > declaredSize) {
          reason = "size-mismatch";
          controller.error(new Error("Upload is larger than Content-Length"));
          return;
        }
        controller.enqueue(chunk);
      },
      flush(controller) {
        if (seen !== declaredSize) {
          reason = "size-mismatch";
          controller.error(new Error("Upload size does not match Content-Length"));
        }
      },
    }),
  );
  return { stream, reason: () => reason, bytesSeen: () => seen };
}

function fixedLengthUploadBody(stream: ReadableStream<Uint8Array>, size: number) {
  if (typeof FixedLengthStream === "undefined") {
    return { readable: stream, completion: Promise.resolve() };
  }
  const fixed = new FixedLengthStream(size);
  return { readable: fixed.readable, completion: stream.pipeTo(fixed.writable) };
}

const OPTIMIZABLE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);
const MAX_IMAGE_OPTIMIZE_BYTES = 20 * 1024 * 1024;

function skipImageOptimize(request: Request) {
  return request.headers.get("x-bento-skip-image-optimize") === "1";
}

async function readUploadBytes(stream: ReadableStream<Uint8Array>, size: number) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > size) return null;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total !== size) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readPrefix(stream: ReadableStream<Uint8Array>, max: number) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(Math.min(total, max));
  let offset = 0;
  for (const chunk of chunks) {
    const slice = chunk.subarray(0, bytes.length - offset);
    bytes.set(slice, offset);
    offset += slice.byteLength;
    if (offset >= bytes.length) break;
  }
  return bytes;
}

function imageStream(bytes: Uint8Array) {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return new Response(copy).body!;
}

async function optimizeImageForStorage(
  env: StorageEnv,
  bytes: Uint8Array,
  contentType: string,
  kind: string,
  workspaceId: string,
) {
  const unchanged = { bytes, contentType };
  if (
    !env.IMAGES ||
    !OPTIMIZABLE_IMAGE_TYPES.has(contentType) ||
    isAnimatedImage(bytes, contentType)
  ) {
    return unchanged;
  }
  try {
    await reserveProviderUsage("image_transformations", 1, { workspaceId });
    const max = imageUploadMaxDimension(kind);
    const transformed = await env.IMAGES.input(imageStream(bytes))
      .transform({ width: max, height: max, fit: "scale-down" })
      .output({ format: "image/webp", quality: 82 });
    const response = transformed.response();
    if (!response.ok || !response.body) throw new Error("Image optimize failed");
    const output = new Uint8Array(await response.arrayBuffer());
    if (!output.byteLength) throw new Error("Image optimize returned an empty file");
    return { bytes: output, contentType: "image/webp" };
  } catch (error) {
    console.warn("[storage] image optimize failed; storing original", error);
    return unchanged;
  }
}

export async function sumR2UserStorageBytes(bucket: R2Bucket, userId: string) {
  let total = 0;
  for (const prefix of [`users/${userId}/`, `private/users/${userId}/`]) {
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix, limit: 1_000, cursor });
      for (const object of page.objects) total += object.size;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  return total;
}

async function resolveUploadUser(
  request: Request,
  env: StorageEnv,
  dependencies: StorageDependencies,
) {
  try {
    return await (dependencies.authenticate ?? authenticateUpload)(request, env);
  } catch {
    return null;
  }
}

async function resolveUploadPlan(userId: string, dependencies: StorageDependencies) {
  if (dependencies.getPlan) return dependencies.getPlan(userId);
  if (dependencies.isPro) return (await dependencies.isPro(userId)) ? "store" : "free";
  return getPlan(userId);
}

async function resolveStorageAllowance(userId: string, dependencies: StorageDependencies) {
  return (dependencies.getStorageAllowanceMb ?? getStorageAllowanceMb)(userId);
}

async function assertUploadQuota(
  env: StorageEnv,
  context: StorageContext,
  userId: string,
  plan: PlanId,
  storageAllowanceMb: number,
  kind: UploadKind,
  declaredSize: number,
) {
  if (kind === "avatar") return null;
  const storageLimit = storageAllowanceMb * 1024 * 1024;
  const storageLabel =
    storageAllowanceMb >= 1024 ? `${storageAllowanceMb / 1024} GB` : `${storageAllowanceMb} MB`;
  try {
    const usedBytes = await Promise.race([
      cachedR2UserStorageBytes(env.MEDIA_BUCKET, userId, sumR2UserStorageBytes),
      new Promise<number>((_, reject) => {
        setTimeout(() => reject(new Error("storage-quota-timeout")), 4_000);
      }),
    ]);
    if (usedBytes + declaredSize > storageLimit) {
      context.waitUntil(
        captureServerEvent(
          userId,
          "storage_capacity_blocked",
          {
            plan,
            used_bytes: usedBytes,
            storage_allowance_mb: storageAllowanceMb,
            attempted_upload_bytes: declaredSize,
          },
          env,
        ),
      );
      return jsonError(
        `You've reached your ${storageLabel} of storage.${plan === "free" ? " Upgrade to Store for 10 GB." : " Manage storage or add capacity in Billing."}`,
        413,
      );
    }
  } catch (error) {
    console.warn("[storage] quota check skipped", {
      userId,
      reason: error instanceof Error ? error.message : "unknown",
    });
    return jsonError("Storage usage is temporarily unavailable. Please try again.", 503);
  }
  return null;
}

function objectKeyForUpload(
  userId: string,
  kind: UploadKind,
  extension: string,
  multipartSize?: number,
) {
  const prefix =
    kind === "avatar"
      ? `avatars/${userId}`
      : kind === "agent_file"
        ? `private/users/${userId}/agent`
        : kind === "product_file"
          ? `private/users/${userId}/store`
          : `users/${userId}/${kind}`;
  return `${prefix}/${Date.now()}-${crypto.randomUUID()}${multipartSize ? `-mpu-${multipartSize}` : ""}.${extension}`;
}

function multipartUploadMetadata(key: string) {
  const match = key.match(/-mpu-([1-9]\d{0,15})\.([a-z0-9]{1,5})$/);
  if (!match) return null;
  const size = Number(match[1]);
  if (!Number.isSafeInteger(size)) return null;
  const partCount = Math.ceil(size / MULTIPART_PART_BYTES);
  return { size, extension: match[2], partCount };
}

function userOwnsObjectKey(userId: string, key: string) {
  return (
    key.startsWith(`users/${userId}/`) ||
    key.startsWith(`avatars/${userId}/`) ||
    key.startsWith(`private/users/${userId}/`)
  );
}

function isManageableObjectKey(userId: string, value: unknown): value is string {
  if (typeof value !== "string" || value.length > 1_024) return false;
  const key = validateMediaObjectKey(value);
  return Boolean(
    key &&
    userOwnsObjectKey(userId, key) &&
    !key.startsWith(`avatars/${userId}/`) &&
    !key.startsWith(`users/${userId}/avatar/`),
  );
}

async function createMultipartUpload(
  request: Request,
  env: StorageEnv,
  context: StorageContext,
  dependencies: StorageDependencies,
) {
  const kindHeader = request.headers.get("x-bento-upload-kind");
  const extension = sanitizeFileExtension(request.headers.get("x-bento-file-extension"));
  if (!isUploadKind(kindHeader) || !extension) return jsonError("Invalid upload metadata", 400);
  const contentType = validateContentType(
    kindHeader,
    request.headers.get("content-type"),
    extension,
  );
  if (!contentType) return jsonError("This file type is not allowed", 415);
  const declaredSize = Number(request.headers.get("x-bento-file-size"));
  if (!Number.isSafeInteger(declaredSize) || declaredSize <= 0) {
    return jsonError("A valid file size is required", 411);
  }

  const userId = await resolveUploadUser(request, env, dependencies);
  if (!userId) return jsonError("Unauthorized", 401);
  if (env.UPLOAD_RATE_LIMITER) {
    const outcome = await env.UPLOAD_RATE_LIMITER.limit({ key: userId });
    if (!outcome.success) return jsonError("Upload rate limit exceeded", 429);
  }

  const plan = await resolveUploadPlan(userId, dependencies);
  const maxBytes = uploadLimitMb(kindHeader, plan) * 1024 * 1024;
  if (declaredSize > maxBytes) {
    const assetLabel =
      kindHeader === "video" || kindHeader === "audio"
        ? "Videos"
        : kindHeader === "product_file" || kindHeader === "file"
          ? "Files"
          : "Images";
    return jsonError(
      `${assetLabel} on the ${planName(plan)} plan are limited to ${uploadLimitMb(kindHeader, plan)} MB`,
      413,
    );
  }
  const storageAllowanceMb =
    kindHeader === "avatar" ? 0 : await resolveStorageAllowance(userId, dependencies);
  const quotaError = await assertUploadQuota(
    env,
    context,
    userId,
    plan,
    storageAllowanceMb,
    kindHeader,
    declaredSize,
  );
  if (quotaError) return quotaError;

  const key = objectKeyForUpload(userId, kindHeader, extension, declaredSize);
  const originalFilename = sanitizeOriginalFilename(request.headers.get("x-bento-file-name"));
  const disposition = ["file", "product_file", "agent_file"].includes(kindHeader)
    ? `attachment; filename="download.${extension}"`
    : undefined;
  const multipart = await env.MEDIA_BUCKET.createMultipartUpload(key, {
    httpMetadata: {
      contentType,
      cacheControl: ["product_file", "agent_file"].includes(kindHeader)
        ? "private, no-store"
        : IMMUTABLE_CACHE_CONTROL,
      contentDisposition: disposition,
    },
    customMetadata: {
      userId,
      kind: kindHeader,
      size: String(declaredSize),
      ...(originalFilename ? { originalFilename } : {}),
    },
  });
  return Response.json({
    key: multipart.key,
    uploadId: multipart.uploadId,
    publicUrl: ["product_file", "agent_file"].includes(kindHeader)
      ? null
      : mediaObjectUrl(key, new URL(request.url).origin),
  });
}

async function uploadMultipartPart(
  request: Request,
  env: StorageEnv,
  dependencies: StorageDependencies,
) {
  const url = new URL(request.url);
  const key = validateMediaObjectKey(url.searchParams.get("key") ?? "");
  const uploadId = url.searchParams.get("uploadId")?.trim();
  const partNumber = Number(url.searchParams.get("partNumber"));
  const metadata = key ? multipartUploadMetadata(key) : null;
  if (
    !key ||
    !metadata ||
    !uploadId ||
    !Number.isInteger(partNumber) ||
    partNumber < 1 ||
    partNumber > metadata.partCount
  ) {
    return jsonError("Invalid multipart part metadata", 400);
  }
  if (!request.body) return jsonError("Upload body is required", 400);

  const expectedSize =
    partNumber === metadata.partCount
      ? metadata.size - (metadata.partCount - 1) * MULTIPART_PART_BYTES
      : MULTIPART_PART_BYTES;
  const declaredSize = Number(request.headers.get("x-bento-file-size"));
  const transportSizeHeader = request.headers.get("content-length");
  if (
    !Number.isSafeInteger(declaredSize) ||
    declaredSize !== expectedSize ||
    (transportSizeHeader !== null && Number(transportSizeHeader) !== expectedSize)
  ) {
    return jsonError("Upload part size does not match the declared upload", 400);
  }

  const userId = await resolveUploadUser(request, env, dependencies);
  if (!userId) return jsonError("Unauthorized", 401);
  if (!userOwnsObjectKey(userId, key)) return jsonError("Unauthorized", 401);
  if (env.UPLOAD_RATE_LIMITER) {
    const outcome = await env.UPLOAD_RATE_LIMITER.limit({ key: `${userId}:part` });
    if (!outcome.success) return jsonError("Upload rate limit exceeded", 429);
  }

  const inspectedBody =
    partNumber === 1
      ? await inspectUploadBody(request.body, "application/octet-stream", metadata.extension)
      : request.body;
  if (!inspectedBody) return jsonError("File contents do not match the declared file type", 415);

  const guarded = guardedUploadBody(inspectedBody, expectedSize, expectedSize);
  const fixed = fixedLengthUploadBody(guarded.stream, expectedSize);
  try {
    const multipart = env.MEDIA_BUCKET.resumeMultipartUpload(key, uploadId);
    const [uploaded] = await Promise.all([
      multipart.uploadPart(partNumber, fixed.readable),
      fixed.completion,
    ]);
    return Response.json({ etag: uploaded.etag, partNumber: uploaded.partNumber });
  } catch (error) {
    console.error("[storage] multipart part failed", {
      key,
      partNumber,
      message: error instanceof Error ? error.message : "unknown",
    });
    if (guarded.reason()) {
      return jsonError("Upload part size does not match the declared upload", 400);
    }
    return jsonError("Upload part could not be stored. Please try again.", 500);
  }
}

async function abortMultipartUpload(
  request: Request,
  env: StorageEnv,
  dependencies: StorageDependencies,
) {
  const url = new URL(request.url);
  const key = validateMediaObjectKey(url.searchParams.get("key") ?? "");
  const uploadId = url.searchParams.get("uploadId")?.trim();
  if (!key || !multipartUploadMetadata(key) || !uploadId || uploadId.length > 1024)
    return jsonError("Invalid multipart upload", 400);
  const userId = await resolveUploadUser(request, env, dependencies);
  if (!userId || !userOwnsObjectKey(userId, key)) return jsonError("Unauthorized", 401);
  if (env.UPLOAD_RATE_LIMITER) {
    const outcome = await env.UPLOAD_RATE_LIMITER.limit({ key: `${userId}:abort` });
    if (!outcome.success) return jsonError("Upload rate limit exceeded", 429);
  }
  try {
    await env.MEDIA_BUCKET.resumeMultipartUpload(key, uploadId).abort();
    return Response.json({ aborted: true });
  } catch {
    return jsonError("The unfinished upload could not be canceled", 500);
  }
}

async function completeMultipartUpload(
  request: Request,
  env: StorageEnv,
  context: StorageContext,
  dependencies: StorageDependencies,
) {
  const url = new URL(request.url);
  const key = validateMediaObjectKey(url.searchParams.get("key") ?? "");
  const uploadId = url.searchParams.get("uploadId")?.trim();
  const metadata = key ? multipartUploadMetadata(key) : null;
  if (!key || !metadata || !uploadId) {
    return jsonError("Invalid multipart completion metadata", 400);
  }

  const userId = await resolveUploadUser(request, env, dependencies);
  if (!userId) return jsonError("Unauthorized", 401);
  if (!userOwnsObjectKey(userId, key)) return jsonError("Unauthorized", 401);

  let body: unknown;
  try {
    body = JSON.parse(await readRequestText(request, MAX_MULTIPART_COMPLETE_BODY_BYTES));
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return jsonError("Multipart completion body is too large", 413);
    }
    return jsonError("Invalid multipart completion body", 400);
  }
  const candidateParts =
    body && typeof body === "object" && Array.isArray((body as { parts?: unknown }).parts)
      ? (body as { parts: unknown[] }).parts
      : null;
  if (!candidateParts || candidateParts.length !== metadata.partCount) {
    return jsonError("All uploaded parts must be provided exactly once", 400);
  }
  const parts = candidateParts
    .map((part) => {
      if (!part || typeof part !== "object") return null;
      const etag = (part as { etag?: unknown }).etag;
      const partNumber = (part as { partNumber?: unknown }).partNumber;
      if (typeof etag !== "string" || !etag || etag.length > 256 || !Number.isInteger(partNumber)) {
        return null;
      }
      return { etag, partNumber: partNumber as number };
    })
    .sort((left, right) => (left?.partNumber ?? 0) - (right?.partNumber ?? 0));
  if (parts.some((part, index) => !part || part.partNumber !== index + 1)) {
    return jsonError("All uploaded parts must be provided exactly once", 400);
  }

  try {
    // A lost completion response must not make a successfully stored upload
    // appear failed or increment its usage twice.
    const existing = await env.MEDIA_BUCKET.head(key);
    if (
      existing &&
      (existing.size === metadata.size || existing.customMetadata?.imageOptimized === "1")
    ) {
      return Response.json(
        {
          key,
          size: existing.size,
          publicUrl: key.startsWith("private/")
            ? null
            : mediaObjectUrl(key, new URL(request.url).origin),
        },
        { status: 200 },
      );
    }
    // Uploads can remain unfinished for hours. Recheck after other files or a
    // plan change have consumed the allowance since mpu-create.
    const segments = key.split("/");
    const kind = key.startsWith("private/")
      ? segments[3] === "agent"
        ? "agent_file"
        : "product_file"
      : key.startsWith("avatars/")
        ? "avatar"
        : segments[2];
    if (!isUploadKind(kind)) return jsonError("Invalid upload kind", 400);
    const plan = await resolveUploadPlan(userId, dependencies);
    if (metadata.size > uploadLimitMb(kind, plan) * 1024 * 1024) {
      return jsonError(
        `This file exceeds the current plan's ${uploadLimitMb(kind, plan)} MB upload limit`,
        413,
      );
    }
    const quotaError = await assertUploadQuota(
      env,
      context,
      userId,
      plan,
      kind === "avatar" ? 0 : await resolveStorageAllowance(userId, dependencies),
      kind,
      metadata.size,
    );
    if (quotaError) return quotaError;
    const multipart = env.MEDIA_BUCKET.resumeMultipartUpload(key, uploadId);
    const object = await multipart.complete(parts as R2UploadedPart[]);
    if (object.size !== metadata.size) {
      await env.MEDIA_BUCKET.delete(key).catch(() => undefined);
      return jsonError("Completed upload size does not match the declared upload", 400);
    }
    let storedSize = object.size;
    if (
      env.IMAGES &&
      (kind === "avatar" || kind === "image" || kind === "cover") &&
      !skipImageOptimize(request) &&
      object.size <= MAX_IMAGE_OPTIMIZE_BYTES
    ) {
      const current = await env.MEDIA_BUCKET.get(key);
      const currentType = (current?.httpMetadata?.contentType || "").split(";", 1)[0].toLowerCase();
      if (current?.body && OPTIMIZABLE_IMAGE_TYPES.has(currentType)) {
        const source = new Uint8Array(await new Response(current.body).arrayBuffer());
        const optimized = await optimizeImageForStorage(env, source, currentType, kind, userId);
        if (
          optimized.contentType !== currentType ||
          optimized.bytes.byteLength !== source.byteLength
        ) {
          const replaced = await env.MEDIA_BUCKET.put(key, optimized.bytes, {
            httpMetadata: {
              contentType: optimized.contentType,
              cacheControl: IMMUTABLE_CACHE_CONTROL,
            },
            customMetadata: { ...(current.customMetadata ?? {}), imageOptimized: "1" },
          });
          storedSize = replaced?.size ?? optimized.bytes.byteLength;
        }
      }
    }
    await adjustCachedR2UserStorageBytes(userId, storedSize).catch((error) =>
      console.error("[storage] usage cache update failed", error),
    );
    const isPrivate = key.startsWith("private/");
    return Response.json(
      {
        key: object.key,
        publicUrl: isPrivate ? null : mediaObjectUrl(object.key, new URL(request.url).origin),
        size: storedSize,
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("[storage] multipart complete failed", {
      key,
      message: error instanceof Error ? error.message : "unknown",
    });
    return jsonError("Upload could not be completed. Please try again.", 500);
  }
}

async function uploadMedia(
  request: Request,
  env: StorageEnv,
  context: StorageContext,
  dependencies: StorageDependencies,
) {
  const kindHeader = request.headers.get("x-bento-upload-kind");
  const extension = sanitizeFileExtension(request.headers.get("x-bento-file-extension"));
  if (!isUploadKind(kindHeader) || !extension) return jsonError("Invalid upload metadata", 400);

  const contentType = validateContentType(
    kindHeader,
    request.headers.get("content-type"),
    extension,
  );
  if (!contentType) return jsonError("This file type is not allowed", 415);
  const declaredSize = Number(request.headers.get("x-bento-file-size"));
  if (!Number.isSafeInteger(declaredSize) || declaredSize <= 0) {
    return jsonError("A valid file size is required", 411);
  }
  const transportSizeHeader = request.headers.get("content-length");
  if (transportSizeHeader !== null) {
    const transportSize = Number(transportSizeHeader);
    if (!Number.isSafeInteger(transportSize) || transportSize !== declaredSize) {
      return jsonError("Upload size does not match the file size", 400);
    }
  }
  if (!request.body) return jsonError("Upload body is required", 400);

  const userId = await resolveUploadUser(request, env, dependencies);
  if (!userId) return jsonError("Unauthorized", 401);

  if (env.UPLOAD_RATE_LIMITER) {
    const outcome = await env.UPLOAD_RATE_LIMITER.limit({ key: userId });
    if (!outcome.success) return jsonError("Upload rate limit exceeded", 429);
  }

  const plan = await resolveUploadPlan(userId, dependencies);
  const maxBytes = uploadLimitMb(kindHeader, plan) * 1024 * 1024;
  if (declaredSize > maxBytes) {
    const assetLabel =
      kindHeader === "video" || kindHeader === "audio"
        ? "Videos"
        : kindHeader === "product_file" || kindHeader === "file"
          ? "Files"
          : "Images";
    return jsonError(
      `${assetLabel} on the ${planName(plan)} plan are limited to ${uploadLimitMb(kindHeader, plan)} MB`,
      413,
    );
  }

  const storageAllowanceMb =
    kindHeader === "avatar" ? 0 : await resolveStorageAllowance(userId, dependencies);
  const quotaError = await assertUploadQuota(
    env,
    context,
    userId,
    plan,
    storageAllowanceMb,
    kindHeader,
    declaredSize,
  );
  if (quotaError) return quotaError;

  const originalFilename = sanitizeOriginalFilename(request.headers.get("x-bento-file-name"));
  const disposition = ["file", "product_file", "agent_file"].includes(kindHeader)
    ? `attachment; filename="download.${extension}"`
    : undefined;
  const inspectedBody = await inspectUploadBody(request.body, contentType, extension);
  if (!inspectedBody) return jsonError("File contents do not match the declared file type", 415);

  const shouldOptimizeUpload =
    Boolean(env.IMAGES) &&
    (kindHeader === "avatar" || kindHeader === "image" || kindHeader === "cover") &&
    OPTIMIZABLE_IMAGE_TYPES.has(contentType) &&
    !skipImageOptimize(request);
  const guarded = guardedUploadBody(inspectedBody, declaredSize, maxBytes);
  let storedBytes = guarded.stream;
  let storedSize = declaredSize;
  let storedType = contentType;
  let storedExtension = extension;
  if (shouldOptimizeUpload) {
    let source: Uint8Array | null;
    try {
      source = await readUploadBytes(guarded.stream, declaredSize);
    } catch (error) {
      console.error("[storage] single upload failed", {
        reason: guarded.reason(),
        message: error instanceof Error ? error.message : "unknown",
      });
      if (guarded.reason() === "too-large")
        return jsonError("Upload exceeds the allowed size", 413);
      if (guarded.reason() === "size-mismatch") {
        return jsonError("Upload size does not match the file size", 400);
      }
      return jsonError("Upload could not be stored. Please try again.", 500);
    }
    if (!source || guarded.bytesSeen() !== declaredSize) {
      return jsonError("Upload size does not match the file size", 400);
    }
    const optimized = await optimizeImageForStorage(env, source, contentType, kindHeader, userId);
    storedBytes = imageStream(optimized.bytes);
    storedSize = optimized.bytes.byteLength;
    storedType = optimized.contentType;
    storedExtension = optimized.contentType === "image/webp" ? "webp" : extension;
  }
  const key = objectKeyForUpload(userId, kindHeader, storedExtension);
  const fixed = fixedLengthUploadBody(storedBytes, storedSize);
  let object: R2Object | null;
  try {
    [object] = await Promise.all([
      env.MEDIA_BUCKET.put(key, fixed.readable, {
        httpMetadata: {
          contentType: storedType,
          cacheControl: ["product_file", "agent_file"].includes(kindHeader)
            ? "private, no-store"
            : IMMUTABLE_CACHE_CONTROL,
          contentDisposition: disposition,
        },
        customMetadata: {
          userId,
          kind: kindHeader,
          ...(originalFilename ? { originalFilename } : {}),
        },
      }),
      fixed.completion,
    ]);
  } catch (error) {
    console.error("[storage] single upload failed", {
      key,
      reason: guarded.reason(),
      message: error instanceof Error ? error.message : "unknown",
    });
    if (guarded.reason() === "too-large") {
      return jsonError("Upload exceeds the allowed size", 413);
    }
    if (guarded.reason() === "size-mismatch") {
      return jsonError("Upload size does not match the file size", 400);
    }
    return jsonError("Upload could not be stored. Please try again.", 500);
  }
  if (!object) return jsonError("Upload could not be stored", 500);
  if (
    object.size !== storedSize ||
    (!shouldOptimizeUpload && guarded.bytesSeen() !== declaredSize)
  ) {
    await env.MEDIA_BUCKET.delete(key).catch(() => undefined);
    return jsonError("Upload size does not match the file size", 400);
  }

  await adjustCachedR2UserStorageBytes(userId, object.size).catch((error) =>
    console.error("[storage] usage cache update failed", error),
  );

  return Response.json(
    {
      key,
      publicUrl: ["product_file", "agent_file"].includes(kindHeader)
        ? null
        : mediaObjectUrl(key, new URL(request.url).origin),
      size: object.size,
    },
    { status: 201 },
  );
}

function mediaHeaders(object: R2Object) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("content-length", String(object.size));
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", IMMUTABLE_CACHE_CONTROL);
  headers.set("access-control-allow-origin", "*");
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", "default-src 'none'; sandbox");
  headers.set("cross-origin-resource-policy", "cross-origin");
  headers.set("referrer-policy", "no-referrer");
  return headers;
}

async function serveMedia(request: Request, env: StorageEnv, context: StorageContext) {
  const url = new URL(request.url);
  let decodedKey: string;
  try {
    decodedKey = decodeURIComponent(url.pathname.slice(MEDIA_CDN_PATH.length));
  } catch {
    return new Response("Invalid media path", { status: 400 });
  }
  const key = validateMediaObjectKey(decodedKey);
  if (!key) return new Response("Invalid media path", { status: 400 });
  if (key.startsWith("private/")) return new Response("Not found", { status: 404 });

  if (request.method === "HEAD") {
    const object = await env.MEDIA_BUCKET.head(key);
    return object
      ? new Response(null, { headers: mediaHeaders(object) })
      : new Response("Not found", { status: 404 });
  }

  // Video previews and playback request small byte ranges. Serving the entire file here
  // would download large videos just to show a frame in Settings.
  const requestedRange = request.headers.get("range");
  if (requestedRange) {
    const head = await env.MEDIA_BUCKET.head(key);
    if (!head) return new Response("Not found", { status: 404 });
    const match = /^bytes=(\d*)-(\d*)$/.exec(requestedRange);
    const start = match?.[1]
      ? Number(match[1])
      : match?.[2]
        ? Math.max(0, head.size - Number(match[2]))
        : NaN;
    const requestedEnd = match?.[1] && match[2] ? Number(match[2]) : head.size - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(requestedEnd) ||
      start < 0 ||
      start >= head.size ||
      requestedEnd < start
    ) {
      return new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${head.size}` },
      });
    }
    const end = Math.min(requestedEnd, head.size - 1, start + 1024 * 1024 - 1);
    const object = await env.MEDIA_BUCKET.get(key, {
      range: { offset: start, length: end - start + 1 },
    });
    if (!object) return new Response("Not found", { status: 404 });
    const headers = mediaHeaders(object);
    headers.set("content-length", String(end - start + 1));
    headers.set("content-range", `bytes ${start}-${end}/${head.size}`);
    return new Response(object.body, { status: 206, headers });
  }

  const widthParam = url.searchParams.get("w");
  const requestedWidth = Number(widthParam);
  const allowedWidths = [320, 512, 640, 1280];
  const explicitWidth =
    env.IMAGES && widthParam !== null && allowedWidths.includes(requestedWidth)
      ? requestedWidth
      : null;
  const cache = typeof caches === "undefined" ? null : await caches.open("bento-media-v2");
  const cacheRequest = (search: string) => {
    const cacheUrl = new URL(request.url);
    cacheUrl.search = search;
    return new Request(cacheUrl.toString(), { method: "GET" });
  };
  if (explicitWidth) {
    const cached = await cache?.match(cacheRequest(`?w=${explicitWidth}`));
    if (cached) return cached;
  } else if (!widthParam) {
    const cached = await cache?.match(cacheRequest(""));
    if (cached) return cached;
  }

  const object = await env.MEDIA_BUCKET.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  const headers = mediaHeaders(object);
  const image = /^image\/(?:png|jpeg|webp)$/i.test(headers.get("content-type") ?? "");
  const autoWidth =
    !widthParam && env.IMAGES && image && object.size > 300 * 1024
      ? key.startsWith("avatars/")
        ? 512
        : 1280
      : null;
  if (autoWidth) {
    const cached = await cache?.match(cacheRequest(`?w=${autoWidth}`));
    if (cached) return cached;
  }
  const variantWidth = explicitWidth ?? autoWidth;
  if (variantWidth && image && object.body) {
    const [peek, rest] = object.body.tee();
    const prefix = await readPrefix(peek, 65_536);
    if (isAnimatedImage(prefix, headers.get("content-type") ?? "")) {
      await rest.cancel().catch(() => undefined);
      const original = await env.MEDIA_BUCKET.get(key);
      if (!original) return new Response("Not found", { status: 404 });
      return new Response(original.body, { headers: mediaHeaders(original) });
    }
    try {
      await reserveProviderUsage("image_transformations");
      const transformed = await env
        .IMAGES!.input(rest)
        .transform({ width: variantWidth, fit: "scale-down" })
        .output({ format: "image/webp", quality: 82 });
      const transformedResponse = transformed.response();
      if (!transformedResponse.ok || !transformedResponse.body)
        throw new Error("Image resize failed");
      headers.delete("content-length");
      headers.delete("etag");
      headers.set("content-type", "image/webp");
      const response = new Response(transformedResponse.body, { headers });
      if (cache) {
        const writes = [cache.put(cacheRequest(`?w=${variantWidth}`), response.clone())];
        if (autoWidth) writes.push(cache.put(cacheRequest(""), response.clone()));
        context.waitUntil(Promise.all(writes));
      }
      return response;
    } catch (error) {
      console.warn("[media] Image resize failed; serving original", error);
      const original = await env.MEDIA_BUCKET.get(key);
      if (!original) return new Response("Not found", { status: 404 });
      return new Response(original.body, { headers: mediaHeaders(original) });
    }
  }
  const response = new Response(object.body, { headers });
  if (cache && !widthParam) context.waitUntil(cache.put(cacheRequest(""), response.clone()));
  return response;
}

const STORAGE_PREFIXES = ["public", "private"] as const;
type StoragePrefix = (typeof STORAGE_PREFIXES)[number];
type StorageSort = { key: "uploaded" | "size"; direction: "asc" | "desc" };
const MAX_STORAGE_SORT_OBJECTS = 10_000;

class StorageSortLimitError extends Error {}

function storagePrefix(userId: string, scope: StoragePrefix) {
  return scope === "public" ? `users/${userId}/` : `private/users/${userId}/`;
}

function parseStorageCursor(value: string | null) {
  if (!value) return { scope: "public" as const, cursor: undefined };
  const separator = value.indexOf(":");
  const scope = (separator === -1 ? value : value.slice(0, separator)) as StoragePrefix;
  if (!STORAGE_PREFIXES.includes(scope)) return null;
  const cursor = separator === -1 ? undefined : value.slice(separator + 1);
  if (separator !== -1 && !cursor) return null;
  return { scope, cursor };
}

function storageObjectRow(object: R2Object, scope: StoragePrefix, origin: string) {
  return {
    key: object.key,
    name: object.customMetadata?.originalFilename || object.key.split("/").at(-1) || "File",
    type:
      object.customMetadata?.kind || object.httpMetadata?.contentType || "application/octet-stream",
    size: object.size,
    uploaded: object.uploaded.toISOString(),
    publicUrl: scope === "private" ? null : mediaObjectUrl(object.key, origin),
  };
}

function parseStorageSort(url: URL): StorageSort | null | undefined {
  const key = url.searchParams.get("sort");
  const direction = url.searchParams.get("direction");
  if (!key && !direction) return undefined;
  if ((key !== "uploaded" && key !== "size") || (direction !== "asc" && direction !== "desc")) {
    return null;
  }
  return { key, direction };
}

function encodeSortedStorageCursor(sort: StorageSort, offset: number) {
  return btoa(JSON.stringify({ ...sort, offset }));
}

function parseSortedStorageCursor(value: string | null, sort: StorageSort) {
  if (!value) return 0;
  try {
    const parsed = JSON.parse(atob(value)) as Partial<StorageSort> & { offset?: unknown };
    return parsed.key === sort.key &&
      parsed.direction === sort.direction &&
      Number.isInteger(parsed.offset) &&
      Number(parsed.offset) >= 0
      ? Number(parsed.offset)
      : null;
  } catch {
    return null;
  }
}

async function listSortedManagedObjects(
  request: Request,
  bucket: R2Bucket,
  userId: string,
  sort: StorageSort,
) {
  const url = new URL(request.url);
  const offset = parseSortedStorageCursor(url.searchParams.get("cursor"), sort);
  if (offset === null) return null;
  const objects: ReturnType<typeof storageObjectRow>[] = [];

  // ponytail: bounded full scan; add a durable metadata index if workspaces exceed 10,000 objects.
  for (const scope of STORAGE_PREFIXES) {
    let cursor: string | undefined;
    do {
      const page = await bucket.list({
        prefix: storagePrefix(userId, scope),
        limit: 1_000,
        cursor,
        include: ["httpMetadata", "customMetadata"],
      });
      objects.push(...page.objects.map((object) => storageObjectRow(object, scope, url.origin)));
      if (objects.length > MAX_STORAGE_SORT_OBJECTS) {
        throw new StorageSortLimitError("Too many files to sort");
      }
      cursor = page.truncated ? page.cursor : undefined;
      if (page.truncated && !cursor) throw new Error("R2 returned an invalid storage cursor");
    } while (cursor);
  }

  const direction = sort.direction === "asc" ? 1 : -1;
  objects.sort((left, right) => {
    const leftValue = sort.key === "size" ? left.size : Date.parse(left.uploaded);
    const rightValue = sort.key === "size" ? right.size : Date.parse(right.uploaded);
    return direction * (leftValue - rightValue) || left.key.localeCompare(right.key);
  });
  const page = objects.slice(offset, offset + MAX_STORAGE_PAGE_OBJECTS);
  const nextOffset = offset + page.length;
  return {
    objects: page,
    cursor: nextOffset < objects.length ? encodeSortedStorageCursor(sort, nextOffset) : null,
  };
}

async function listManagedObjects(request: Request, bucket: R2Bucket, userId: string) {
  const sort = parseStorageSort(new URL(request.url));
  if (sort === null) return null;
  if (sort) return listSortedManagedObjects(request, bucket, userId, sort);
  const parsedCursor = parseStorageCursor(new URL(request.url).searchParams.get("cursor"));
  if (!parsedCursor) return null;
  const objects: Array<{
    key: string;
    name: string;
    type: string;
    size: number;
    uploaded: string;
    publicUrl: string | null;
  }> = [];
  let scopeIndex = STORAGE_PREFIXES.indexOf(parsedCursor.scope);
  let cursor = parsedCursor.cursor;
  let nextCursor: string | null = null;

  while (objects.length < MAX_STORAGE_PAGE_OBJECTS && scopeIndex < STORAGE_PREFIXES.length) {
    const scope = STORAGE_PREFIXES[scopeIndex];
    const page = await bucket.list({
      prefix: storagePrefix(userId, scope),
      limit: MAX_STORAGE_PAGE_OBJECTS - objects.length,
      cursor,
      include: ["httpMetadata", "customMetadata"],
    });
    objects.push(
      ...page.objects.map((object) => storageObjectRow(object, scope, new URL(request.url).origin)),
    );
    if (page.truncated) {
      nextCursor = `${scope}:${page.cursor}`;
      break;
    }
    scopeIndex += 1;
    cursor = undefined;
    if (objects.length === MAX_STORAGE_PAGE_OBJECTS && scopeIndex < STORAGE_PREFIXES.length) {
      nextCursor = STORAGE_PREFIXES[scopeIndex];
    }
  }
  return { objects, cursor: nextCursor };
}

async function manageStorage(
  request: Request,
  env: StorageEnv,
  context: StorageContext,
  dependencies: StorageDependencies,
) {
  const userId = await resolveUploadUser(request, env, dependencies);
  if (!userId) return jsonError("Unauthorized", 401);
  if (env.UPLOAD_RATE_LIMITER) {
    const outcome = await env.UPLOAD_RATE_LIMITER.limit({
      key: `${userId}:manage:${request.method.toLowerCase()}`,
    });
    if (!outcome.success) return jsonError("Storage management rate limit exceeded", 429);
  }

  if (request.method === "GET") {
    try {
      const [page, usedBytes, allowanceMb] = await Promise.all([
        listManagedObjects(request, env.MEDIA_BUCKET, userId),
        cachedR2UserStorageBytes(env.MEDIA_BUCKET, userId, sumR2UserStorageBytes),
        resolveStorageAllowance(userId, dependencies),
      ]);
      if (!page) return jsonError("Invalid storage cursor", 400);
      return Response.json({
        ...page,
        usedBytes,
        allowedBytes: allowanceMb * 1024 * 1024,
      });
    } catch (error) {
      if (error instanceof StorageSortLimitError) return jsonError(error.message, 413);
      return jsonError("Storage could not be loaded. Please try again.", 500);
    }
  }

  let body: unknown;
  try {
    body = JSON.parse(await readRequestText(request, MAX_STORAGE_DELETE_BODY_BYTES));
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return jsonError("Storage deletion request is too large", 413);
    }
    return jsonError("Invalid storage deletion request", 400);
  }
  const keys =
    body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    Object.keys(body).length === 1 &&
    Array.isArray((body as { keys?: unknown }).keys)
      ? (body as { keys: unknown[] }).keys
      : null;
  if (
    !keys ||
    keys.length === 0 ||
    keys.length > MAX_STORAGE_PAGE_OBJECTS ||
    new Set(keys).size !== keys.length ||
    !keys.every((key) => isManageableObjectKey(userId, key))
  ) {
    return jsonError("Invalid storage deletion request", 400);
  }

  const results = await Promise.all(
    keys.map(async (key) => {
      try {
        const object = await env.MEDIA_BUCKET.head(key as string);
        await env.MEDIA_BUCKET.delete(key as string);
        return { key: key as string, deleted: true, size: object?.size ?? 0 };
      } catch {
        return { key: key as string, deleted: false, size: 0 };
      }
    }),
  );
  const deletedKeys = results.filter((result) => result.deleted).map((result) => result.key);
  const failedKeys = results.filter((result) => !result.deleted).map((result) => result.key);
  const freedBytes = results.reduce(
    (total, result) => total + (result.deleted ? result.size : 0),
    0,
  );
  if (freedBytes > 0)
    await adjustCachedR2UserStorageBytes(userId, -freedBytes).catch((error) =>
      console.error("[storage] usage cache update failed", error),
    );
  context.waitUntil(
    captureServerEvent(
      userId,
      "storage_objects_deleted",
      {
        deleted_count: deletedKeys.length,
        failed_count: failedKeys.length,
        freed_bytes: freedBytes,
      },
      env,
    ),
  );
  return Response.json(
    { deletedKeys, failedKeys, freedBytes },
    { status: failedKeys.length ? 207 : 200 },
  );
}

export async function handleR2StorageRequest(
  request: Request,
  env: StorageEnv,
  context: StorageContext,
  dependencies: StorageDependencies = {},
) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/api/storage/manage") {
    if (!env.UPLOAD_RATE_LIMITER && (env.APP_ENV === "production" || env.APP_ENV === "staging")) {
      return jsonError("Storage security controls are unavailable", 503);
    }
    if (request.method !== "GET" && request.method !== "DELETE") {
      return jsonError("Method not allowed", 405);
    }
    return manageStorage(request, env, context, dependencies);
  }
  if (path === "/api/storage/upload") {
    if (!env.UPLOAD_RATE_LIMITER && (env.APP_ENV === "production" || env.APP_ENV === "staging")) {
      return jsonError("Upload security controls are unavailable", 503);
    }
    const action = url.searchParams.get("action");
    if (request.method === "POST" && action === "mpu-create") {
      return createMultipartUpload(request, env, context, dependencies);
    }
    if (request.method === "PUT" && action === "mpu-uploadpart") {
      return uploadMultipartPart(request, env, dependencies);
    }
    if (request.method === "POST" && action === "mpu-complete") {
      return completeMultipartUpload(request, env, context, dependencies);
    }
    if (request.method === "POST" && action === "mpu-abort") {
      return abortMultipartUpload(request, env, dependencies);
    }
    if (request.method === "PUT" && !action) {
      return uploadMedia(request, env, context, dependencies);
    }
    return jsonError("Method not allowed", 405);
  }
  if (path.startsWith(MEDIA_CDN_PATH)) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }
    return serveMedia(request, env, context);
  }
  return null;
}
