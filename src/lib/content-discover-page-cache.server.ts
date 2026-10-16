import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { ContentSourceItem } from "./content-sources.server";

const PAGE_TTL_MS = 6 * 60 * 60_000;
const CACHE_COLUMNS =
  "id,user_id,direction_key,platform,items,source_state,has_more,warnings,expires_at";
const unavailable = () =>
  new Error("Discover page cache is temporarily unavailable. Please try again.");
const scopeSchema = z.object({
  userId: z.string().uuid(),
  directionKey: z.string().min(1).max(800),
  platform: z.string().min(1).max(40),
});
const requestKeySchema = z.string().regex(/^[a-f0-9]{64}$/);
const stateSchema = z
  .object({
    platforms: z.record(
      z.string().min(1).max(40),
      z.union([z.string().max(16_384), z.null(), z.literal(false)]),
    ),
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

/** Public source data only: strip recommendations, feedback, Brain and other extra fields. */
const sourceSchema = z.object({
  canonicalUrl: z.string(),
  title: z.string(),
  summary: z.string(),
  sourceName: z.string(),
  publishedAt: z.string().nullable(),
  retrievedAt: z.string(),
  kind: z.enum(["rss", "gdelt", "hackernews", "youtube", "reddit", "social_search"]),
  platform: z.string().optional(),
  author: z.string().nullable().optional(),
  thumbnailUrl: z.string().nullable().optional(),
  authorUrl: z.string().nullable().optional(),
  authorAvatarUrl: z.string().nullable().optional(),
  mediaType: z.enum(["text", "image", "video", "carousel", "article"]).nullable().optional(),
  media: z
    .array(
      z.object({
        type: z.enum(["image", "video"]),
        url: z.string(),
        thumbnailUrl: z.string().nullable().optional(),
        width: z.number().nullable().optional(),
        height: z.number().nullable().optional(),
      }),
    )
    .optional(),
  stats: z
    .object({
      views: z.number().nullable().optional(),
      likes: z.number().nullable().optional(),
      comments: z.number().nullable().optional(),
      shares: z.number().nullable().optional(),
      saves: z.number().nullable().optional(),
      engagementRate: z.number().nullable().optional(),
      followers: z.number().nullable().optional(),
    })
    .optional(),
});
const itemsSchema = z.array(sourceSchema).max(160);
const warningsSchema = z.array(z.string().max(2_000)).max(32);
const rowSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  direction_key: z.string(),
  platform: z.string(),
  items: itemsSchema,
  source_state: stateSchema,
  has_more: z.boolean(),
  warnings: warningsSchema,
  expires_at: z.string().datetime({ offset: true }),
});

export type DiscoverPageSourceState = z.infer<typeof stateSchema>;
export type DiscoverPageCacheRow = {
  id: string;
  items: ContentSourceItem[];
  state: DiscoverPageSourceState;
  hasMore: boolean;
  warnings: string[];
  expiresAt: string;
};
type Scope = z.infer<typeof scopeSchema>;
type Request = Scope & { requestKey: string };
type Result = { data: unknown; error: unknown };
type Query = PromiseLike<Result> & {
  eq(column: string, value: string): Query;
  gt(column: string, value: string): Query;
  lte(column: string, value: string): Query;
  maybeSingle(): PromiseLike<Result>;
};
export type DiscoverPageCacheDependencies = {
  db: {
    from(table: "discover_feed_pages"): {
      select(columns: string): Query;
      delete(): Query;
      upsert(
        row: Record<string, unknown>,
        options: { onConflict: string; ignoreDuplicates: boolean },
      ): Query;
    };
  };
  now?: () => Date;
};
const defaults: DiscoverPageCacheDependencies = {
  db: supabaseAdmin as unknown as DiscoverPageCacheDependencies["db"],
};

function scoped(query: Query, input: Scope) {
  return query
    .eq("user_id", input.userId)
    .eq("direction_key", input.directionKey)
    .eq("platform", input.platform);
}

function pageFromRow(data: unknown, input: Scope, now: Date): DiscoverPageCacheRow | null {
  if (!data) return null;
  const parsed = rowSchema.safeParse(data);
  if (!parsed.success) throw unavailable();
  const row = parsed.data;
  if (
    row.user_id !== input.userId ||
    row.direction_key !== input.directionKey ||
    row.platform !== input.platform ||
    Date.parse(row.expires_at) <= now.getTime()
  )
    return null;
  return {
    id: row.id,
    items: row.items,
    state: row.source_state,
    hasMore: row.has_more,
    warnings: row.warnings,
    expiresAt: row.expires_at,
  };
}

export async function readDiscoverPage(
  input: Request,
  dependencies: DiscoverPageCacheDependencies = defaults,
) {
  const scope = scopeSchema.parse(input);
  const requestKey = requestKeySchema.parse(input.requestKey);
  const now = dependencies.now?.() || new Date();
  const { data, error } = await scoped(
    dependencies.db.from("discover_feed_pages").select(CACHE_COLUMNS),
    scope,
  )
    .eq("request_key", requestKey)
    .gt("expires_at", now.toISOString())
    .maybeSingle();
  if (error) throw unavailable();
  return pageFromRow(data, scope, now);
}

export async function readDiscoverPageCursor(
  input: Scope & { cursor: string },
  dependencies: DiscoverPageCacheDependencies = defaults,
) {
  const scope = scopeSchema.parse(input);
  const cursor = z.string().uuid().safeParse(input.cursor);
  if (!cursor.success) return null;
  const now = dependencies.now?.() || new Date();
  const { data, error } = await scoped(
    dependencies.db.from("discover_feed_pages").select(CACHE_COLUMNS),
    scope,
  )
    .eq("id", cursor.data)
    .gt("expires_at", now.toISOString())
    .maybeSingle();
  if (error) throw unavailable();
  return pageFromRow(data, scope, now);
}

export async function saveDiscoverPage(
  input: Request & {
    items: ContentSourceItem[];
    state: DiscoverPageSourceState;
    hasMore: boolean;
    warnings: string[];
  },
  dependencies: DiscoverPageCacheDependencies = defaults,
): Promise<DiscoverPageCacheRow> {
  const scope = scopeSchema.parse(input);
  const requestKey = requestKeySchema.parse(input.requestKey);
  const items = itemsSchema.parse(input.items);
  const state = stateSchema.parse(input.state);
  const warnings = warningsSchema.parse(input.warnings);
  const hasMore = z.boolean().parse(input.hasMore);
  const now = dependencies.now?.() || new Date();
  // Cursor requests have unique keys, so expire all of this owner's old pages
  // as they keep browsing. Unexpired pages remain immutable across retries.
  const removed = await dependencies.db
    .from("discover_feed_pages")
    .delete()
    .eq("user_id", scope.userId)
    .lte("expires_at", now.toISOString());
  if (removed.error) throw unavailable();
  const saved = await dependencies.db.from("discover_feed_pages").upsert(
    {
      user_id: scope.userId,
      direction_key: scope.directionKey,
      platform: scope.platform,
      request_key: requestKey,
      items,
      source_state: state,
      has_more: hasMore,
      warnings,
      expires_at: new Date(now.getTime() + PAGE_TTL_MS).toISOString(),
    },
    { onConflict: "user_id,direction_key,platform,request_key", ignoreDuplicates: true },
  );
  if (saved.error) throw unavailable();
  const page = await readDiscoverPage({ ...scope, requestKey }, dependencies);
  if (!page) throw unavailable();
  return page;
}
