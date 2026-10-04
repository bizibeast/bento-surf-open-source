/* eslint-disable @typescript-eslint/no-explicit-any -- Provider rows and new tables are normalized here. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireContentWorkspace } from "./content-access.server";
import { contentProfileFromRow, contentProfileSchema, type BrainItem } from "./content-brain";
import { getOrBuildTrendBrief, type TrendBrief } from "./content-briefs.server";
import { rankCreatorPosts, type ContentPattern, type ContentWinner } from "./content-discovery";
import type { ContentSourceItem, ContentSourceStats } from "./content-sources.server";
import type { SocialContentInsight } from "./social-content-insights.server";
import { recordContentEvent } from "./content-workspace-analytics.server";

export type DiscoverRecommendation = {
  id: string;
  fingerprint: string;
  kind: "winner" | "pattern" | "trend" | "idea";
  title: string;
  summary: string;
  sourceUrl: string | null;
  sourceName: string | null;
  sourcePublishedAt: string | null;
  sourceRetrievedAt: string | null;
  reason: string;
  angles: string[];
  metricName: string | null;
  metricValue: number | null;
  outlierScore: number | null;
  feedback: "pending" | "liked" | "saved" | "not_relevant";
  platform?: string | null;
  author?: string | null;
  thumbnailUrl?: string | null;
  stats?: ContentSourceStats;
};

export type RecommendationInput = Omit<DiscoverRecommendation, "id" | "feedback"> & {
  feedback?: DiscoverRecommendation["feedback"];
  contentInsightId?: string | null;
  trendBriefId?: string | null;
};

type CreatorInsight = SocialContentInsight & { id: string };

export type CreatorDiscoverContext = {
  profile: ReturnType<typeof contentProfileSchema.parse>;
  brainItems: BrainItem[];
  insights: CreatorInsight[];
  feedbackSeeds: Array<{ title: string; summary: string }>;
};

export type CreatorDiscoverDependencies = {
  loadCreatorContext(userId: string): Promise<CreatorDiscoverContext>;
  getTrendBrief(input: {
    nicheKeywords: string[];
    language: string;
    region: string;
    date: string;
  }): Promise<TrendBrief>;
  saveRecommendations(
    userId: string,
    rows: RecommendationInput[],
  ): Promise<DiscoverRecommendation[]>;
};

export type ContentDiscoverData = {
  winners: ContentWinner[];
  patterns: ContentPattern[];
  trends: DiscoverRecommendation[];
  ideas: DiscoverRecommendation[];
  warnings: string[];
  status: "fresh" | "stale" | "missing" | "needs_niche";
  lastRefreshedAt: string | null;
};

type StoredBrief = {
  nicheKey: string;
  warnings: string[];
  fetchedAt: string;
  expiresAt: string;
};

function numberOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function contentInsightFromRow(row: any): CreatorInsight {
  return {
    id: String(row.id),
    connectionId: String(row.connection_id),
    provider: row.provider,
    remotePostId: String(row.remote_post_id),
    remotePostUrl: row.remote_post_url || null,
    contentType: row.content_type,
    caption: row.caption || null,
    thumbnailUrl: row.thumbnail_url || null,
    publishedAt: row.published_at,
    views: numberOrNull(row.views),
    impressions: numberOrNull(row.impressions),
    reach: numberOrNull(row.reach),
    engagements: numberOrNull(row.engagements),
    likes: numberOrNull(row.likes),
    comments: numberOrNull(row.comments),
    shares: numberOrNull(row.shares),
    saves: numberOrNull(row.saves),
    fetchedAt: row.fetched_at,
  };
}

function shortFingerprint(value: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return Math.abs(hash >>> 0).toString(36);
}

function recommendationFromRow(row: any): DiscoverRecommendation {
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  return {
    id: String(row.id),
    fingerprint: String(row.fingerprint),
    kind: row.kind,
    title: String(row.title),
    summary: String(row.summary || ""),
    sourceUrl: row.source_url || null,
    sourceName: row.source_name || null,
    sourcePublishedAt: row.source_published_at || null,
    sourceRetrievedAt: row.source_retrieved_at || null,
    reason: String(row.reason || ""),
    angles: Array.isArray(row.angles) ? row.angles.map(String).slice(0, 3) : [],
    metricName: row.metric_name || null,
    metricValue: numberOrNull(row.metric_value),
    outlierScore: numberOrNull(row.outlier_score),
    feedback: row.feedback,
    platform: metadata.platform || null,
    author: metadata.author || null,
    thumbnailUrl: metadata.thumbnailUrl || null,
    stats: metadata.stats || {},
  };
}

export function storedDiscoverData(
  recommendations: DiscoverRecommendation[],
  brief: StoredBrief | null,
  now = new Date(),
): ContentDiscoverData {
  const visible = recommendations.filter((item) => item.feedback !== "not_relevant");
  return {
    winners: [],
    patterns: [],
    trends: visible.filter((item) => item.kind === "trend"),
    ideas: visible.filter((item) => item.kind === "idea"),
    warnings: brief?.warnings || [],
    status: !brief
      ? "missing"
      : !brief.nicheKey.startsWith("social-v5:") || Date.parse(brief.expiresAt) <= now.getTime()
        ? "stale"
        : "fresh",
    lastRefreshedAt: brief?.fetchedAt || null,
  };
}

export function mergeDiscoverRefresh(
  current: ContentDiscoverData | undefined,
  refreshed: ContentDiscoverData,
) {
  const refreshedCount = refreshed.trends.length + refreshed.ideas.length;
  const currentCount = (current?.trends.length || 0) + (current?.ideas.length || 0);
  return refreshedCount || !currentCount
    ? refreshed
    : { ...refreshed, trends: current!.trends, ideas: current!.ideas };
}

async function readStoredDiscover(userId: string): Promise<ContentDiscoverData> {
  const db = supabaseAdmin as any;
  const { data: latest, error: latestError } = await db
    .from("creator_content_recommendations")
    .select("trend_brief_id")
    .eq("user_id", userId)
    .not("trend_brief_id", "is", null)
    .order("source_retrieved_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestError) throw new Error("Content recommendations could not be loaded.");
  if (!latest?.trend_brief_id) return storedDiscoverData([], null);

  const [recommendationsResult, briefResult] = await Promise.all([
    db
      .from("creator_content_recommendations")
      .select("*")
      .eq("user_id", userId)
      .eq("trend_brief_id", latest.trend_brief_id),
    db
      .from("content_trend_briefs")
      .select("niche_key,warnings,fetched_at,expires_at")
      .eq("id", latest.trend_brief_id)
      .maybeSingle(),
  ]);
  if (recommendationsResult.error || briefResult.error) {
    throw new Error("Content recommendations could not be loaded.");
  }
  const brief = briefResult.data
    ? {
        nicheKey: briefResult.data.niche_key,
        warnings: briefResult.data.warnings || [],
        fetchedAt: briefResult.data.fetched_at,
        expiresAt: briefResult.data.expires_at,
      }
    : null;
  return storedDiscoverData((recommendationsResult.data || []).map(recommendationFromRow), brief);
}

const defaultDependencies: CreatorDiscoverDependencies = {
  async loadCreatorContext(userId) {
    const db = supabaseAdmin as any;
    const cutoff = new Date(Date.now() - 366 * 24 * 60 * 60_000).toISOString();
    const [profileResult, brainResult, insightsResult, feedbackResult] = await Promise.all([
      db.from("creator_content_profiles").select("*").eq("user_id", userId).maybeSingle(),
      db
        .from("creator_brain_items")
        .select("*")
        .eq("user_id", userId)
        .eq("status", "confirmed")
        .order("updated_at", { ascending: false })
        .limit(100),
      db
        .from("social_content_insights")
        .select("*")
        .eq("user_id", userId)
        .gte("published_at", cutoff)
        .order("published_at", { ascending: false })
        .limit(1_000),
      db
        .from("creator_content_recommendations")
        .select("title,summary")
        .eq("user_id", userId)
        .in("feedback", ["saved", "liked"])
        .order("updated_at", { ascending: false })
        .limit(50),
    ]);
    if (profileResult.error || brainResult.error || insightsResult.error || feedbackResult.error) {
      throw new Error("Content recommendations could not be loaded.");
    }
    return {
      profile: profileResult.data
        ? contentProfileFromRow(profileResult.data)
        : contentProfileSchema.parse({}),
      brainItems: (brainResult.data || []).map((row: any) => ({
        id: row.id,
        kind: row.kind,
        title: row.title,
        content: row.content,
        provenance: row.provenance,
        sourceUrl: row.source_url || null,
        sourceRef: row.source_ref || null,
        status: row.status,
        locked: row.locked,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      insights: (insightsResult.data || []).map(contentInsightFromRow),
      feedbackSeeds: (feedbackResult.data || []).map((row: any) => ({
        title: String(row.title || ""),
        summary: String(row.summary || ""),
      })),
    };
  },
  getTrendBrief: getOrBuildTrendBrief,
  async saveRecommendations(userId, rows) {
    if (!rows.length) return [];
    const db = supabaseAdmin as any;
    const fingerprints = rows.map((row) => row.fingerprint);
    const { data: existingRows, error: existingError } = await db
      .from("creator_content_recommendations")
      .select("fingerprint,feedback")
      .eq("user_id", userId)
      .in("fingerprint", fingerprints);
    if (existingError) throw new Error("Content recommendations could not be loaded.");
    const feedback = new Map(
      (existingRows || []).map((row: any) => [String(row.fingerprint), row.feedback]),
    );
    const payload = rows.map((row) => ({
      user_id: userId,
      fingerprint: row.fingerprint,
      kind: row.kind,
      title: row.title,
      summary: row.summary,
      source_url: row.sourceUrl,
      source_name: row.sourceName,
      source_published_at: row.sourcePublishedAt,
      source_retrieved_at: row.sourceRetrievedAt,
      reason: row.reason,
      angles: row.angles,
      metric_name: row.metricName,
      metric_value: row.metricValue,
      outlier_score: row.outlierScore,
      metadata: {
        platform: row.platform || null,
        author: row.author || null,
        thumbnailUrl: row.thumbnailUrl || null,
        stats: row.stats || {},
      },
      content_insight_id: row.contentInsightId || null,
      trend_brief_id: row.trendBriefId || null,
      feedback: feedback.get(row.fingerprint) || row.feedback || "pending",
    }));
    let { error } = await db
      .from("creator_content_recommendations")
      .upsert(payload, { onConflict: "user_id,fingerprint" });
    if (
      error &&
      String(error.message || "")
        .toLowerCase()
        .includes("metadata")
    ) {
      const legacyPayload = payload.map(({ metadata: _metadata, ...row }) => row);
      ({ error } = await db
        .from("creator_content_recommendations")
        .upsert(legacyPayload, { onConflict: "user_id,fingerprint" }));
    }
    if (error) throw new Error("Content recommendations could not be saved.");
    const { data, error: readError } = await db
      .from("creator_content_recommendations")
      .select("*")
      .eq("user_id", userId)
      .in(
        "fingerprint",
        rows.map((row) => row.fingerprint),
      );
    if (readError) throw new Error("Content recommendations could not be loaded.");
    const candidates = new Map(rows.map((row) => [row.fingerprint, row]));
    return (data || []).map((row: any) => {
      const recommendation = recommendationFromRow(row);
      const candidate = candidates.get(recommendation.fingerprint);
      return candidate
        ? {
            ...recommendation,
            platform: recommendation.platform || candidate.platform || null,
            author: recommendation.author || candidate.author || null,
            thumbnailUrl: recommendation.thumbnailUrl || candidate.thumbnailUrl || null,
            stats: Object.keys(recommendation.stats || {}).length
              ? recommendation.stats
              : candidate.stats || {},
          }
        : recommendation;
    });
  },
};

const NICHE_STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "being",
  "build",
  "building",
  "but",
  "by",
  "can",
  "day",
  "do",
  "does",
  "for",
  "from",
  "have",
  "had",
  "has",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "make",
  "me",
  "more",
  "my",
  "no",
  "not",
  "now",
  "of",
  "official",
  "on",
  "or",
  "our",
  "out",
  "over",
  "post",
  "say",
  "so",
  "that",
  "than",
  "the",
  "their",
  "then",
  "they",
  "this",
  "to",
  "today",
  "up",
  "us",
  "video",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "will",
  "with",
  "you",
  "your",
]);

export function inferDiscoverNiche(context: CreatorDiscoverContext) {
  const explicit = context.profile.nicheKeywords.map((value) => value.trim()).filter(Boolean);
  const rankedCaptions = rankCreatorPosts(context.insights, 3).flatMap((item, index) =>
    Array.from({ length: index === 0 ? 3 : 1 }, () => item.caption || ""),
  );
  const text = [
    ...rankedCaptions,
    ...context.brainItems.map((item) => `${item.title} ${item.content}`),
    ...context.feedbackSeeds.map((item) => `${item.title} ${item.summary}`),
  ].join(" ");
  const counts = new Map<string, number>();
  for (const token of text.toLowerCase().match(/[a-z][a-z0-9+#.-]{1,}/g) || []) {
    if (NICHE_STOP_WORDS.has(token)) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  const inferred = [...counts]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([token]) => token)
    .slice(0, 6);
  return [...new Set([...explicit, ...inferred])].slice(0, 10);
}

function primaryMetric(source: ContentSourceItem) {
  const stats = source.stats || {};
  if (stats.views !== null && stats.views !== undefined) {
    return { name: "views" as const, value: stats.views };
  }
  const engagements =
    (stats.likes || 0) + (stats.comments || 0) + (stats.shares || 0) + (stats.saves || 0);
  return engagements > 0
    ? { name: "engagements" as const, value: engagements }
    : { name: null, value: null };
}

function sourceRecommendations(
  source: ContentSourceItem,
  briefId: string,
  nicheKeywords: string[],
): RecommendationInput[] {
  const niche = nicheKeywords[0] || "your niche";
  const token = shortFingerprint(source.canonicalUrl);
  const metric = primaryMetric(source);
  const reason = source.platform
    ? `Top ${source.platform} post relevant to ${niche}.`
    : `Current source relevant to ${niche}.`;
  const shared = {
    sourceUrl: source.canonicalUrl,
    sourceName: source.sourceName,
    sourcePublishedAt: source.publishedAt,
    sourceRetrievedAt: source.retrievedAt,
    reason,
    metricName: metric.name,
    metricValue: metric.value,
    outlierScore: null,
    trendBriefId: briefId,
    platform: source.platform || source.kind,
    author: source.author || null,
    thumbnailUrl: source.thumbnailUrl || null,
    stats: source.stats || {},
  };
  return [
    {
      fingerprint: `trend:${token}`,
      kind: "trend",
      title: source.title,
      summary: source.summary,
      angles: [],
      ...shared,
    },
    {
      fingerprint: `idea:${token}`,
      kind: "idea",
      title: `Your angle on: ${source.title}`.slice(0, 300),
      summary: source.summary,
      angles: [
        `What ${source.title} means for ${niche}`,
        `Your perspective on ${source.title}`,
        `A practical lesson creators can use from ${source.title}`,
      ].map((angle) => angle.slice(0, 500)),
      ...shared,
    },
  ];
}

export async function buildCreatorDiscover(
  userId: string,
  dependencies: CreatorDiscoverDependencies = defaultDependencies,
  now = new Date(),
): Promise<ContentDiscoverData> {
  const context = await dependencies.loadCreatorContext(userId);
  const nicheKeywords = inferDiscoverNiche(context);
  const brief = nicheKeywords.length
    ? await dependencies.getTrendBrief({
        nicheKeywords,
        language: context.profile.language,
        region: context.profile.region,
        date: now.toISOString().slice(0, 10),
      })
    : null;
  const candidates = [
    ...(brief
      ? brief.items.flatMap((source) => sourceRecommendations(source, brief.id, nicheKeywords))
      : []),
  ];
  const saved = await dependencies.saveRecommendations(userId, candidates);
  return {
    winners: [],
    patterns: [],
    trends: saved.filter((item) => item.kind === "trend" && item.feedback !== "not_relevant"),
    ideas: saved.filter((item) => item.kind === "idea" && item.feedback !== "not_relevant"),
    warnings: brief?.warnings || [],
    status: brief ? "fresh" : "needs_niche",
    lastRefreshedAt: brief?.items[0]?.retrievedAt || null,
  };
}

export const getContentDiscover = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireContentWorkspace(context.userId);
    return readStoredDiscover(context.userId);
  });

export const refreshContentDiscover = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireContentWorkspace(context.userId);
    return buildCreatorDiscover(context.userId);
  });

const recommendationIdSchema = z.object({ id: z.string().uuid() });
const feedbackSchema = recommendationIdSchema.extend({
  feedback: z.enum(["liked", "saved", "not_relevant"]),
});

export const setDiscoverFeedback = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => feedbackSchema.parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    const db = supabaseAdmin as any;
    let { data: updated, error } = await db
      .from("creator_content_recommendations")
      .update({ feedback: data.feedback, updated_at: new Date().toISOString() })
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .select("id,kind")
      .maybeSingle();
    if (error && data.feedback === "liked") {
      ({ data: updated, error } = await db
        .from("creator_content_recommendations")
        .update({ feedback: "saved", updated_at: new Date().toISOString() })
        .eq("id", data.id)
        .eq("user_id", context.userId)
        .select("id,kind")
        .maybeSingle());
    }
    if (error || !updated) throw new Error("The recommendation could not be updated.");
    void recordContentEvent(context.userId, "content_recommendation_feedback", {
      kind: updated.kind,
      feedback: data.feedback,
    });
    return { id: data.id, feedback: data.feedback };
  });

export const saveDiscoverItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => recommendationIdSchema.parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    const db = supabaseAdmin as any;
    const { data: recommendation, error } = await db
      .from("creator_content_recommendations")
      .select("id,title,summary,source_url")
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error || !recommendation) throw new Error("The recommendation could not be saved.");
    const sourceRef = `recommendation:${recommendation.id}`;
    const { data: existing, error: existingError } = await db
      .from("creator_brain_items")
      .select("id")
      .eq("user_id", context.userId)
      .eq("source_ref", sourceRef)
      .maybeSingle();
    if (existingError) throw new Error("The Brain could not be checked.");
    if (!existing) {
      const { error: insertError } = await db.from("creator_brain_items").insert({
        user_id: context.userId,
        kind: "inspiration",
        title: recommendation.title,
        content: recommendation.summary || recommendation.title,
        provenance: recommendation.source_url ? "link" : "social_post",
        source_url: recommendation.source_url,
        source_ref: sourceRef,
        status: "suggested",
      });
      if (insertError) throw new Error("The recommendation could not be added to your Brain.");
    }
    await db
      .from("creator_content_recommendations")
      .update({ feedback: "saved", updated_at: new Date().toISOString() })
      .eq("id", data.id)
      .eq("user_id", context.userId);
    return { id: data.id, saved: true };
  });
