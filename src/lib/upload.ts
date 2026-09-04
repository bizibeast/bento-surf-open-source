import { supabase } from "@/integrations/supabase/client";
import { optimizeImageUpload, type OptimizableImageKind } from "@/lib/image-upload";

type UploadKind = "avatar" | "image" | "video" | "audio" | "file" | "cover" | "product_file";

/** Stay under Cloudflare's ~100MB request body limit with headroom. */
const MULTIPART_PART_BYTES = 8 * 1024 * 1024;
const MULTIPART_THRESHOLD_BYTES = 8 * 1024 * 1024;

function extensionFor(file: File) {
  const candidate = (file.name.split(".").pop() || "bin")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 5);
  return candidate || "bin";
}

function contentTypeForUpload(file: File, kind: UploadKind) {
  const typed = (file.type || "").split(";", 1)[0].trim().toLowerCase();
  if (typed && typed !== "application/octet-stream") return typed;
  const extension = extensionFor(file);
  if (kind === "video") {
    if (extension === "mov") return "video/quicktime";
    if (extension === "webm") return "video/webm";
    if (extension === "mp4" || extension === "m4v" || extension === "mpeg" || extension === "mpg") {
      return "video/mp4";
    }
  }
  if (kind === "image" || kind === "avatar" || kind === "cover") {
    if (extension === "png") return "image/png";
    if (extension === "gif") return "image/gif";
    if (extension === "webp") return "image/webp";
    if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  }
  if (kind === "file" || kind === "product_file") {
    if (extension === "pdf") return "application/pdf";
  }
  return typed || "application/octet-stream";
}

async function authToken() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  const token = data.session?.access_token;
  if (!token) throw new Error("Please sign in again before uploading");
  return token;
}

async function parseUploadError(response: Response) {
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  return payload?.error || `Upload failed (${response.status})`;
}

async function uploadSinglePut(file: File, kind: UploadKind, token: string, contentType: string) {
  let response: Response;
  try {
    response = await fetch("/api/storage/upload", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": contentType,
        "X-Bento-File-Extension": extensionFor(file),
        "X-Bento-File-Name": encodeURIComponent(file.name),
        "X-Bento-File-Size": String(file.size),
        "X-Bento-Upload-Kind": kind,
      },
      body: file,
      signal: AbortSignal.timeout(kind === "video" || kind === "audio" ? 10 * 60_000 : 120_000),
    });
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      throw new Error("Upload timed out. Try a smaller file or a stronger connection.");
    }
    throw error instanceof Error ? error : new Error("Upload failed");
  }
  const payload = (await response.json().catch(() => null)) as {
    key?: string;
    publicUrl?: string;
    size?: number;
    error?: string;
  } | null;
  if (!response.ok || !payload?.key || (kind !== "product_file" && !payload.publicUrl)) {
    throw new Error(payload?.error || `Upload failed (${response.status})`);
  }
  return {
    key: payload.key,
    publicUrl: payload.publicUrl ?? null,
    size: payload.size ?? file.size,
    name: file.name,
    mimeType: contentType,
  };
}

async function uploadMultipart(file: File, kind: UploadKind, token: string, contentType: string) {
  const createResponse = await fetch("/api/storage/upload?action=mpu-create", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": contentType,
      "X-Bento-File-Extension": extensionFor(file),
      "X-Bento-File-Name": encodeURIComponent(file.name),
      "X-Bento-File-Size": String(file.size),
      "X-Bento-Upload-Kind": kind,
    },
    signal: AbortSignal.timeout(30_000),
  });
  const created = (await createResponse.json().catch(() => null)) as {
    key?: string;
    uploadId?: string;
    publicUrl?: string | null;
    error?: string;
  } | null;
  if (!createResponse.ok || !created?.key || !created.uploadId) {
    throw new Error(created?.error || (await parseUploadError(createResponse)));
  }

  const parts: Array<{ etag: string; partNumber: number }> = [];
  const partCount = Math.ceil(file.size / MULTIPART_PART_BYTES);
  try {
    for (let index = 0; index < partCount; index += 1) {
      const start = index * MULTIPART_PART_BYTES;
      const end = Math.min(file.size, start + MULTIPART_PART_BYTES);
      const blob = file.slice(start, end);
      const partNumber = index + 1;
      const partUrl = `/api/storage/upload?action=mpu-uploadpart&key=${encodeURIComponent(created.key)}&uploadId=${encodeURIComponent(created.uploadId)}&partNumber=${partNumber}`;
      const partResponse = await fetch(partUrl, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          "X-Bento-File-Size": String(blob.size),
        },
        body: blob,
        signal: AbortSignal.timeout(5 * 60_000),
      });
      const uploaded = (await partResponse.json().catch(() => null)) as {
        etag?: string;
        partNumber?: number;
        error?: string;
      } | null;
      if (!partResponse.ok || !uploaded?.etag || !uploaded.partNumber) {
        throw new Error(
          uploaded?.error || `Upload part ${partNumber} failed (${partResponse.status})`,
        );
      }
      parts.push({ etag: uploaded.etag, partNumber: uploaded.partNumber });
    }

    const completeResponse = await fetch(
      `/api/storage/upload?action=mpu-complete&key=${encodeURIComponent(created.key)}&uploadId=${encodeURIComponent(created.uploadId)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ parts }),
        signal: AbortSignal.timeout(60_000),
      },
    );
    const completed = (await completeResponse.json().catch(() => null)) as {
      key?: string;
      publicUrl?: string | null;
      size?: number;
      error?: string;
    } | null;
    if (
      !completeResponse.ok ||
      !completed?.key ||
      (kind !== "product_file" && !completed.publicUrl)
    ) {
      throw new Error(completed?.error || `Upload failed (${completeResponse.status})`);
    }
    return {
      key: completed.key,
      publicUrl: completed.publicUrl ?? null,
      size: completed.size ?? file.size,
      name: file.name,
      mimeType: contentType,
    };
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      throw new Error("Upload timed out. Try a smaller file or a stronger connection.");
    }
    throw error instanceof Error ? error : new Error("Upload failed");
  }
}

export async function uploadFileResult(
  file: File,
  kind: UploadKind,
  options?: { optimize?: boolean },
) {
  const shouldOptimize = options?.optimize !== false && ["avatar", "image", "cover"].includes(kind);
  const preparedFile = shouldOptimize
    ? await optimizeImageUpload(file, kind as OptimizableImageKind)
    : file;
  const token = await authToken();
  const contentType = contentTypeForUpload(preparedFile, kind);
  const useMultipart =
    kind === "video" || kind === "audio" || preparedFile.size > MULTIPART_THRESHOLD_BYTES;

  if (useMultipart) {
    return uploadMultipart(preparedFile, kind, token, contentType);
  }
  return uploadSinglePut(preparedFile, kind, token, contentType);
}

export async function uploadFile(file: File, kind: Exclude<UploadKind, "product_file">) {
  const result = await uploadFileResult(file, kind);
  if (!result.publicUrl) throw new Error("Upload did not return a public URL");
  return result.publicUrl;
}
