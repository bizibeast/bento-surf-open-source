import { z } from "zod";
import { configuredPublicOrigin } from "./application-urls";
import {
  readResponseBytes,
  readResponseText,
  enforceRequestRateLimit,
} from "./request-security.server";
import { importedMediaType, storeGeneratedContentMedia } from "./content-media.server";
import { getMediaBucket } from "./r2-storage.server";
import { registerAgentMedia, resolveOwnedAgentMedia } from "./content-agent-media.server";

const stockUserAgent = () =>
  `BentoSurf/1.0 (${configuredPublicOrigin(process.env.VITE_PUBLIC_URL)})`;

const pexelsUrl = z
  .string()
  .url()
  .refine(
    (s) =>
      new URL(s).protocol === "https:" &&
      ["www.pexels.com", "pexels.com"].includes(new URL(s).hostname),
  );
const imageUrl = z
  .string()
  .url()
  .refine((s) => new URL(s).protocol === "https:" && new URL(s).hostname === "images.pexels.com");
const photoSchema = z.object({
  id: z.number().int().positive(),
  url: pexelsUrl,
  photographer: z.string().max(200),
  photographer_url: pexelsUrl,
  alt: z.string().max(1000).optional(),
  src: z.object({ medium: imageUrl, large2x: imageUrl }),
});
export type StockPhoto = {
  provider: "pexels" | "commons";
  id: number;
  url: string;
  photographer: string;
  photographerUrl: string;
  previewUrl: string;
  description: string;
};
export async function pexelsRequest(path: string, fetcher: typeof fetch = fetch): Promise<unknown> {
  const key = process.env.PEXELS_API_KEY?.trim();
  if (!key)
    throw new Error(
      "Stock photos are not configured yet. Upload a photo or choose from your library.",
    );
  const url = `https://api.pexels.com/v1/${path}`;
  const cache = typeof caches !== "undefined" ? await caches.open("bento-stock-photos-v1") : null;
  const cached = await cache?.match(url);
  if (cached) return JSON.parse(await readResponseText(cached, 256 * 1024));
  await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "pexels-shared", "pexels");
  const response = await fetcher(url, {
    headers: { Authorization: key },
    redirect: "manual",
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok)
    throw new Error(
      response.status === 429
        ? "Stock photo search is busy. Try later; no paid provider is used."
        : "Stock photos are temporarily unavailable.",
    );
  const text = await readResponseText(response, 256 * 1024);
  const result = JSON.parse(text);
  if (cache)
    await cache
      .put(
        url,
        new Response(text, {
          headers: { "cache-control": "public, max-age=86400", "content-type": "application/json" },
        }),
      )
      .catch(() => {});
  return result;
}
export async function searchStockPhotos(query: string, page: number): Promise<StockPhoto[]> {
  if (!process.env.PEXELS_API_KEY?.trim()) return searchCommonsPhotos(query, page);
  const result = z
    .object({ photos: z.array(photoSchema).max(12) })
    .parse(
      await pexelsRequest(`search?query=${encodeURIComponent(query)}&page=${page}&per_page=12`),
    );
  return result.photos.map((p) => ({
    provider: "pexels",
    id: p.id,
    url: p.url,
    photographer: p.photographer,
    photographerUrl: p.photographer_url,
    previewUrl: p.src.medium,
    description: p.alt || "Stock photo",
  }));
}
const commonsImageUrl = z
  .string()
  .url()
  .refine((s) => {
    const url = new URL(s);
    return (
      url.protocol === "https:" &&
      ["upload.wikimedia.org", "thumb.wikimedia.org"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === "443") &&
      url.pathname.startsWith("/wikipedia/commons/")
    );
  });
const commonsInfo = z.object({
  thumburl: commonsImageUrl,
  descriptionurl: z
    .string()
    .url()
    .refine((s) => new URL(s).hostname === "commons.wikimedia.org"),
  mime: z.enum(["image/jpeg", "image/png", "image/webp"]),
  extmetadata: z.record(z.string(), z.object({ value: z.string() })),
});
const publicDomain = (metadata: z.infer<typeof commonsInfo>["extmetadata"]) => {
  if (metadata.Restrictions?.value) return false;
  const licence = metadata.LicenseShortName?.value || "";
  // Commons can report Copyrighted=True for CC0's fallback licence. Require
  // the explicit CC0 waiver URL instead of silently dropping those photos.
  if (/^(?:CC0|CC-zero)$/i.test(licence))
    return /^https?:\/\/creativecommons\.org\/publicdomain\/zero\/1\.0\/(?:deed\.[a-z-]+)?$/i.test(
      metadata.LicenseUrl?.value || "",
    );
  return /^Public domain$/i.test(licence) && metadata.Copyrighted?.value === "False";
};
const plain = (value: string) =>
  value
    .replace(/<[^>]*>/g, "")
    .replace(/&[^;]+;/g, " ")
    .trim()
    .slice(0, 200);
