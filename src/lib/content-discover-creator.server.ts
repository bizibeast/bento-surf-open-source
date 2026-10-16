import { enrichContentSources } from "./content-source-enrichment.server";
import { durableDiscoverAvatarUrl } from "./social-avatar.server";
import { getMediaBucket } from "./r2-storage.server";
import {
  discoverAvatarProvider,
  publicSourceUrl,
  type DiscoverCreator,
} from "./content-source-media";
import type { DiscoverRecommendation } from "./content-discovery.functions";
import type { ContentSourceItem } from "./content-sources.server";
import type { SocialProvider } from "./social-scheduler";

type Dependencies = {
  read(key: string): Promise<DiscoverCreator | null>;
  write(key: string, value: DiscoverCreator, ttl: number): Promise<void>;
  enrich: (items: ContentSourceItem[]) => Promise<Partial<ContentSourceItem>[]>;
  persistPhoto(provider: SocialProvider, creatorUrl: string, value: string): Promise<string>;
};
const defaults: Dependencies = {
  async read(key) {
    const object = await getMediaBucket().get(key);
    if (!object) return null;
    const cached = await object.json<{ expiresAt: number; value: DiscoverCreator }>();
    if (!cached?.value || !(cached.expiresAt > Date.now())) return null;
    return creatorFields(cached.value);
  },
  async write(key, value, ttl) {
    await getMediaBucket().put(key, JSON.stringify({ value, expiresAt: Date.now() + ttl }), {
      httpMetadata: { contentType: "application/json", cacheControl: "private, max-age=0" },
    });
  },
  enrich: (items) => enrichContentSources(items, { timeoutMs: 16_000 }),
  persistPhoto: durableDiscoverAvatarUrl,
};
function creatorFields(value: Partial<DiscoverCreator>): DiscoverCreator {
  return {
    author: typeof value.author === "string" ? value.author.slice(0, 160) : null,
    authorUrl: publicSourceUrl(value.authorUrl),
    authorAvatarUrl: publicSourceUrl(value.authorAvatarUrl),
  };
}

export async function resolveDiscoverCreator(
  item: DiscoverRecommendation,
  dependencies: Dependencies = defaults,
): Promise<DiscoverCreator> {
  const fallback = creatorFields(item);
  const provider = discoverAvatarProvider(item.sourceUrl);
  if (!provider || !item.sourceUrl) return fallback;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(item.sourceUrl));
  const key = `discover/creator-profiles-v2/${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}.json`;
  const cached = await dependencies.read(key).catch(() => null);
  if (cached) return cached;
  try {
    const [enriched] = await dependencies.enrich([
      {
        ...item,
        platform: item.platform || undefined,
        canonicalUrl: item.sourceUrl,
        sourceName: item.sourceName || item.platform || provider,
        publishedAt: item.sourcePublishedAt,
        retrievedAt: new Date().toISOString(),
        kind: "social_search",
      },
    ]);
    const value = creatorFields({
      ...fallback,
      ...Object.fromEntries(
        Object.entries(enriched || {}).filter(([, v]) => v !== null && v !== undefined && v !== ""),
      ),
    });
    if (value.authorAvatarUrl)
      value.authorAvatarUrl = await dependencies
        .persistPhoto(provider, value.authorUrl || item.sourceUrl, value.authorAvatarUrl)
        .catch(() => value.authorAvatarUrl!);
    // A failed lookup gets a short retry window, never the feed's day-long TTL.
    await dependencies
      .write(key, value, value.authorAvatarUrl ? 7 * 86_400_000 : 5 * 60_000)
      .catch(() => undefined);
    return value;
  } catch {
    return fallback;
  }
}
