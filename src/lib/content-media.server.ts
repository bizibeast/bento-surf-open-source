/* eslint-disable @typescript-eslint/no-explicit-any -- Ingestion rows are normalized at this boundary. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getMediaBucket, mediaObjectUrl, sumR2UserStorageBytes } from "./r2-storage.server";
import { getPlan, getStorageAllowanceMb } from "./plan.server";
import { uploadLimitMb } from "./plans";
import { readResponseBytes, readResponseText } from "./request-security.server";
import { allowedSocialAssetUrl } from "./social-avatar.server";
import { accessTokenForConnection, ProviderError } from "./social-publisher.server";
import { parsePublicHttpUrl } from "./safe-url";
import { contentMediaSources } from "./content-media";
import type { SocialProvider } from "./social-scheduler";

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

export async function indexMediaMetadata(userId: string, posts: any[]) {
  const db = supabaseAdmin as any;
  const { data: existing, error } = await db
    .from("creator_content_media")
    .select("*")
    .eq("user_id", userId);
  if (error) throw new Error("Media index could not be loaded.");
  const rows: any[] = [];
  for (const post of posts) {
    for (const media of contentMediaSources(post.media_sources)) {
      const prior = (existing || []).find(
        (row: any) =>
          row.connection_id === post.connection_id &&
          row.post_id === post.remote_post_id &&
          row.asset_id === media.id,
      );
      const unchanged =
        prior && (prior.status === "ready" || prior.remote_url === (media.url || null));
      rows.push({
        id: prior?.id || crypto.randomUUID(),
        user_id: userId,
        connection_id: post.connection_id,
        post_id: post.remote_post_id,
        asset_id: media.id,
        provider: post.provider,
        media_type: media.type,
        remote_url: media.url || null,
        source_url: parsePublicHttpUrl(post.remote_post_url, { requireHttps: true })
          ? post.remote_post_url
          : null,
        caption: String(post.caption || "").slice(0, 10_000),
        status: unchanged ? prior.status : "pending",
        updated_at: new Date().toISOString(),
      });
    }
  }
  for (let offset = 0; offset < rows.length; offset += 100) {
    const saved = await db
      .from("creator_content_media")
      .upsert(rows.slice(offset, offset + 100), { onConflict: "connection_id,post_id,asset_id" });
    if (saved.error) throw new Error("Media metadata could not be indexed.");
  }
  return rows.length;
}

export async function cachePendingContentMedia(userId: string, limit = 5) {
  const db = supabaseAdmin as any;
  const { data: rows, error } = await db
    .from("creator_content_media")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "pending")
    .lte("next_attempt_at", new Date().toISOString())
    .order("created_at")
    .limit(limit);
  if (error) throw new Error("Pending media could not be loaded.");
  if (!rows?.length) return { processed: 0 };
  const bucket = getMediaBucket();
  const plan = await getPlan(userId);
  const allowance = (await getStorageAllowanceMb(userId)) * 1024 * 1024;
  let used = await sumR2UserStorageBytes(bucket, userId);
  const connections = new Map<string, any>();
  let processed = 0;
  for (const row of rows) {
    let outcome: Record<string, unknown>;
    try {
      let url = row.remote_url;
      if (!url && row.provider === "linkedin") {
        if (!connections.has(row.connection_id)) {
          const connection = await db
            .from("social_connections")
            .select("*")
            .eq("id", row.connection_id)
            .eq("user_id", userId)
            .maybeSingle();
          if (connection.error || !connection.data)
            throw new Error("This connected account is unavailable.");
          connections.set(row.connection_id, connection.data);
        }
        url = await linkedInAssetUrl(connections.get(row.connection_id), row.asset_id);
      }
      if (!url) throw new Error("The provider has not supplied downloadable media.");
      // ponytail: buffer at most 100 MB per asset; stream larger videos if imports need that ceiling.
      const maximum =
        Math.min(100, uploadLimitMb(row.media_type === "video" ? "video" : "image", plan)) *
        1024 *
        1024;
      let media = await downloadConnectedMedia(row.provider, url, maximum);
      if (media.mimeType.startsWith("image/") && media.mimeType !== "image/gif") {
        const images = globalThis.__env__?.IMAGES;
        if (!images)
          throw new ProviderError(
            "Image normalization is temporarily unavailable.",
            "image_normalization_unavailable",
            true,
            503,
          );
        const transformed = await images
          .input(new Response(media.bytes).body!)
          .output({ format: "image/jpeg", quality: 90 });
        const bytes = await readResponseBytes(transformed.response(), maximum);
        if (!importedMediaType(bytes, "image/jpeg"))
          throw new Error("Image normalization did not return a valid image.");
        media = { bytes, mimeType: "image/jpeg", extension: "jpg" };
      }
      if ((row.media_type === "video") !== media.mimeType.startsWith("video/"))
        throw new Error("This media does not match the provider's declared attachment type.");
      if (used + media.bytes.byteLength > allowance)
        throw new Error("Your storage is full. Free space before importing more media.");
      const digest = await crypto.subtle.digest("SHA-256", media.bytes);
      const hash = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      const key = `users/${userId}/content-media/${row.connection_id}/${hash}.${media.extension}`;
      const present = await bucket.head(key);
      if (!present) {
        await bucket.put(key, media.bytes, {
          httpMetadata: {
            contentType: media.mimeType,
            cacheControl: "public, max-age=31536000, immutable",
          },
        });
        used += media.bytes.byteLength;
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
        error_message:
          cause instanceof Error ? cause.message.slice(0, 1000) : "Media import failed.",
      };
    }
    const saved = await db
      .from("creator_content_media")
      .update(outcome)
      .eq("id", row.id)
      .eq("user_id", userId)
      .eq("status", "pending");
    if (saved.error) throw new Error("Imported media status could not be recorded.");
    processed += 1;
  }
  return { processed };
}
