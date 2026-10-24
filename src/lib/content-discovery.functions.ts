/* eslint-disable @typescript-eslint/no-explicit-any -- Provider rows and new tables are normalized here. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { hasPlanEntitlement } from "./plan.server";
import { requireContentWorkspace } from "./content-access.server";
import {
  contentProfileFromRow,
  contentProfileSchema,
  isTrustedBrainItem,
  type BrainItem,
} from "./content-brain";
import {
  BRAIN_ITEM_COLUMNS,
  CONTENT_PROFILE_COLUMNS,
  SOCIAL_INSIGHT_COLUMNS,
} from "./large-table-columns";
import {
  discoverSourceWarnings,
  DISCOVER_BRIEF_VERSION,
  DISCOVER_PROGRESS_WARNING,
  getOrBuildTrendBrief,
  normalizeNicheKey,
  sourceMatchesDiscoverNiche,
  type TrendBrief,
} from "./content-briefs.server";
import { rankCreatorPosts, type ContentPattern, type ContentWinner } from "./content-discovery";
import {
  dedupeSourceItems,
  type ContentSourceItem,
  type ContentSourceStats,
} from "./content-sources.server";
import type { SocialContentInsight } from "./social-content-insights.server";
import { recordContentEvent } from "./content-workspace-analytics.server";
import { sourcePresentation, type ContentSourcePresentation } from "./content-source-media";
import { resolveDiscoverCreator } from "./content-discover-creator.server";
import { enforceRequestRateLimit } from "./request-security.server";
import {
  creatorMatchesSource,
  trackDiscoverCreatorSchema,
  type TrackedDiscoverCreator,
} from "./content-discover-creators";
import {
  discoverBrainTopics,
  isDiscoverSubjectTopic,
  discoverExcludedTopics,
  discoverPersonalizationSignals,
  discoverTopicMatches,
  scoreDiscoverSource,
  suggestDiscoverCreators,
  type SuggestedDiscoverCreator,
  type DiscoverInterestResearch,
} from "./content-discover-personalization";
import {
  discoverPostKey,
  uniqueDiscoverPosts,
  visibleDiscoverRecommendations,
} from "./content-discover-identity";
import { readDiscoverFollows, researchDiscoverFollows } from "./content-discover-follows.server";
import { personalizeDiscoverContext } from "./content-discover-research.server";
import {
  buildDiscoverIdeas,
  fallbackDiscoverIdeas,
  type DiscoverInspiration,
} from "./content-discover-ideas.server";
import { discoverInspirationScore, rankDiscoverRecommendations } from "./content-discover-ranking";
import { evaluateDiscoverQuality } from "./content-discover-quality";
import {
  DISCOVER_PAGE_PLATFORMS,
  initialDiscoverPagination,
  loadDiscoverSourcePage,
} from "./content-discover-pagination.server";
import { withDiscoverRefreshLease } from "./content-discover-refresh.server";

export type DiscoverRecommendation = ContentSourcePresentation & {
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
  saved?: boolean;
  /** Retained for the Saved library; not part of the current recommendation direction. */
  savedOnly?: boolean;
  relevanceScore?: number;
  platform?: string | null;
  author?: string | null;
  thumbnailUrl?: string | null;
  stats?: ContentSourceStats;
  inspiration?: DiscoverInspiration;
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
  useBrainContext?: boolean;
  insights: CreatorInsight[];
  feedbackSeeds: Array<{ title: string; summary: string }>;
  creators?: TrackedDiscoverCreator[];
  research?: DiscoverInterestResearch;
  personalizationWarnings?: string[];
};

export type CreatorDiscoverDependencies = {
  loadCreatorContext(userId: string): Promise<CreatorDiscoverContext>;
  personalizeContext?(
    userId: string,
    context: CreatorDiscoverContext,
    refresh: boolean,
  ): Promise<CreatorDiscoverContext>;
  getTrendBrief(
    input: {
      nicheKeywords: string[];
      creatorNames?: string[];
      language: string;
      region: string;
      date: string;
      forceRefresh?: boolean;
    },
    onProgress?: (brief: TrendBrief) => Promise<void>,
  ): Promise<TrendBrief>;
  getCreatorSources?: typeof researchDiscoverFollows;
  readCreators?: typeof readDiscoverFollows;
  getCachedSources?(userId: string, briefId: string): Promise<ContentSourceItem[]>;
  generateIdeas?: typeof buildDiscoverIdeas;
  saveRecommendations(
    userId: string,
    rows: RecommendationInput[],
    leaseKey?: string,
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
  directionKey?: string;
  /** Canonical source identities dismissed by this owner, including paginated sources. */
  dismissedPostKeys?: string[];
  pagination?: Record<string, { cursor: string | null; hasMore: boolean }>;
  creators?: TrackedDiscoverCreator[];
  suggestedCreators?: SuggestedDiscoverCreator[];
};

type StoredBrief = {
  nicheKey: string;
  warnings: string[];
  fetchedAt: string;
  expiresAt: string;
  language?: string;
  region?: string;
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
  const inspiration = z
    .object({
      hook: z.string(),
      format: z.string(),
      outline: z.array(z.string()),
      whyNow: z.string(),
    })
    .safeParse(metadata.inspiration);
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
    saved: metadata.saved === true || row.feedback === "saved",
    relevanceScore: numberOrNull(metadata.relevanceScore) || 0,
    platform: metadata.platform || null,
    author: metadata.author || null,
    thumbnailUrl: metadata.thumbnailUrl || null,
    stats: metadata.stats || {},
    ...(inspiration.success ? { inspiration: inspiration.data } : {}),
    ...sourcePresentation(metadata),
  };
}

