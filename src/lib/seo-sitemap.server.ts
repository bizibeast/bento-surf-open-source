import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { configuredPublicOrigin, publicProductUrl, publicProfileUrl } from "./application-urls";
import { commerceEntitlement, normalizePlan, planHasEntitlement } from "./plans";

// ponytail: 1k keeps XML generation inside Workers Free's 10 ms CPU budget.
export const SITEMAP_SHARD_SIZE = 1_000;

const MIN_PROFILE_COPY_LENGTH = 20;
const MIN_PRODUCT_TITLE_LENGTH = 3;
const MIN_PRODUCT_DESCRIPTION_LENGTH = 20;

export type SitemapEntry = { loc: string; lastmod?: string };
export type SitemapManifest = { profiles: number; products: number };
export type SitemapShardKind = keyof SitemapManifest;
export type SitemapShard = { kind: SitemapShardKind; shard: number };
export type SitemapClient = Pick<typeof supabaseAdmin, "from">;

export type SitemapProfile = {
  id: string;
  username: string;
  display_name: string | null;
  bio: string | null;
  meta_description: string | null;
  avatar_url: string | null;
  updated_at: string;
  onboarded: boolean;
  noindex: boolean;
  plan_id: string;
  is_pro: boolean;
  has_public_content: boolean;
};

export type SitemapProduct = {
  id: string;
  creator_id: string;
  creator_username: string;
  creator_onboarded: boolean;
  creator_noindex: boolean;
  creator_plan_id: string;
  creator_is_pro: boolean;
  public_slug: string;
  title: string;
  description: string;
  kind: string;
  status: string;
  noindex: boolean;
  updated_at: string;
};

