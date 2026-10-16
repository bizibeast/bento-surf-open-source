import { reserveProviderUsage } from "./provider-budget.server";
/* eslint-disable @typescript-eslint/no-explicit-any -- Ingestion rows are normalized at this boundary. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getMediaBucket, mediaObjectUrl, sumR2UserStorageBytes } from "./r2-storage.server";
import { adjustCachedR2UserStorageBytes, cachedR2UserStorageBytes } from "./r2-usage-cache.server";
import { getPlan, getStorageAllowanceMb } from "./plan.server";
import { uploadLimitMb } from "./plans";
import { readResponseBytes, readResponseText } from "./request-security.server";
import { allowedSocialAssetUrl } from "./social-avatar.server";
import { accessTokenForConnection, ProviderError } from "./social-publisher.server";
import { parsePublicHttpUrl } from "./safe-url";
import { BRAIN_MEDIA_BUDGET_BYTES } from "./content-media";
import type { SocialProvider } from "./social-scheduler";

export type ContentMediaImportMessage = {
  kind: "content_media_import";
  id: string;
  userId: string;
  leaseId: string;
};

export async function processDueCreatorMediaRankRefreshes() {
  const { error } = await (supabaseAdmin as any).rpc("process_due_creator_media_rank_refreshes", {
    p_limit: 3,
  });
  if (error) throw new Error("Media rankings could not be refreshed.");
}

export function importedMediaType(bytes: Uint8Array, declared: string) {
  if (declared === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8)
    return { mimeType: declared, extension: "jpg" };
  if (
    declared === "image/png" &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return { mimeType: declared, extension: "png" };
  const text = (from: number, until: number) => String.fromCharCode(...bytes.slice(from, until));
  if (declared === "image/webp" && text(0, 4) === "RIFF" && text(8, 12) === "WEBP")
    return { mimeType: declared, extension: "webp" };
  if (declared === "image/gif" && ["GIF87a", "GIF89a"].includes(text(0, 6)))
    return { mimeType: declared, extension: "gif" };
  if (declared === "image/avif" && text(4, 8) === "ftyp" && /avif|avis/.test(text(8, 32)))
    return { mimeType: declared, extension: "avif" };
  if (declared === "video/mp4" && text(4, 8) === "ftyp")
    return { mimeType: declared, extension: "mp4" };
  if (
    declared === "video/webm" &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  )
    return { mimeType: declared, extension: "webm" };
  return null;
}

export async function downloadConnectedMedia(
  provider: SocialProvider,
  value: string,
  maxBytes: number,
  fetcher: typeof fetch = fetch,
) {
  let url =
    parsePublicHttpUrl(value, { requireHttps: true }) && allowedSocialAssetUrl(provider, value);
  for (let redirects = 0; url && redirects <= 2; redirects += 1) {
    const response = await fetcher(url.toString(), {
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      const next = location ? new URL(location, url).toString() : "";
      url =
        parsePublicHttpUrl(next, { requireHttps: true }) && allowedSocialAssetUrl(provider, next);
      continue;
    }
    if (!response.ok)
      throw new ProviderError(
        "This source media is unavailable. Refresh or reconnect its account.",
        "media_unavailable",
        response.status === 429 || response.status >= 500,
        response.status,
      );
    const bytes = await readResponseBytes(response, maxBytes);
    const type = importedMediaType(
      bytes,
      (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase(),
    );
    if (!type) throw new Error("The provider did not return a supported image or video.");
    return { bytes, ...type };
  }
  throw new Error("This media URL is not an approved provider asset.");
}

async function linkedInAssetUrl(connection: any, assetId: string) {
  if (!/^urn:li:(image|video):[a-zA-Z0-9_-]+$/.test(assetId))
    throw new Error("This LinkedIn media reference is invalid.");
  const response = await fetch(
    `https://api.linkedin.com/rest/${assetId.includes(":video:") ? "videos" : "images"}/${encodeURIComponent(assetId)}`,
    {
      headers: {
        Authorization: `Bearer ${await accessTokenForConnection(connection)}`,
        "LinkedIn-Version": process.env.LINKEDIN_API_VERSION || "202606",
        "X-Restli-Protocol-Version": "2.0.0",
      },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) throw new Error("This LinkedIn connection cannot read the original media.");
  const value = JSON.parse(await readResponseText(response, 128 * 1024));
  if (typeof value.downloadUrl !== "string")
    throw new Error("LinkedIn has not provided a downloadable asset.");
  return value.downloadUrl as string;
}

export async function enqueueDueContentMediaImports(
  queue?: Queue<ContentMediaImportMessage>,
  limit = 100,
) {
  if (!queue) return { queued: 0 };
  const db = supabaseAdmin as any;
  const { data: claimed, error } = await db.rpc("claim_creator_media_imports", {
    p_limit: limit,
  });
  if (error) throw new Error("Media imports could not be claimed.");
  if (!claimed?.length) return { queued: 0 };
  const messages: ContentMediaImportMessage[] = claimed.map((row: any) => ({
    kind: "content_media_import",
    id: row.id,
    userId: row.user_id,
    leaseId: row.lease_id,
  }));
  try {
    await queue.sendBatch(messages.map((body) => ({ body, contentType: "json" as const })));
  } catch (cause) {
    const released = await db
      .from("creator_content_media")
      .update({ lease_id: null, lease_expires_at: null })
      .in(
        "id",
        messages.map((message) => message.id),
      );
    if (released.error) throw new Error("Failed media queue leases could not be released.");
    throw cause;
  }
  return { queued: messages.length };
}

export async function processContentMediaImportMessage(message: ContentMediaImportMessage) {
  const userId = message.userId;
  const db = supabaseAdmin as any;
  const { data: row, error } = await db
    .from("creator_content_media")
    .select("*")
    .eq("user_id", userId)
    .eq("id", message.id)
    .eq("lease_id", message.leaseId)
    .eq("status", "pending")
    .maybeSingle();
  if (error) throw new Error("Claimed media could not be loaded.");
  if (!row || !["automatic", "requested"].includes(row.import_origin)) return { processed: 0 };
  const bucket = getMediaBucket();
  const plan = await getPlan(userId);
  const allowance = (await getStorageAllowanceMb(userId)) * 1024 * 1024;
  const [used, brainUsage] = await Promise.all([
    cachedR2UserStorageBytes(bucket, userId, sumR2UserStorageBytes),
    db.rpc("creator_brain_media_used_bytes", { p_user_id: userId }),
  ]);
  if (brainUsage.error) throw new Error("Media library usage could not be checked.");
  let processed = 0;
  let outcome: Record<string, unknown>;
  try {
    let url = row.remote_url;
    if (!url && row.provider === "linkedin") {
      const connection = await db
        .from("social_connections")
        .select("*")
        .eq("id", row.connection_id)
        .eq("user_id", userId)
        .maybeSingle();
      if (connection.error || !connection.data)
        throw new Error("This connected account is unavailable.");
      url = await linkedInAssetUrl(connection.data, row.asset_id);
    }
    if (!url) throw new Error("The provider has not supplied downloadable media.");
    const allowedBytes =
      uploadLimitMb(row.media_type === "video" ? "video" : "image", plan) * 1024 * 1024;
    // Originals may be larger than the stored, resized image.
    const downloadLimit = row.media_type === "video" ? allowedBytes : 20 * 1024 * 1024;
    let media = await downloadConnectedMedia(row.provider, url, downloadLimit);
    if (media.mimeType.startsWith("image/") && media.mimeType !== "image/gif") {
      const images = globalThis.__env__?.IMAGES;
      if (!images)
        throw new ProviderError(
          "Image normalization is temporarily unavailable.",
          "image_normalization_unavailable",
          true,
          503,
        );
      let bytes: Uint8Array | null = null;
      for (const [width, quality] of [
        [1280, 80],
        [960, 70],
        [720, 65],
      ] as const) {
        await reserveProviderUsage("image_transformations", 1, { workspaceId: userId });
        const transformed = await images
          .input(new Response(media.bytes).body!)
          .transform({ width, fit: "scale-down" })
          .output({ format: "image/jpeg", quality });
        try {
          bytes = await readResponseBytes(transformed.response(), allowedBytes);
          break;
        } catch (error) {
          if (width === 720) throw error;
        }
      }
      if (!bytes) throw new Error("This image is too large for your plan.");
      if (!importedMediaType(bytes, "image/jpeg"))
        throw new Error("Image normalization did not return a valid image.");
      media = { bytes: Uint8Array.from(bytes), mimeType: "image/jpeg", extension: "jpg" };
    }
    if ((row.media_type === "video") !== media.mimeType.startsWith("video/"))
      throw new Error("This media does not match the provider's declared attachment type.");
    if (media.bytes.byteLength > allowedBytes)
      throw new Error("This media exceeds your plan's upload size limit.");
    const digest = await crypto.subtle.digest("SHA-256", media.bytes);
    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const key = `users/${userId}/content-media/${row.connection_id}/${hash}.${media.extension}`;
    const present = await bucket.head(key);
    if (!present && used + media.bytes.byteLength > allowance)
      throw new Error("Your storage is full. Free space before importing more media.");
    if (
      !present &&
      Number(brainUsage.data || 0) + media.bytes.byteLength > BRAIN_MEDIA_BUDGET_BYTES
    )
      throw new Error("Your Brain Media library has reached its 1 GB limit.");
    if (!present) {
      await bucket.put(key, media.bytes, {
        httpMetadata: {
          contentType: media.mimeType,
          cacheControl: "public, max-age=31536000, immutable",
        },
      });
      await adjustCachedR2UserStorageBytes(userId, media.bytes.byteLength).catch((error) => {
        console.error("[content-media] usage cache update failed", error);
      });
    }
    outcome = {
      status: "ready",
      storage_key: key,
      public_url: mediaObjectUrl(key),
      mime_type: media.mimeType,
      byte_size: media.bytes.byteLength,
      error_message: null,
    };
  } catch (cause) {
    const transient =
      cause instanceof ProviderError
        ? cause.retryable
        : cause instanceof TypeError ||
          (cause instanceof DOMException && ["TimeoutError", "AbortError"].includes(cause.name));
    const retry = transient && Number(row.attempts || 0) < 5;
    outcome = {
      status: retry ? "pending" : "unavailable",
      attempts: Number(row.attempts || 0) + 1,
      next_attempt_at: new Date(
        Date.now() + 30_000 * 2 ** Math.min(Number(row.attempts || 0), 6),
      ).toISOString(),
      error_message: cause instanceof Error ? cause.message.slice(0, 1000) : "Media import failed.",
    };
  }
  const saved = await db
    .from("creator_content_media")
    .update({ ...outcome, lease_id: null, lease_expires_at: null })
    .eq("id", row.id)
    .eq("user_id", userId)
    .eq("lease_id", message.leaseId)
    .eq("status", "pending");
  if (saved.error) throw new Error("Imported media status could not be recorded.");
  processed += 1;
  return { processed };
}

/** Generated output uses the same image normalization, owned namespace and storage allowance as imports. */
export async function storeGeneratedContentMedia(userId: string, key: string, input: Uint8Array) {
  if (
    !key.startsWith(`users/${userId}/content-agent-images/`) ||
    !/^users\/[a-f0-9-]+\/content-agent-images\/[a-f0-9-]+\.jpg$/.test(key)
  )
    throw new Error("Invalid generated image key.");
  const bucket = getMediaBucket();
  if (await bucket.head(key)) return key;
  const images = globalThis.__env__?.IMAGES;
  if (!images)
    throw new Error("Image storage is temporarily unavailable. Try saving the image again.");
  await reserveProviderUsage("image_transformations", 1, { workspaceId: userId });
  const transformed = await images
    .input(new Response(new Uint8Array(input)).body!)
    .output({ format: "image/jpeg", quality: 90 });
  const bytes = await readResponseBytes(transformed.response(), 8 * 1024 * 1024);
  if (!importedMediaType(bytes, "image/jpeg")) throw new Error("Invalid normalized image.");
  const allowance = (await getStorageAllowanceMb(userId)) * 1024 * 1024;
  if ((await sumR2UserStorageBytes(bucket, userId)) + bytes.byteLength > allowance)
    throw new Error(
      "Storage full. Free space to save this completed image; no new generation is needed.",
    );
  await bucket.put(key, bytes, {
    httpMetadata: {
      contentType: "image/jpeg",
      cacheControl: "public, max-age=31536000, immutable",
    },
  });
  return key;
}