export function storedDiscoverData(
  recommendations: DiscoverRecommendation[],
  brief: StoredBrief | null,
  now = new Date(),
  context?: CreatorDiscoverContext,
): ContentDiscoverData {
  const excludedTopics = context ? discoverExcludedTopics(context) : [];
  const directionNicheKey = context
    ? normalizeNicheKey(
        inferDiscoverNiche(context),
        suggestDiscoverCreators(context)
          .slice(0, 4)
          .map((creator) => creator.name),
      )
    : undefined;
  const directionKey =
    context && directionNicheKey !== undefined
      ? `${directionNicheKey}:locale:${context.profile.language}|${context.profile.region}`
      : undefined;
  const directionMismatch = Boolean(
    brief &&
    context &&
    ((brief.language !== undefined && brief.language !== context.profile.language) ||
      (brief.region !== undefined && brief.region !== context.profile.region) ||
      (directionNicheKey !== undefined && brief.nicheKey !== directionNicheKey)),
  );
  // An empty refresh has no recommendation row pointing to its new brief. A later
  // read can therefore find the prior brief again: retain only its saved library,
  // never present unrelated posts under the user's new topics or locale.
  const availableRecommendations = visibleDiscoverRecommendations(recommendations).flatMap(
    (item) => {
      const relevant =
        !context ||
        sourceMatchesDiscoverNiche(item, inferDiscoverNiche(context)) ||
        context.creators?.some((creator) => creatorMatchesSource(creator, item));
      if (relevant && evaluateDiscoverQuality(item, now.getTime()).eligible) return [item];
      return item.saved || item.feedback === "saved" ? [{ ...item, savedOnly: true }] : [];
    },
  );
  const currentRecommendations = directionMismatch
    ? availableRecommendations
        .filter((item) => item.saved || item.feedback === "saved")
        .map((item) => ({ ...item, savedOnly: true }))
    : availableRecommendations;
  const visible = rankDiscoverRecommendations(
    currentRecommendations.filter(
      (item) =>
        item.savedOnly ||
        !excludedTopics.some((topic) =>
          discoverTopicMatches(`${item.title} ${item.summary}`, topic),
        ),
    ),
    now.getTime(),
  );
  return {
    winners: [],
    patterns: [],
    trends: uniqueDiscoverPosts(visible.filter((item) => item.kind === "trend")),
    ideas: uniqueDiscoverPosts(visible.filter((item) => item.kind === "idea")),
    dismissedPostKeys: [
      ...new Set(
        recommendations.filter((item) => item.feedback === "not_relevant").map(discoverPostKey),
      ),
    ],
    warnings: [
      ...discoverSourceWarnings(brief?.warnings || [], visible),
      ...(!brief || brief.warnings.includes(DISCOVER_PROGRESS_WARNING)
        ? []
        : qualityCoverageWarnings(visible, now.getTime())),
    ],
    status: !brief
      ? "missing"
      : brief.warnings.includes(DISCOVER_PROGRESS_WARNING) ||
          !brief.nicheKey.startsWith(`${DISCOVER_BRIEF_VERSION}:`) ||
          Date.parse(brief.expiresAt) <= now.getTime() ||
          directionMismatch
        ? "stale"
        : "fresh",
    lastRefreshedAt: brief?.fetchedAt || null,
    pagination: initialDiscoverPagination(
      Boolean(directionKey && inferDiscoverNiche(context!).length),
    ),
    ...(directionKey !== undefined ? { directionKey } : {}),
  };
}

export function mergeDiscoverRefresh(
  current: ContentDiscoverData | undefined,
  refreshed: ContentDiscoverData | undefined,
) {
  if (!refreshed || !Array.isArray(refreshed.trends) || !Array.isArray(refreshed.ideas))
    throw new Error("The refresh was interrupted. Your current feed is safe. Please try again.");
  if (!current) return refreshed;
  const retained = (old: DiscoverRecommendation[], fresh: DiscoverRecommendation[]) => {
    const ids = new Set(fresh.map((item) => item.id));
    return [
      ...fresh,
      ...old
        .filter((item) => (item.saved || item.feedback === "saved") && !ids.has(item.id))
        .map((item) => ({ ...item, savedOnly: true })),
    ];
  };
  return {
    ...refreshed,
    dismissedPostKeys: [
      ...new Set([...(current.dismissedPostKeys || []), ...(refreshed.dismissedPostKeys || [])]),
    ],
    trends: retained(current.trends, refreshed.trends),
    ideas: retained(current.ideas, refreshed.ideas),
  };
}

