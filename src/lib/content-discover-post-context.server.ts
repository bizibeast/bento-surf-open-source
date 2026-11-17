import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireContentWorkspace } from "./content-access.server";
import { enforceRequestRateLimit } from "./request-security.server";
import { discoverBaselineSchema, observedDiscoverMetric } from "./content-discover-baseline";
import { discoverEvidenceId, publicDiscoverEvidenceUrl } from "./content-discover-identity";
import {
  discoverPostContextInputSchema,
  analyticsPostReferenceSchema,
  type DiscoverPostContext,
  type DiscoverPostContextInput,
} from "./content-discover-post-context";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";

const evidenceFields =
  "id,kind,title,summary,source_url,source_published_at,source_retrieved_at,source_name,angles,metadata";
type Recommendation = Pick<
  Database["public"]["Tables"]["creator_content_recommendations"]["Row"],
  | "id"
  | "kind"
  | "title"
  | "summary"
  | "source_url"
  | "source_published_at"
  | "source_retrieved_at"
  | "source_name"
  | "angles"
> & { metadata: unknown };

function boundedText(value: unknown, limit: number) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function cachedDate(value: unknown) {
  const parsed = Date.parse(typeof value === "string" ? value : "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function metadataObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function storedDiscoverPostContext(
  input: DiscoverPostContextInput,
  selected: Recommendation,
  original: Recommendation | null,
): DiscoverPostContext {
  const source = selected.kind === "idea" ? original : selected;
  const metadata = metadataObject((source || selected).metadata);
  const stats = metadataObject(metadata.stats);
  const baseline = discoverBaselineSchema.safeParse(source ? metadata.performanceBaseline : null);
  const url = publicDiscoverEvidenceUrl((source || selected).source_url);
  const inspiration = metadataObject(metadataObject(selected.metadata).inspiration);
  const evidence = source || selected;

  return {
    ...input,
    version: 1,
    evidence: {
      sourceId: discoverEvidenceId(url, selected.id),
      url,
      title: boundedText(source?.title, 300) || null,
      summary: boundedText(source?.summary, 1_600) || null,
      platform: boundedText(metadata.platform, 40) || boundedText(evidence.source_name, 80) || null,
      author: boundedText(metadata.author, 160) || null,
      publishedAt: cachedDate(evidence.source_published_at),
      retrievedAt: cachedDate(evidence.source_retrieved_at),
      metrics: {
        views: observedDiscoverMetric(stats.views),
        likes: observedDiscoverMetric(stats.likes),
        comments: observedDiscoverMetric(stats.comments),
        shares: observedDiscoverMetric(stats.shares),
        saves: observedDiscoverMetric(stats.saves),
        engagementRate: observedDiscoverMetric(stats.engagementRate),
        followers: observedDiscoverMetric(stats.followers),
      },
      baseline: baseline.success ? baseline.data : null,
    },
    inspiration:
      selected.kind === "idea"
        ? {
            title: boundedText(selected.title, 300),
            summary: boundedText(selected.summary, 1_200),
            angles: Array.isArray(selected.angles)
              ? selected.angles.slice(0, 3).map((value) => boundedText(value, 300))
              : [],
            hook: boundedText(inspiration.hook, 300),
            format: boundedText(inspiration.format, 100),
            outline: Array.isArray(inspiration.outline)
              ? inspiration.outline.slice(0, 5).map((value) => boundedText(value, 300))
              : [],
            whyNow: boundedText(inspiration.whyNow, 400),
          }
        : null,
  };
}

/** Never accept source content from the caller or fetch the original URL. */
export async function loadDiscoverPostContext(
  workspaceId: string,
  value: DiscoverPostContextInput,
) {
  const input = discoverPostContextInputSchema.parse(value);
  if ("analyticsPost" in input) {
    const selected = await loadAnalyticsPostSource(workspaceId, input.analyticsPost);
    return storedDiscoverPostContext(input, selected, null);
  }
  await requireContentWorkspace(workspaceId, "discover");
  const table = () => supabaseAdmin.from("creator_content_recommendations");
  const { data: selected, error } = await table()
    .select(evidenceFields)
    .eq("user_id", workspaceId)
    .eq("id", input.recommendationId)
    .maybeSingle<Recommendation>();
  if (error || !selected) throw new Error("This Discover item could not be loaded.");

  let original: Recommendation | null = null;
  if (selected.kind === "idea" && selected.source_url) {
    const { data, error: originalError } = await table()
      .select(evidenceFields)
      .eq("user_id", workspaceId)
      .eq("source_url", selected.source_url)
      .eq("kind", "trend")
      .order("source_retrieved_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle<Recommendation>();
    if (originalError) throw new Error("The Discover source could not be loaded.");
    original = data;
  }
  return storedDiscoverPostContext(input, selected, original);
}

export async function loadAnalyticsPostSource(
  workspaceId: string,
  input: z.infer<typeof analyticsPostReferenceSchema>,
): Promise<Recommendation> {
  await requireContentWorkspace(workspaceId, "socialAnalytics");
  // These indexed analytics fields are newer than the generated client types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: row, error } = await (supabaseAdmin as any)
    .from("social_content_insights")
    .select(
      "id,provider,caption,remote_post_url,published_at,fetched_at,views,likes,comments,shares,saves",
    )
    .eq("user_id", workspaceId)
    .eq("connection_id", input.connectionId)
    .eq("remote_post_id", input.remotePostId)
    .maybeSingle();
  const parsed = z
    .object({
      id: z.uuid(),
      provider: z.string().min(1).max(40),
      caption: z.string().nullable(),
      remote_post_url: z.string().nullable(),
      published_at: z.string().nullable(),
      fetched_at: z.string().nullable(),
      views: z.number().nullable(),
      likes: z.number().nullable(),
      comments: z.number().nullable(),
      shares: z.number().nullable(),
      saves: z.number().nullable(),
    })
    .safeParse(row);
  if (error || !parsed.success) throw new Error("This analytics post could not be loaded.");
  const data = parsed.data;
  const summary = boundedText(data.caption, 1_600);
  return {
    id: data.id,
    kind: "trend",
    title: boundedText(summary.split("\n")[0], 120) || `Published ${data.provider} post`,
    summary,
    source_url: publicDiscoverEvidenceUrl(data.remote_post_url),
    source_published_at: cachedDate(data.published_at),
    source_retrieved_at: cachedDate(data.fetched_at),
    source_name: data.provider,
    angles: [],
    metadata: {
      platform: data.provider,
      stats: {
        views: data.views,
        likes: data.likes,
        comments: data.comments,
        shares: data.shares,
        saves: data.saves,
      },
    },
  };
}

export async function saveAnalyticsPostSource(
  workspaceId: string,
  input: z.infer<typeof analyticsPostReferenceSchema>,
) {
  await requireContentWorkspace(workspaceId, "discover");
  await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "analytics-research", workspaceId);
  const { id, metadata, ...snapshot } = await loadAnalyticsPostSource(workspaceId, input);
  const bookmark = {
    ...snapshot,
    user_id: workspaceId,
    fingerprint: `analytics-post:${id}`,
    content_insight_id: id,
    trend_brief_id: null,
    reason: "Saved from Analytics",
    feedback: "saved",
    metadata: { ...metadataObject(metadata), saved: true },
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabaseAdmin
    .from("creator_content_recommendations")
    .upsert(bookmark, { onConflict: "user_id,fingerprint" })
    .select("id")
    .single();
  if (error || !data) throw new Error("The post could not be saved to Discover.");
  return { id: data.id };
}