async function commonsRequest(params: Record<string, string>) {
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  url.search = new URLSearchParams({
    action: "query",
    format: "json",
    prop: "imageinfo",
    iiprop: "url|extmetadata|mime",
    iiurlwidth: "1200",
    iiextmetadatafilter: "LicenseShortName|LicenseUrl|Copyrighted|Restrictions|Artist",
    ...params,
  }).toString();
  const cache = typeof caches !== "undefined" ? await caches.open("bento-commons-stock-v1") : null;
  const cached = await cache?.match(url.toString());
  if (cached) return JSON.parse(await readResponseText(cached, 256 * 1024));
  await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "commons-shared", "commons");
  const response = await fetch(url, {
    redirect: "manual",
    headers: { "User-Agent": stockUserAgent() },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error("Free stock search is temporarily busy. Try again shortly.");
  const text = await readResponseText(response, 256 * 1024);
  const result = JSON.parse(text);
  if (result.error) throw new Error("Stock search could not complete. Try a different search.");
  if (cache)
    await cache
      .put(
        url.toString(),
        new Response(text, { headers: { "cache-control": "public, max-age=86400" } }),
      )
      .catch(() => {});
  return result;
}
export async function searchCommonsPhotos(query: string, page: number): Promise<StockPhoto[]> {
  const result = await commonsRequest({
    generator: "search",
    gsrsearch: `${query} filetype:bitmap`,
    gsrnamespace: "6",
    gsrlimit: "40",
    gsroffset: String((page - 1) * 40),
  });
  return Object.values(result.query?.pages || {})
    .flatMap((value) => {
      const item = z
        .object({
          pageid: z.number().int().positive(),
          title: z.string(),
          imageinfo: z.array(z.unknown()),
        })
        .safeParse(value);
      if (!item.success) return [];
      const info = commonsInfo.safeParse(item.data.imageinfo[0]);
      if (!info.success || !publicDomain(info.data.extmetadata)) return [];
      return [
        {
          provider: "commons" as const,
          id: item.data.pageid,
          url: info.data.descriptionurl,
          photographer: plain(info.data.extmetadata.Artist?.value || "Wikimedia Commons"),
          photographerUrl: info.data.descriptionurl,
          previewUrl: info.data.thumburl,
          description: item.data.title.replace(/^File:/, ""),
        },
      ];
    })
    .slice(0, 12);
}
async function downloadStockPhoto(value: string, provider: "pexels" | "commons") {
  let url = value;
  for (let redirects = 0; redirects <= 2; redirects++) {
    (provider === "commons" ? commonsImageUrl : imageUrl).parse(url);
    const response = await fetch(url, {
      redirect: "manual",
      headers: { "User-Agent": stockUserAgent(), Accept: "image/jpeg,image/png,image/webp" },
      signal: AbortSignal.timeout(15000),
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      url = new URL(response.headers.get("location")!, url).toString();
      continue;
    }
    if (!response.ok)
      throw new Error(
        `This stock photo could not be downloaded (HTTP ${response.status}). Try another photo.`,
      );
    return response;
  }
  throw new Error("This stock photo redirected too many times. Try another photo.");
}
export async function importStockPhoto(userId: string, id: number, provider: "pexels" | "commons") {
  let photo: { id: number; downloadUrl: string; photographer: string; url: string };
  if (provider === "commons") {
    const result = await commonsRequest({ pageids: String(id) });
    const info = commonsInfo.parse(result.query?.pages?.[id]?.imageinfo?.[0]);
    if (!publicDomain(info.extmetadata))
      throw new Error("This photo's licence changed. Choose another image.");
    photo = {
      id,
      downloadUrl: info.thumburl,
      photographer: plain(info.extmetadata.Artist?.value || "Wikimedia Commons"),
      url: info.descriptionurl,
    };
  } else {
    const selected = photoSchema.parse(await pexelsRequest(`photos/${id}`));
    if (selected.id !== id) throw new Error("This stock photo is no longer available.");
    photo = { ...selected, downloadUrl: selected.src.large2x };
  }
  // A stable workspace key reuses an imported photo without a second transform.
  const digest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`${userId}:${provider}:${id}`),
      ),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  )
    .join("")
    .slice(0, 32);
  const key = `users/${userId}/content-agent-images/${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}.jpg`;
  if (!(await getMediaBucket().head(key))) {
    const response = await downloadStockPhoto(photo.downloadUrl, provider);
    const bytes = await readResponseBytes(response, 8 * 1024 * 1024);
    if (!importedMediaType(bytes, response.headers.get("content-type") || ""))
      throw new Error("This stock photo has an unsupported format.");
    await storeGeneratedContentMedia(userId, key, bytes);
  }
  const mediaId = await registerAgentMedia(userId, key, "stock", {
    messageId: null,
    cardId: `${provider}:${photo.id}`,
    revision: 0,
    slideIndex: 0,
  });
  return {
    media: (await resolveOwnedAgentMedia(userId, [mediaId]))[0],
    credit: { name: photo.photographer, url: photo.url },
  };
}