export async function readStoredDiscover(userId: string): Promise<ContentDiscoverData> {
  const db = supabaseAdmin as any;
  const [creatorContext, { data: latest, error: latestError }] = await Promise.all([
    defaultDependencies
      .loadCreatorContext(userId)
      .then((context) => personalizeDiscoverContext(userId, context, false)),
    db
      .from("creator_content_recommendations")
      .select("trend_brief_id")
      .eq("user_id", userId)
      .not("trend_brief_id", "is", null)
      .order("source_retrieved_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  const creators = creatorContext.creators || [];
  const suggestedCreators = suggestDiscoverCreators(creatorContext);
  if (latestError) throw new Error("Content recommendations could not be loaded.");
  if (!latest?.trend_brief_id)
    return {
      ...storedDiscoverData([], null, new Date(), creatorContext),
      creators,
      suggestedCreators,
    };

  const [recommendationsResult, briefResult] = await Promise.all([
    db
      .from("creator_content_recommendations")
      .select("*")
      .eq("user_id", userId)
      .or(
        `trend_brief_id.eq.${latest.trend_brief_id},feedback.eq.saved,metadata->>saved.eq.true,feedback.eq.not_relevant`,
      )
      .order("source_retrieved_at", { ascending: false }),
    db
      .from("content_trend_briefs")
      .select("niche_key,warnings,fetched_at,expires_at,language,region")
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
        language: briefResult.data.language,
        region: briefResult.data.region,
      }
    : null;
  return {
    ...storedDiscoverData(
      (recommendationsResult.data || []).map((row: any) => ({
        ...recommendationFromRow(row),
        savedOnly: row.trend_brief_id !== latest.trend_brief_id,
      })),
      brief,
      new Date(),
      creatorContext,
    ),
    creators,
    suggestedCreators,
  };
}

const defaultDependencies: CreatorDiscoverDependencies = {
  personalizeContext: personalizeDiscoverContext,
  generateIdeas: buildDiscoverIdeas,
  async getCachedSources(userId, briefId) {
    // A brief ID belongs to one niche, locale and day; this never crosses topics or workspaces.
    const { data, error } = await (supabaseAdmin as any)
      .from("creator_content_recommendations")
      .select("*")
      .eq("user_id", userId)
      .eq("trend_brief_id", briefId)
      .eq("kind", "trend")
      .neq("feedback", "not_relevant")
      .order("source_retrieved_at", { ascending: false })
      .limit(150);
    if (error) throw new Error("Recent source matches could not be loaded.");
    return (data || []).flatMap((row: any): ContentSourceItem[] => {
      const item = recommendationFromRow(row);
      return item.sourceUrl
        ? [
            {
              ...sourcePresentation(item),
              canonicalUrl: item.sourceUrl,
              title: item.title,
              summary: item.summary,
              sourceName: item.sourceName || "Web",
              platform: item.platform || undefined,
              author: item.author,
              thumbnailUrl: item.thumbnailUrl,
              stats: item.stats,
              publishedAt: item.sourcePublishedAt,
              retrievedAt: item.sourceRetrievedAt || row.created_at,
              kind: "social_search",
            },
          ]
        : [];
    });
  },
  getCreatorSources: researchDiscoverFollows,
  readCreators: readDiscoverFollows,
  async loadCreatorContext(userId) {
    const db = supabaseAdmin as any;
    const [profileResult, hasBrain] = await Promise.all([
      db
        .from("creator_content_profiles")
        .select(CONTENT_PROFILE_COLUMNS)
        .eq("user_id", userId)
        .maybeSingle(),
      hasPlanEntitlement(userId, "brain"),
    ]);
    const canUseBrain = hasBrain && profileResult.data?.discover_use_brain !== false;
    const cutoff = new Date(Date.now() - 366 * 24 * 60 * 60_000).toISOString();
    const [brainResult, insightsResult, feedbackResult] = await Promise.all([
      canUseBrain
        ? db
            .from("creator_brain_items")
            .select(BRAIN_ITEM_COLUMNS)
            .eq("user_id", userId)
            .eq("status", "confirmed")
            .order("updated_at", { ascending: false })
            .limit(100)
        : Promise.resolve({ data: [], error: null }),
      db
        .from("social_content_insights")
        .select(SOCIAL_INSIGHT_COLUMNS)
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
      useBrainContext: canUseBrain,
      brainItems: (brainResult.data || []).filter(isTrustedBrainItem).map((row: any) => ({
        id: row.id,
        kind: row.kind,
        title: row.title,
        content: row.content,
        tags: row.tags || [],
        provenance: row.provenance,
        evidenceVerification: row.evidence_verification,
        sourceUrl: row.source_url || null,
        sourceRef: row.source_ref || null,
        status: row.status,
        locked: row.locked,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      insights: (insightsResult.data || []).map(contentInsightFromRow),
      creators: await readDiscoverFollows(userId),
      feedbackSeeds: (feedbackResult.data || []).map((row: any) => ({
        title: String(row.title || ""),
        summary: String(row.summary || ""),
      })),
    };
  },
  getTrendBrief: (input, onProgress) => getOrBuildTrendBrief(input, undefined, onProgress),
  async saveRecommendations(userId, rows, leaseKey) {
    if (!rows.length) return [];
    const db = supabaseAdmin as any;
    const fingerprints = rows.map((row) => row.fingerprint);
    const { data: existingRows, error: existingError } = await db
      .from("creator_content_recommendations")
      .select("fingerprint,feedback,metadata")
      .eq("user_id", userId)
      .in("fingerprint", fingerprints);
    if (existingError) throw new Error("Content recommendations could not be loaded.");
    const feedback = new Map(
      (existingRows || []).map((row: any) => [String(row.fingerprint), row.feedback]),
    );
    const savedFingerprints = new Set(
      (existingRows || [])
        .filter((row: any) => row.feedback === "saved" || row.metadata?.saved === true)
        .map((row: any) => String(row.fingerprint)),
    );
    const payload = rows.map((row) => ({
      user_id: userId,
      fingerprint: row.fingerprint,
      kind: row.kind,
      title: [...row.title].slice(0, 300).join(""),
      summary: [...row.summary].slice(0, 5000).join(""),
      source_url: row.sourceUrl,
      source_name: row.sourceName,
      source_published_at: row.sourcePublishedAt,
      source_retrieved_at: row.sourceRetrievedAt,
      reason: row.reason,
      angles: row.angles.slice(0, 3),
      metric_name: row.metricName,
      metric_value: row.metricValue,
      outlier_score: row.outlierScore,
      metadata: {
        relevanceScore: row.relevanceScore || 0,
        saved: savedFingerprints.has(row.fingerprint),
        ...sourcePresentation(row),
        platform: row.platform || null,
        author: row.author || null,
        thumbnailUrl: row.thumbnailUrl || null,
        stats: row.stats || {},
        ...(row.inspiration ? { inspiration: row.inspiration } : {}),
      },
      content_insight_id: row.contentInsightId || null,
      trend_brief_id: row.trendBriefId || null,
      feedback: feedback.get(row.fingerprint) || row.feedback || "pending",
    }));
    const writeResult = leaseKey
      ? await db.rpc("save_discover_recommendations", {
          p_user_id: userId,
          p_lease_key: leaseKey,
          p_rows: payload,
        })
      : await db
          .from("creator_content_recommendations")
          .upsert(payload, { onConflict: "user_id,fingerprint" });
    let { error } = writeResult;
    if (leaseKey && !error && writeResult.data !== true)
      throw new Error("Discover refresh was interrupted. Retrying shortly.");
    if (
      !leaseKey &&
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
            ...sourcePresentation({
              ...candidate,
              ...Object.fromEntries(
                Object.entries(sourcePresentation(recommendation)).filter(([, value]) =>
                  Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined,
                ),
              ),
            }),
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
  const excluded = discoverExcludedTopics(context);
  const explicit = context.profile.nicheKeywords
    .map((value) => value.trim())
    .filter(
      (topic) =>
        topic &&
        isDiscoverSubjectTopic(topic) &&
        !excluded.some((unwanted) => discoverTopicMatches(topic, unwanted)),
    );
  const brainTopics = discoverBrainTopics(context);
  if (explicit.length || brainTopics.length)
    return [...new Set([...explicit, ...brainTopics])].slice(0, 10);
  const rankedCaptions = rankCreatorPosts(context.insights, 3).flatMap((item, index) =>
    Array.from({ length: index === 0 ? 3 : 1 }, () => item.caption || ""),
  );
  const text = [
    ...rankedCaptions,
    ...context.feedbackSeeds.map((item) => `${item.title} ${item.summary}`),
  ].join(" ");
  const counts = new Map<string, number>();
  for (const token of text.toLowerCase().match(/[a-z][a-z0-9+#.-]{1,}/g) || []) {
    if (NICHE_STOP_WORDS.has(token) || !isDiscoverSubjectTopic(token)) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  const inferred = [...counts]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([token]) => token)
    .slice(0, 6);
  return inferred.length
    ? inferred
    : (context.creators || []).map((creator) => creator.topics || creator.name).slice(0, 4);
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

function sourceRecommendation(
  source: ContentSourceItem,
  briefId: string,
  nicheKeywords: string[],
  creators: TrackedDiscoverCreator[] = [],
): RecommendationInput {
  const sourceText = `${source.title} ${source.summary}`.toLowerCase();
  const matchedTopic = nicheKeywords.find((topic) =>
    topic
      .toLowerCase()
      .split(/\s+/)
      .some((word) => word.length > 2 && sourceText.includes(word)),
  );
  const followed = creators.find((creator) => creatorMatchesSource(creator, source));
  const niche = followed?.topics || matchedTopic || nicheKeywords[0] || "your audience";
  const token = shortFingerprint(source.canonicalUrl);
  const metric = primaryMetric(source);
  const reason = followed
    ? `From ${followed.name}, a creator you track.${followed.topics ? ` Your focus: ${followed.topics}.` : ""}`
    : matchedTopic
      ? `Matches your topic: ${matchedTopic}.`
      : `Found while researching ${niche}.`;
  const shared = {
    sourceUrl: source.canonicalUrl,
    sourceName: source.sourceName,
    sourcePublishedAt: source.publishedAt,
    sourceRetrievedAt: source.retrievedAt,
    reason,
    relevanceScore: (followed ? 100 : 0) + (matchedTopic ? 10 : 0),
    metricName: metric.name,
    metricValue: metric.value,
    outlierScore: null,
    trendBriefId: briefId,
    platform: source.platform || source.kind,
    author: source.author || null,
    thumbnailUrl: source.thumbnailUrl || null,
    stats: source.stats || {},
    ...sourcePresentation(source),
  };
  return {
    fingerprint: `trend:${token}`,
    kind: "trend",
    title: [...source.title].slice(0, 300).join(""),
    summary: [...source.summary].slice(0, 5000).join(""),
    angles: [],
    ...shared,
  };
}

function contextualSourceRecommendations(
  sources: ContentSourceItem[],
  briefId: string,
  context: CreatorDiscoverContext,
  nicheKeywords: string[],
  now: Date,
): RecommendationInput[] {
  const creators = context.creators || [];
  const suggestedCreators = suggestDiscoverCreators(context);
  const preferredWords = new Set(
    context.feedbackSeeds
      .flatMap((seed) => `${seed.title} ${seed.summary}`.toLowerCase().match(/[a-z]{4,}/g) || [])
      .filter((word) => !NICHE_STOP_WORDS.has(word)),
  );
  const signals = discoverPersonalizationSignals(context);
  return sources.map((source) => {
    const text = `${source.title} ${source.summary}`.toLowerCase();
    const preferenceScore = Math.min(
      5,
      [...preferredWords].filter((word) => text.includes(word)).length,
    );
    const personal = scoreDiscoverSource(source, context, signals);
    const followed = creators.some((creator) => creatorMatchesSource(creator, source));
    const established = suggestedCreators.some((creator) => creatorMatchesSource(creator, source));
    const item = sourceRecommendation(source, briefId, nicheKeywords, creators);
    const relevance =
      personal.score +
      preferenceScore +
      (sourceMatchesDiscoverNiche(source, nicheKeywords) || followed ? 10 : 0);
    return {
      ...item,
      relevanceScore: discoverInspirationScore(
        source,
        relevance,
        { followed, established },
        now.getTime(),
      ),
      reason: followed ? item.reason : personal.reason || item.reason,
    };
  });
}

function qualityCoverageWarnings(
  items: Array<ContentSourceItem | DiscoverRecommendation>,
  now: number,
) {
  const platforms = new Map<string, Array<ContentSourceItem | DiscoverRecommendation>>(
    DISCOVER_PAGE_PLATFORMS.filter((platform) => platform !== "Hacker News").map((platform) => [
      platform,
      [],
    ]),
  );
  for (const item of items) {
    const platform = item.platform || item.sourceName || "Unknown";
    platforms.set(platform, [...(platforms.get(platform) || []), item]);
  }
  return [...platforms].flatMap(([platform, candidates]) =>
    candidates.some((item) => evaluateDiscoverQuality(item, now).eligible)
      ? []
      : [
          `${platform}: ${candidates.length ? "Recent matches were found, but publication, audience or engagement could not be verified at the feed minimums." : "No matching recent posts with verified engagement were available in this refresh."}`,
        ],
  );
}

export async function buildCreatorDiscover(
  userId: string,
  dependencies: CreatorDiscoverDependencies = defaultDependencies,
  now = new Date(),
  forceRefresh = false,
): Promise<ContentDiscoverData> {
  const loaded = await dependencies.loadCreatorContext(userId);
  const context = dependencies.personalizeContext
    ? await dependencies.personalizeContext(userId, loaded, false)
    : loaded;
  const nicheKeywords = inferDiscoverNiche(context);
  const suggestedCreators = suggestDiscoverCreators(context);
  const creators = context.creators || [];
  if (!nicheKeywords.length && creators.length)
    nicheKeywords.push(...creators.map((creator) => creator.topics || creator.name).slice(0, 4));
  const providerWarnings: string[] = [];
  const [brief, creatorSources] = await Promise.all([
    nicheKeywords.length
      ? dependencies.getTrendBrief(
          {
            nicheKeywords,
            creatorNames: suggestedCreators.slice(0, 4).map((creator) => creator.name),
            language: context.profile.language,
            region: context.profile.region,
            date: now.toISOString().slice(0, 10),
            forceRefresh,
          },
          async (partial) => {
            const excluded = discoverExcludedTopics(context);
            const eligible = partial.items.filter(
              (source) =>
                evaluateDiscoverQuality(source, now.getTime()).eligible &&
                sourceMatchesDiscoverNiche(source, nicheKeywords) &&
                !excluded.some((topic) =>
                  discoverTopicMatches(`${source.title} ${source.summary}`, topic),
                ),
            );
            if (eligible.length)
              await dependencies.saveRecommendations(
                userId,
                contextualSourceRecommendations(eligible, partial.id, context, nicheKeywords, now),
              );
          },
        )
      : null,
    creators.length && dependencies.getCreatorSources
      ? dependencies
          .getCreatorSources(userId, creators, context.profile)
          .catch((error: unknown) => {
            providerWarnings.push(
              `Tracked creators: ${error instanceof Error ? error.message : "Research timed out."}`,
            );
            return [];
          })
      : [],
  ]);
  const cachedSources =
    brief?.warnings.length && dependencies.getCachedSources
      ? (await dependencies.getCachedSources(userId, brief.id)).filter((source) =>
          sourceMatchesDiscoverNiche(source, nicheKeywords),
        )
      : [];
  const excludedTopics = discoverExcludedTopics(context);
  const sources = dedupeSourceItems(
    [...creatorSources, ...(brief?.items || []), ...cachedSources].filter(
      (source) =>
        evaluateDiscoverQuality(source, now.getTime()).eligible &&
        (sourceMatchesDiscoverNiche(source, nicheKeywords) ||
          creators.some((creator) => creatorMatchesSource(creator, source))) &&
        !excludedTopics.some((topic) =>
          discoverTopicMatches(`${source.title} ${source.summary}`, topic),
        ),
    ),
  );
  if (!sources.length && !brief?.items.length && brief?.warnings.length)
    throw new Error(`Research could not finish. ${brief.warnings.join(" ")} Try refreshing again.`);
  const posts = brief
    ? contextualSourceRecommendations(sources, brief.id, context, nicheKeywords, now)
    : [];
  const rankedPosts = rankDiscoverRecommendations(posts, now.getTime()).slice(0, 96);
  const sourceByUrl = new Map(sources.map((source) => [source.canonicalUrl, source]));
  const ideaSources = rankedPosts.slice(0, 8).flatMap((item) => {
    const source = sourceByUrl.get(item.sourceUrl || "");
    return source ? [source] : [];
  });
  const ideas = await (dependencies.generateIdeas || fallbackDiscoverIdeas)(
    ideaSources,
    context,
    now,
  );
  const postByUrl = new Map(posts.map((item) => [item.sourceUrl, item]));
  const candidates: RecommendationInput[] = [
    ...rankedPosts,
    ...ideas.flatMap((idea): RecommendationInput[] => {
      const original = postByUrl.get(idea.sourceUrl);
      if (!original) return [];
      return [
        {
          ...original,
          ...idea,
          fingerprint: `idea:${shortFingerprint(idea.sourceUrl)}`,
          kind: "idea",
          // An idea is a creation brief, not another post or a claim of future performance.
          metricName: null,
          metricValue: null,
          outlierScore: null,
        },
      ];
    }),
  ];
  const persisted = await dependencies.saveRecommendations(userId, candidates);
  const saved = visibleDiscoverRecommendations(persisted);
  return {
    winners: [],
    patterns: [],
    trends: rankDiscoverRecommendations(
      uniqueDiscoverPosts(
        saved.filter((item) => item.kind === "trend" && item.feedback !== "not_relevant"),
      ),
      now.getTime(),
    ),
    ideas: uniqueDiscoverPosts(
      saved.filter((item) => item.kind === "idea" && item.feedback !== "not_relevant"),
    ),
    warnings: [
      ...(context.personalizationWarnings || []),
      ...providerWarnings,
      ...discoverSourceWarnings(brief?.warnings || [], sources),
      ...(brief
        ? qualityCoverageWarnings(
            [...creatorSources, ...brief.items, ...cachedSources],
            now.getTime(),
          )
        : []),
    ],
    status: brief ? "fresh" : "needs_niche",
    dismissedPostKeys: [
      ...new Set(persisted.filter((item) => item.feedback === "not_relevant").map(discoverPostKey)),
    ],
    pagination: initialDiscoverPagination(Boolean(brief)),
    lastRefreshedAt: sources[0]?.retrievedAt || null,
    directionKey: `${normalizeNicheKey(
      nicheKeywords,
      suggestedCreators.slice(0, 4).map((creator) => creator.name),
    )}:locale:${context.profile.language}|${context.profile.region}`,
    creators: dependencies.readCreators ? await dependencies.readCreators(userId) : creators,
    suggestedCreators,
  };
}

export const loadMoreDiscoverInputSchema = z.object({
  platform: z.enum(["all", ...DISCOVER_PAGE_PLATFORMS]),
  cursor: z.string().uuid().optional(),
  directionKey: z.string().min(1).max(800),
});

export const loadMoreDiscover = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => loadMoreDiscoverInputSchema.parse(input))
  .handler(async ({ context: auth, data }) => {
    return loadMoreDiscoverForUser(auth.userId, data);
  });

export async function loadMoreDiscoverForUser(
  userId: string,
  data: z.infer<typeof loadMoreDiscoverInputSchema>,
) {
  await requireContentWorkspace(userId, "discover");
  await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "discover-page", userId);
  return withDiscoverRefreshLease(userId, async ({ assertCurrent, leaseKey }) => {
    const context = await personalizeDiscoverContext(
      userId,
      await defaultDependencies.loadCreatorContext(userId),
      false,
    );
    const nicheKeywords = inferDiscoverNiche(context);
    const creatorNames = suggestDiscoverCreators(context)
      .slice(0, 4)
      .map((creator) => creator.name);
    const nicheKey = normalizeNicheKey(nicheKeywords, creatorNames);
    const directionKey = `${nicheKey}:locale:${context.profile.language}|${context.profile.region}`;
    if (!nicheKeywords.length || directionKey !== data.directionKey)
      throw new Error("Discover interests changed. Refresh to continue.");
    const { data: brief, error } = await (supabaseAdmin as any)
      .from("content_trend_briefs")
      .select("id")
      .eq("niche_key", nicheKey)
      .eq("language", context.profile.language)
      .eq("region", context.profile.region)
      .order("brief_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error("More posts are temporarily unavailable. Please try again.");
    if (!brief) throw new Error("Refresh Discover before loading more posts.");
    const aliases: Record<string, string> = {
      twitter: "X",
      youtube: "YouTube",
      instagram: "Instagram",
      tiktok: "TikTok",
      linkedin: "LinkedIn",
      threads: "Threads",
      facebook: "Facebook",
      reddit: "Reddit",
    };
    const preferredPlatforms = Object.entries(context.profile.platformFrequencies)
      .filter(([, frequency]) => frequency > 0)
      .sort((a, b) => b[1] - a[1])
      .flatMap(([platform]) => (aliases[platform] ? [aliases[platform]] : []));
    const page = await loadDiscoverSourcePage(
      {
        ...data,
        userId: userId,
        nicheKeywords,
        creatorNames,
        language: context.profile.language,
        region: context.profile.region,
        preferredPlatforms,
      },
      { assertCurrent },
    );
    const now = new Date();
    const excluded = discoverExcludedTopics(context);
    const sources = page.items.filter(
      (item) =>
        evaluateDiscoverQuality(item, now.getTime()).eligible &&
        (sourceMatchesDiscoverNiche(item, nicheKeywords) ||
          (context.creators || []).some((creator) => creatorMatchesSource(creator, item))) &&
        !excluded.some((topic) => discoverTopicMatches(`${item.title} ${item.summary}`, topic)),
    );
    const rows = contextualSourceRecommendations(sources, brief.id, context, nicheKeywords, now);
    await assertCurrent();
    const saved = rows.length
      ? await defaultDependencies.saveRecommendations(userId, rows, leaseKey)
      : [];
    return {
      platform: data.platform,
      directionKey,
      trends: rankDiscoverRecommendations(
        uniqueDiscoverPosts(visibleDiscoverRecommendations(saved)),
        now.getTime(),
      ),
      ideas: [] as DiscoverRecommendation[],
      nextCursor: page.hasMore ? page.id : null,
      hasMore: page.hasMore,
      warnings: [...page.warnings, ...qualityCoverageWarnings(page.items, now.getTime())],
    };
  });
}

export const getContentDiscover = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireContentWorkspace(context.userId, "discover");
    return readStoredDiscover(context.userId);
  });

export const refreshContentDiscover = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z
      .object({ force: z.boolean().default(false) })
      .default({ force: false })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    return refreshContentDiscoverForUser(context.userId, data.force);
  });

export async function refreshContentDiscoverForUser(userId: string, force = false) {
  await requireContentWorkspace(userId, "discover");
  await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "discover-refresh", userId);
  return withDiscoverRefreshLease(userId, ({ assertCurrent, leaseKey }) =>
    buildCreatorDiscover(
      userId,
      {
        ...defaultDependencies,
        async saveRecommendations(ownerId, rows) {
          await assertCurrent();
          return defaultDependencies.saveRecommendations(ownerId, rows, leaseKey);
        },
      },
      new Date(),
      force,
    ),
  );
}

const recommendationIdSchema = z.object({ id: z.string().uuid() });
export const getDiscoverCreator = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input) => recommendationIdSchema.parse(input))
  .handler(async ({ context, data }) => {
    return getDiscoverCreatorForUser(context.userId, data.id);
  });
export async function getDiscoverCreatorForUser(userId: string, id: string) {
  await requireContentWorkspace(userId, "discover");
  await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "discover-creator", userId);
  const { data: row, error } = await (supabaseAdmin as any)
    .from("creator_content_recommendations")
    .select("*")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !row) throw new Error("This creator could not be loaded.");
  return resolveDiscoverCreator(recommendationFromRow(row));
}

const feedbackSchema = recommendationIdSchema.extend({
  feedback: z.enum(["pending", "liked", "saved", "not_relevant"]),
});

export const setDiscoverFeedback = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => feedbackSchema.parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId, "discover");
    const db = supabaseAdmin as any;
    const { data: current, error: readError } = await db
      .from("creator_content_recommendations")
      .select("feedback,metadata")
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (readError || !current) throw new Error("The recommendation could not be updated.");
    const savedMetadata =
      current.feedback === "saved" || current.metadata?.saved === true
        ? { metadata: { ...current.metadata, saved: true } }
        : {};
    let { data: updated, error } = await db
      .from("creator_content_recommendations")
      .update({ ...savedMetadata, feedback: data.feedback, updated_at: new Date().toISOString() })
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
    await requireContentWorkspace(context.userId, "discover");
    const db = supabaseAdmin as any;
    const { data: recommendation, error } = await db
      .from("creator_content_recommendations")
      .select("id,title,summary,source_url,metadata")
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error || !recommendation) throw new Error("The recommendation could not be saved.");
    const { error: saveError } = await db
      .from("creator_content_recommendations")
      .update({
        feedback: "saved",
        metadata: { ...recommendation.metadata, saved: true },
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (saveError)
      throw new Error("The recommendation could not be marked as saved. Please try again.");
    return { id: data.id, saved: true };
  });

/** Discover preferences are independent of the Creator Plus Brain workspace. */
export const getDiscoverPreferences = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireContentWorkspace(context.userId, "discover");
    const { data, error } = await (supabaseAdmin as any)
      .from("creator_content_profiles")
      .select(CONTENT_PROFILE_COLUMNS)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) throw new Error("Your Discover preferences could not be loaded.");
    return {
      ...(data ? contentProfileFromRow(data) : contentProfileSchema.parse({})),
      useBrainContext: data?.discover_use_brain !== false,
    };
  });