function normalizedLastmod(value: unknown) {
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function meaningfulText(value: unknown, minimum: number) {
  return typeof value === "string" && value.trim().length >= minimum;
}

export function isIndexableSitemapProfile(profile: SitemapProfile) {
  return (
    profile.onboarded === true &&
    profile.noindex === false &&
    meaningfulText(profile.username, 1) &&
    meaningfulText(profile.display_name, 1) &&
    (meaningfulText(profile.bio, MIN_PROFILE_COPY_LENGTH) ||
      meaningfulText(profile.meta_description, MIN_PROFILE_COPY_LENGTH) ||
      profile.has_public_content === true)
  );
}

export function isIndexableSitemapProduct(product: SitemapProduct) {
  return Boolean(
    product.creator_onboarded === true &&
    product.creator_noindex === false &&
    meaningfulText(product.creator_username, 1) &&
    product.status === "published" &&
    product.noindex === false &&
    meaningfulText(product.public_slug, 1) &&
    meaningfulText(product.title, MIN_PRODUCT_TITLE_LENGTH) &&
    meaningfulText(product.description, MIN_PRODUCT_DESCRIPTION_LENGTH) &&
    planHasEntitlement(
      normalizePlan(product.creator_plan_id, product.creator_is_pro),
      commerceEntitlement(product.kind),
    ),
  );
}

export function profileSitemapEntries(
  profiles: SitemapProfile[],
  baseUrl?: string,
): SitemapEntry[] {
  return profiles.filter(isIndexableSitemapProfile).map((profile) => ({
    loc: publicProfileUrl(profile.username, null, baseUrl),
    ...(normalizedLastmod(profile.updated_at)
      ? { lastmod: normalizedLastmod(profile.updated_at) }
      : {}),
  }));
}

export function productSitemapEntries(
  products: SitemapProduct[],
  baseUrl?: string,
): SitemapEntry[] {
  return products.filter(isIndexableSitemapProduct).map((product) => {
    const lastmod = normalizedLastmod(product.updated_at);
    return {
      loc: publicProductUrl(product.creator_username, product.public_slug, baseUrl),
      ...(lastmod ? { lastmod } : {}),
    };
  });
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function publicOrigin(baseUrl?: string) {
  return configuredPublicOrigin(baseUrl);
}

export function renderSitemapUrlSet(entries: SitemapEntry[]) {
  const unique = new Map<string, SitemapEntry>();
  for (const entry of entries) {
    const previous = unique.get(entry.loc);
    if (!previous || (!previous.lastmod && entry.lastmod) || entry.lastmod! > previous.lastmod!) {
      unique.set(entry.loc, entry);
    }
  }
  const urls = [...unique.values()]
    .slice(0, SITEMAP_SHARD_SIZE)
    .map(
      (entry) =>
        `  <url>\n    <loc>${escapeXml(entry.loc)}</loc>${entry.lastmod ? `\n    <lastmod>${escapeXml(entry.lastmod)}</lastmod>` : ""}\n  </url>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls ? `\n${urls}\n` : ""}</urlset>\n`;
}

function shardCount(count: number) {
  return Math.ceil(Math.max(0, count) / SITEMAP_SHARD_SIZE);
}

export function renderSitemapIndex(manifest: SitemapManifest, baseUrl?: string) {
  const origin = publicOrigin(baseUrl);
  const locations: string[] = [];
  for (const kind of ["profiles", "products"] as const) {
    for (let shard = 1; shard <= shardCount(manifest[kind]); shard += 1) {
      locations.push(`${origin}/sitemaps/${kind}-${String(shard).padStart(4, "0")}.xml`);
    }
  }
  const sitemaps = locations
    .map((location) => `  <sitemap>\n    <loc>${escapeXml(location)}</loc>\n  </sitemap>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemaps}\n</sitemapindex>\n`;
}

export function parseSitemapShardPath(pathname: string): SitemapShard | null {
  const match = pathname.match(/^\/sitemaps\/(profiles|products)-(\d{4,})\.xml$/);
  if (!match) return null;
  const shard = Number(match[2]);
  if (!Number.isSafeInteger(shard) || shard < 1) return null;
  return { kind: match[1] as SitemapShardKind, shard };
}

function queryError(error: { message?: string } | null) {
  if (error) throw new Error(error.message || "Sitemap database query failed.");
}

function exactCount(value: number | null, label: string) {
  if (!Number.isSafeInteger(value) || value! < 0) {
    throw new Error(`Sitemap ${label} count unavailable.`);
  }
  return value!;
}

export async function loadSitemapManifest(
  client: SitemapClient = supabaseAdmin,
): Promise<SitemapManifest> {
  const [profiles, products] = await Promise.all([
    client.from("sitemap_profiles").select("id", { count: "exact", head: true }),
    client.from("sitemap_products").select("id", { count: "exact", head: true }),
  ]);
  queryError(profiles.error);
  queryError(products.error);
  return {
    profiles: exactCount(profiles.count, "profile"),
    products: exactCount(products.count, "product"),
  };
}

function shardRange(shard: number) {
  if (!Number.isSafeInteger(shard) || shard < 1) throw new RangeError("Invalid sitemap shard.");
  const from = (shard - 1) * SITEMAP_SHARD_SIZE;
  return [from, from + SITEMAP_SHARD_SIZE - 1] as const;
}

async function loadProfileRows(
  client: SitemapClient,
  from: number,
  to: number,
): Promise<SitemapProfile[]> {
  const { data, error } = await client
    .from("sitemap_profiles")
    .select(
      "id,username,display_name,bio,meta_description,avatar_url,updated_at,onboarded,noindex,plan_id,is_pro,has_public_content",
    )
    .order("id", { ascending: true })
    .range(from, to);
  queryError(error);
  return (Array.isArray(data) ? data : []) as SitemapProfile[];
}

async function loadProductRows(
  client: SitemapClient,
  from: number,
  to: number,
): Promise<SitemapProduct[]> {
  const { data, error } = await client
    .from("sitemap_products")
    .select(
      "id,creator_id,creator_username,creator_onboarded,creator_noindex,creator_plan_id,creator_is_pro,public_slug,title,description,kind,status,noindex,updated_at",
    )
    .order("id", { ascending: true })
    .range(from, to);
  queryError(error);
  return (Array.isArray(data) ? data : []) as SitemapProduct[];
}

export async function loadSitemapShard(
  kind: SitemapShardKind,
  shard: number,
  client: SitemapClient = supabaseAdmin,
  baseUrl?: string,
) {
  const [from, to] = shardRange(shard);
  if (kind === "profiles") {
    return profileSitemapEntries(await loadProfileRows(client, from, to), baseUrl);
  }
  if (kind !== "products") throw new RangeError("Invalid sitemap shard kind.");
  return productSitemapEntries(await loadProductRows(client, from, to), baseUrl);
}
