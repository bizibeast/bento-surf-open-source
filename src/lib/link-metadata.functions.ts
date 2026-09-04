import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isUsefulBrandColor } from "./dominant-color";
import { accentColorFromImageBytes } from "./favicon-image";
import { enforceRequestRateLimit, readResponseBytes } from "./request-security.server";
import { parsePublicHttpUrl, safeCssColor } from "./safe-url";

export type LinkMetadata = {
  url: string;
  title: string;
  favicon: string | null;
  color: string | null;
};

const MAX_HTML_BYTES = 200_000;
const MAX_FAVICON_BYTES = 256_000;
const MAX_REDIRECTS = 4;
const BOT_UA = "Mozilla/5.0 (compatible; BentoSurfBot/1.0)";

function absolutizePublic(base: string, href: string): string | null {
  try {
    return parsePublicHttpUrl(new URL(href, base).toString())?.toString() ?? null;
  } catch {
    return null;
  }
}

function pickMeta(html: string, names: string[]): string | null {
  for (const n of names) {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${n}["'][^>]*content=["']([^"']+)["']`,
      "i",
    );
    const m = html.match(re);
    if (m?.[1]) return m[1];
    const re2 = new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${n}["']`,
      "i",
    );
    const m2 = html.match(re2);
    if (m2?.[1]) return m2[1];
  }
  return null;
}

async function readBoundedHtml(response: Response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let html = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_HTML_BYTES - total;
      if (remaining <= 0) break;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      total += chunk.byteLength;
      html += decoder.decode(chunk, { stream: true });
      if (value.byteLength > remaining) break;
    }
    return html + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function fetchPublicFollowingSafeRedirects(
  initialUrl: URL,
  fetcher: typeof fetch,
  headers: Record<string, string>,
): Promise<{ response: Response; finalUrl: URL }> {
  let current = initialUrl;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await fetcher(current.toString(), {
      method: "GET",
      redirect: "manual",
      headers,
      signal: AbortSignal.timeout(6_000),
    });
    if (response.status < 300 || response.status >= 400) return { response, finalUrl: current };
    if (redirect === MAX_REDIRECTS) throw new Error("Too many redirects");
    const location = response.headers.get("location");
    if (!location) throw new Error("Invalid redirect");
    const next = parsePublicHttpUrl(new URL(location, current).toString(), {
      allowNonStandardPort: false,
    });
    if (!next) throw new Error("Unsafe redirect destination");
    current = next;
  }
  throw new Error("Too many redirects");
}

function googleFaviconUrl(hostname: string) {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=128`;
}

async function sampleFaviconAccent(favicon: string | null, fetcher: typeof fetch) {
  const url = parsePublicHttpUrl(favicon, { allowNonStandardPort: false });
  if (!url) return null;
  try {
    const { response } = await fetchPublicFollowingSafeRedirects(url, fetcher, {
      "User-Agent": BOT_UA,
      Accept: "image/png,image/x-icon,image/svg+xml,image/webp,image/*,*/*;q=0.8",
    });
    if (!response.ok) return null;
    const bytes = await readResponseBytes(response, MAX_FAVICON_BYTES);
    return await accentColorFromImageBytes(bytes);
  } catch {
    return null;
  }
}

function usefulThemeColor(html: string) {
  const color = safeCssColor(pickMeta(html, ["theme-color", "msapplication-TileColor"]));
  return color && isUsefulBrandColor(color) ? color : null;
}

export async function fetchLinkMetadataSecure(
  input: string,
  fetcher: typeof fetch = fetch,
): Promise<LinkMetadata> {
  const url = parsePublicHttpUrl(input, { allowNonStandardPort: false });
  if (!url) return { url: input, title: input, favicon: null, color: null };

  const fallbackTitle = url.hostname.replace(/^www\./, "");
  const fallbackFavicon = googleFaviconUrl(url.hostname);
  let title = fallbackTitle;
  let favicon: string | null = fallbackFavicon;
  let themeColor: string | null = null;

  try {
    const { response, finalUrl } = await fetchPublicFollowingSafeRedirects(url, fetcher, {
      "User-Agent": BOT_UA,
      Accept: "text/html,application/xhtml+xml",
    });
    if (response.ok) {
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      if (contentType.includes("text/html") || contentType.includes("application/xhtml+xml")) {
        const html = await readBoundedHtml(response);
        const ogTitle = pickMeta(html, ["og:title", "twitter:title"]);
        const titleTagMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        title = (ogTitle || titleTagMatch?.[1] || fallbackTitle).trim().slice(0, 300);

        const iconMatch = html.match(
          /<link[^>]+rel=["'](?:apple-touch-icon|icon|shortcut icon)["'][^>]*href=["']([^"']+)["']/i,
        );
        const ogImage = pickMeta(html, ["og:image", "twitter:image"]);
        favicon =
          absolutizePublic(finalUrl.toString(), iconMatch?.[1] || ogImage || "") || fallbackFavicon;
        themeColor = usefulThemeColor(html);
      }
    }
  } catch {
    // Keep Google's favicon so we can still sample a card colour.
  }

  const sampled =
    (await sampleFaviconAccent(favicon, fetcher)) ||
    (favicon === fallbackFavicon ? null : await sampleFaviconAccent(fallbackFavicon, fetcher));

  return {
    url: url.toString(),
    title,
    favicon,
    color: sampled || themeColor,
  };
}

export const fetchLinkMetadata = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ url: z.string().trim().min(1).max(2_048) }).parse(input))
  .handler(async ({ data, context }) => {
    await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "link-metadata", context.userId);
    return fetchLinkMetadataSecure(data.url);
  });