export const saveDiscoverPreferences = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        nicheKeywords: z.array(z.string().trim().min(1).max(80)).max(20),
        useBrainContext: z.boolean().default(true),
        language: z.string().trim().min(2).max(12),
        region: z.string().trim().min(2).max(80),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId, "discover");
    const { error } = await (supabaseAdmin as any).from("creator_content_profiles").upsert(
      {
        user_id: context.userId,
        niche_keywords: data.nicheKeywords,
        discover_use_brain: data.useBrainContext,
        language: data.language,
        region: data.region,
      },
      { onConflict: "user_id" },
    );
    if (error) throw new Error("Your Discover preferences could not be saved.");
    return { ok: true };
  });

export const unsaveDiscoverItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => recommendationIdSchema.parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId, "discover");
    const db = supabaseAdmin as any;
    const { data: current, error } = await db
      .from("creator_content_recommendations")
      .select("feedback,metadata")
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error || !current) throw new Error("The saved post could not be found.");
    const feedback = current.feedback === "saved" ? "pending" : current.feedback;
    const { data: updated, error: updateError } = await db
      .from("creator_content_recommendations")
      .update({
        feedback,
        metadata: { ...current.metadata, saved: false },
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .select("id")
      .maybeSingle();
    if (updateError || !updated) throw new Error("The post could not be unsaved. Try again.");
    // Brain copies may have been edited or confirmed; unsaving only removes the bookmark.
    return { id: data.id, feedback, saved: false };
  });

export const trackDiscoverCreator = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => trackDiscoverCreatorSchema.parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId, "discover");
    await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "discover-track", context.userId);
    const creators = await readDiscoverFollows(context.userId);
    if (
      creators.length >= 25 &&
      !creators.some((creator) => creator.profileUrl === data.profileUrl.profileUrl)
    )
      throw new Error("You can track up to 25 creators. Untrack one to add another.");
    const { data: row, error } = await (supabaseAdmin as any)
      .from("creator_discover_follows")
      .upsert(
        {
          user_id: context.userId,
          profile_url: data.profileUrl.profileUrl,
          platform: data.profileUrl.platform,
          name: data.name || data.profileUrl.name,
          topics: data.topics,
          active: true,
        },
        { onConflict: "user_id,profile_url" },
      )
      .select("id")
      .single();
    if (error || !row) throw new Error("This creator could not be tracked. Try again.");
    return { id: row.id };
  });

export const untrackDiscoverCreator = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => recommendationIdSchema.parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId, "discover");
    const { data: row, error } = await (supabaseAdmin as any)
      .from("creator_discover_follows")
      .update({ active: false })
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .select("id")
      .maybeSingle();
    if (error || !row) throw new Error("This creator could not be untracked. Try again.");
    return { id: data.id };
  });
